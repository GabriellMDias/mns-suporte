import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { withMigratedDatabase } from "../../scripts/migrated-database.js";
import { createDatabase, type Database } from "../../src/database.js";
import {
  closurePollIntervalMs,
  saveClosurePreference,
} from "../../src/features/whatsapp/closure-preferences.js";
import { createClosureWorker } from "../../src/features/whatsapp/closure-worker.js";
import type { SendReply } from "../../src/features/whatsapp/graph-client.js";
import { isOutboundPayload } from "../../src/features/whatsapp/outbound-contract.js";
import { scopeOf } from "../../src/features/whatsapp/identity-code.js";
import {
  applyWhatsAppDeliveryStatuses,
  dispatchNextWhatsAppReply,
} from "../../src/features/whatsapp/outbox.js";
import { createTicketSubmissionWorker } from "../../src/features/whatsapp/ticket-submission-worker.js";

const businessPhoneId = "10001";
const requesterId = 37;
const recipient = {
  kind: "business_id",
  value: "BR.synthetic-closure",
} as const;
const scopeKey = scopeOf({
  businessPhoneId,
  senderBusinessId: recipient.value,
})!;
const signal = new AbortController().signal;
const ticketId = 781;

async function withClosureFixture(
  test: (
    db: Database,
    clock: () => Date,
    advance: (milliseconds: number) => void,
    grantId: string,
  ) => Promise<void>,
) {
  await withMigratedDatabase(async (runtimeUrl) => {
    const db = createDatabase(runtimeUrl);
    let now = Date.now();
    const clock = () => new Date(now);
    try {
      await db.whatsAppVerifiedIdentity.create({
        data: {
          scopeKey,
          glpiUserId: requesterId,
          verifiedAt: clock(),
          expiresAt: new Date(now + 7 * 86_400_000),
        },
      });
      await saveClosurePreference(
        db,
        scopeKey,
        recipient,
        { requesterId },
        clock(),
      );
      const grant = await db.whatsAppClosurePreference.findUniqueOrThrow({
        where: { scopeKey },
      });
      await test(
        db,
        clock,
        (milliseconds) => {
          now += milliseconds;
        },
        grant.grantId,
      );
    } finally {
      await db.$disconnect();
    }
  });
}

it("tracks an opted-in ticket through GLPI errors, final closure, throttling and delivery", async () => {
  await withClosureFixture(async (db, clock, advance, grantId) => {
    const draftId = randomUUID();
    await db.whatsAppTicketSubmission.create({
      data: {
        draftId,
        businessPhoneId,
        scopeKey,
        requesterId,
        closureConsentId: grantId,
        recipient,
        replyExpiresAt: new Date(clock().getTime() + 86_400_000),
        title: "Closure fixture",
        description: "Synthetic confirmed draft",
        mediaIds: [],
        attachmentCount: 0,
        availableAt: clock(),
        updatedAt: clock(),
      },
    });
    const createTicket = vi
      .fn()
      .mockResolvedValue({ kind: "created", ticketId });
    const create = createTicketSubmissionWorker(
      db,
      { businessPhoneId, supportContact: "https://ti.example.test" },
      { createTicket, attachDocument: vi.fn() },
      vi.fn(),
      clock,
    );
    expect(await create(signal)).toBe(true);
    expect(createTicket).toHaveBeenCalledTimes(1);
    const job = () =>
      db.whatsAppTicketSubmission.findUniqueOrThrow({ where: { draftId } });
    expect(await job()).toMatchObject({
      state: "COMPLETED",
      ticketId: BigInt(ticketId),
      closureCheckAt: new Date(clock().getTime() + closurePollIntervalMs),
    });

    const lookup = vi
      .fn<Parameters<typeof createClosureWorker>[2]>()
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValueOnce({
        kind: "ready",
        tickets: [{ id: ticketId, status: 5, title: "Solved" }],
      })
      .mockResolvedValue({
        kind: "ready",
        tickets: [{ id: ticketId, status: 6, title: "Closed" }],
      });
    const worker = () =>
      createClosureWorker(
        db,
        { businessPhoneId, templateConfigured: true },
        lookup,
        clock,
      );
    expect(await worker()(signal)).toBe(false);
    advance(closurePollIntervalMs);
    expect(await worker()(signal)).toBe(true);
    expect(await worker()(signal)).toBe(false);
    advance(15 * 60_000);
    expect(await worker()(signal)).toBe(true);
    expect(await db.whatsAppOutboundMessage.count()).toBe(0);
    advance(closurePollIntervalMs);
    await Promise.all([worker()(signal), worker()(signal)]);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenLastCalledWith(
      requesterId,
      { kind: "detail", ticketId },
      signal,
    );
    expect(await job()).toMatchObject({ closureCheckAt: null });
    expect(await worker()(signal)).toBe(false);

    const sent = () =>
      db.whatsAppOutboundMessage.findUniqueOrThrow({ where: { id: draftId } });
    expect(await sent()).toMatchObject({
      state: "PENDING",
      payload: {
        recipient,
        requiredGlpiUserId: requesterId,
        closure: { consentId: grantId, ticketId },
      },
    });
    const send = vi
      .fn<SendReply>()
      .mockResolvedValueOnce({
        kind: "throttled",
        code: 130429,
        retryAfterMs: 2000,
      })
      .mockResolvedValueOnce({
        kind: "accepted",
        messageId: "wamid.closure-delivery",
      });
    const dispatch = () =>
      dispatchNextWhatsAppReply(db, businessPhoneId, send, signal, clock);
    await dispatch();
    expect(await sent()).toMatchObject({ state: "PENDING", attempts: 1 });
    advance(2000);
    await dispatch();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][3]).toBeUndefined();
    await applyWhatsAppDeliveryStatuses(db, businessPhoneId, [
      {
        messageId: "wamid.closure-delivery",
        callbackId: draftId,
        state: "DELIVERED",
        occurredAt: clock(),
      },
    ]);
    expect(await sent()).toMatchObject({
      state: "DELIVERED",
      attempts: 2,
      providerMessageId: "wamid.closure-delivery",
    });
  });
}, 120_000);

it("waits for a service window without a template and suppresses queued notices after consent withdrawal", async () => {
  await withClosureFixture(async (db, clock, advance, grantId) => {
    const draftId = randomUUID();
    await db.whatsAppTicketSubmission.create({
      data: {
        draftId,
        businessPhoneId,
        scopeKey,
        requesterId,
        closureConsentId: grantId,
        ticketId,
        state: "COMPLETED",
        closureCheckAt: clock(),
        replyExpiresAt: clock(),
        mediaIds: [],
        attachmentCount: 0,
        availableAt: clock(),
        updatedAt: clock(),
      },
    });
    const lookup = vi
      .fn<Parameters<typeof createClosureWorker>[2]>()
      .mockResolvedValue({
        kind: "ready",
        tickets: [{ id: ticketId, status: 6, title: "Closed" }],
      });
    const watch = createClosureWorker(
      db,
      { businessPhoneId, templateConfigured: false },
      lookup,
      clock,
    );
    expect(await watch(signal)).toBe(true);
    expect(await db.whatsAppOutboundMessage.count()).toBe(0);
    advance(15 * 60_000);
    await db.whatsAppInboundMessage.create({
      data: {
        messageId: "wamid.closure-window",
        businessPhoneId,
        senderBusinessId: recipient.value,
        occurredAt: clock(),
        receivedAt: clock(),
        content: { type: "text", body: "Oi" },
      },
    });
    expect(await watch(signal)).toBe(true);
    expect(await db.whatsAppOutboundMessage.count()).toBe(1);
    const send = vi.fn<SendReply>().mockResolvedValue({
      kind: "throttled",
      code: 130429,
      retryAfterMs: 2000,
    });
    const dispatch = () =>
      dispatchNextWhatsAppReply(db, businessPhoneId, send, signal, clock);
    await dispatch();
    expect(send.mock.calls[0][3]).toEqual(
      new Date(clock().getTime() + 86_400_000),
    );
    await saveClosurePreference(db, scopeKey, recipient, "disable", clock());
    expect(
      await db.whatsAppClosurePreference.findUnique({ where: { scopeKey } }),
    ).toMatchObject({ recipient: null, revokedAt: clock() });
    await saveClosurePreference(
      db,
      scopeKey,
      recipient,
      { requesterId },
      clock(),
    );
    expect(
      await db.whatsAppClosurePreference.findUnique({ where: { scopeKey } }),
    ).not.toMatchObject({ grantId });
    advance(2000);
    await dispatch();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.whatsAppOutboundMessage.findUnique({ where: { id: draftId } }),
    ).toMatchObject({ state: "EXPIRED" });
  });
}, 120_000);

it("queues a public reply, status change and full solution once", async () => {
  await withClosureFixture(async (db, clock, advance, grantId) => {
    const draftId = randomUUID();
    await db.whatsAppTicketSubmission.create({
      data: {
        draftId,
        businessPhoneId,
        scopeKey,
        requesterId,
        closureConsentId: grantId,
        ticketId,
        state: "COMPLETED",
        closureCheckAt: clock(),
        replyExpiresAt: clock(),
        noticeCursor: { status: 1, followupId: 0 },
        mediaIds: [],
        attachmentCount: 0,
        availableAt: clock(),
        updatedAt: clock(),
      },
    });
    await db.whatsAppInboundMessage.create({
      data: {
        messageId: "wamid.activity-window",
        businessPhoneId,
        senderBusinessId: recipient.value,
        occurredAt: clock(),
        receivedAt: clock(),
        content: { type: "text", body: "Oi" },
      },
    });
    let status = 2;
    const ticket = () => ({
      id: ticketId,
      status,
      title: "Contrato de experiência",
    });
    const lookup = vi
      .fn<Parameters<typeof createClosureWorker>[2]>()
      .mockImplementation(() =>
        Promise.resolve({ kind: "ready", tickets: [ticket()] }),
      );
    const activity = vi.fn().mockImplementation(() =>
      Promise.resolve({
        followups: [{ id: 8, text: "Dados recebidos." }, { id: 9 }],
        ...(status === 6 ? { solution: "Relatório atualizado." } : {}),
      }),
    );
    const worker = () =>
      createClosureWorker(
        db,
        { businessPhoneId, templateConfigured: false },
        lookup,
        clock,
        activity,
      );
    await Promise.all([worker()(signal), worker()(signal)]);
    const replies = (await db.whatsAppOutboundMessage.findMany()).flatMap(
      ({ payload }) => (isOutboundPayload(payload) ? [payload] : []),
    );
    expect(
      replies.find((reply) => reply.closure?.event === "followup")?.content
        .body,
    ).toContain("Resposta da equipe de TI:\nDados recebidos.");
    expect(
      replies.find((reply) => reply.closure?.event === "status")?.content.body,
    ).toContain("Status: Em atendimento");
    for (const reply of replies)
      expect(reply.closure).toMatchObject({ consentId: grantId, ticketId });
    expect(await db.whatsAppOutboundMessage.count()).toBe(2);
    advance(closurePollIntervalMs);
    status = 6;
    expect(await worker()(signal)).toBe(true);
    expect(
      await db.whatsAppOutboundMessage.findUnique({ where: { id: draftId } }),
    ).toMatchObject({
      payload: {
        content: {
          type: "text",
          body: "Atualização do seu chamado #781\n\nStatus: Fechado\nTítulo: Contrato de experiência\n\nSolução:\nRelatório atualizado.\n\nSeu chamado foi finalizado pela equipe de TI.",
        },
      },
    });
    advance(closurePollIntervalMs);
    expect(await worker()(signal)).toBe(true);
    expect(await db.whatsAppOutboundMessage.count()).toBe(3);
    expect(
      await db.whatsAppTicketSubmission.findUnique({ where: { draftId } }),
    ).toMatchObject({
      noticeCursor: { status: 6, followupId: 9 },
    });
  });
}, 120_000);
