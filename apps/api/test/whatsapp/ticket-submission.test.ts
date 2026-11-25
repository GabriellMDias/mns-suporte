import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { withMigratedDatabase } from "../../scripts/migrated-database.js";
import { createDatabase } from "../../src/database.js";
import {
  routeConversation,
  type Conversation,
} from "../../src/features/whatsapp/conversation.js";
import {
  applyMove,
  stateFor,
} from "../../src/features/whatsapp/conversation-processor.js";
import { isOutboundPayload } from "../../src/features/whatsapp/outbound-contract.js";
import { createTicketSubmissionWorker } from "../../src/features/whatsapp/ticket-submission-worker.js";

const options = {
  businessPhoneId: "10101",
  supportContact: "ti@company.example",
};
const scopeKey = "synthetic-scope";
const actor = 37;
const signal = new AbortController().signal;

async function fixture(
  run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  await withMigratedDatabase(async (url) => {
    const database = createDatabase(url);
    try {
      await run(await setup(database));
    } finally {
      await database.$disconnect();
    }
  });
}

async function setup(database: ReturnType<typeof createDatabase>) {
  let now = Date.now();
  const clock = () => new Date(now);
  const draftId = randomUUID();
  const address = {
    scopeKey,
    recipient: { kind: "phone" as const, value: "5515000000000" },
    expiresAt: new Date(now + 60_000),
  };
  await database.whatsAppVerifiedIdentity.create({
    data: {
      scopeKey,
      glpiUserId: actor,
      verifiedAt: clock(),
      expiresAt: address.expiresAt,
    },
  });
  const draft: NonNullable<Conversation["draft"]> = {
    id: draftId,
    ownerId: actor,
    step: "review",
    revision: 1,
    editing: false,
    category: "Sistema",
    unit: "Centro",
    description: "Falha no caixa",
    impact: "Uma operação",
    attachments: [],
  };
  const job = () =>
    database.whatsAppTicketSubmission.findUniqueOrThrow({ where: { draftId } });
  const conversation = () => stateFor(database, scopeKey);
  const messages = async () =>
    (await database.whatsAppOutboundMessage.findMany()).flatMap(
      ({ payload }) =>
        isOutboundPayload(payload) ? [payload.content.body] : [],
    );
  const send = async (state: Conversation, body: string) => {
    const move = routeConversation(
      state,
      { type: "text", body },
      {
        userId: actor,
        supportContact: options.supportContact,
        draftId: randomUUID(),
        now: clock(),
      },
    );
    await database.$transaction((tx) =>
      applyMove(tx, address, options.businessPhoneId, move, clock()),
    );
  };
  const createTicket = vi
    .fn<Parameters<typeof createTicketSubmissionWorker>[2]["createTicket"]>()
    .mockResolvedValue({ kind: "created", ticketId: 801 });
  const attachDocument = vi
    .fn<Parameters<typeof createTicketSubmissionWorker>[2]["attachDocument"]>()
    .mockResolvedValue({ kind: "attached" });
  const readMedia = vi
    .fn<Parameters<typeof createTicketSubmissionWorker>[3]>()
    .mockResolvedValue({
      kind: "downloaded",
      file: new Blob(["sample"]),
      extension: "pdf",
    });
  return {
    worker: () =>
      createTicketSubmissionWorker(
        database,
        options,
        { createTicket, attachDocument },
        readMedia,
        clock,
      ),
    confirm: (mediaIds: string[] = []) =>
      send(
        {
          phase: "intake",
          draft: {
            ...draft,
            attachments: mediaIds.map((mediaId) => ({
              type: "document",
              mediaId,
            })),
          },
        },
        "Confirmar",
      ),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    createTicket,
    attachDocument,
    readMedia,
    job,
    conversation,
    messages,
    send,
  };
}

it("claims a single creation and resumes safe attachment failures without creating or uploading twice", async () => {
  await fixture(
    async ({
      confirm,
      worker,
      advance,
      createTicket,
      attachDocument,
      readMedia,
      job,
      conversation,
      messages,
    }) => {
      await confirm(["100", "200", "300"]);
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<{
        kind: "created";
        ticketId: number;
      }>();
      createTicket.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const concurrent = worker()(signal);
      try {
        await Promise.race([
          started.promise,
          concurrent.then(() => {
            throw new Error("Creation did not start");
          }),
        ]);
        expect(await worker()(signal)).toBe(false);
      } finally {
        response.resolve({ kind: "created", ticketId: 801 });
        await concurrent;
      }
      expect(await job()).toMatchObject({
        state: "PENDING",
        ticketId: 801n,
        title: null,
        description: null,
      });

      readMedia.mockResolvedValueOnce({ kind: "unavailable" });
      await worker()(signal);
      expect(attachDocument).not.toHaveBeenCalled();
      expect(await worker()(signal)).toBe(false);
      advance(2001);
      await worker()(signal);
      attachDocument.mockResolvedValueOnce({
        kind: "uncertain",
        reason: "timeout",
      });
      await worker()(signal);
      readMedia.mockResolvedValueOnce({ kind: "unsupported" });
      await worker()(signal);

      expect(createTicket).toHaveBeenCalledTimes(1);
      expect(attachDocument).toHaveBeenCalledTimes(2);
      expect(readMedia.mock.calls.map(([id]) => id)).toEqual([
        "100",
        "100",
        "200",
        "300",
      ]);
      expect(await job()).toMatchObject({
        state: "COMPLETED",
        ticketId: 801n,
        nextAttachment: 3,
        attachedCount: 1,
        uncertainAttachments: 1,
        recipient: null,
        mediaIds: [],
      });
      expect(await conversation()).toEqual({ phase: "menu" });
      expect(await messages()).toContainEqual(
        expect.stringContaining(
          "Chamado *#801* aberto no GLPI.\nAnexos incluídos: 1.\nAnexos que não puderam ser incluídos: 1.\nAnexos sem confirmação do GLPI: 1.",
        ),
      );
    },
  );
}, 120_000);

it("requires checking the external ticket after a crash at creation and never sends the old confirmation again", async () => {
  await fixture(
    async ({
      confirm,
      worker,
      advance,
      createTicket,
      job,
      conversation,
      messages,
      send,
    }) => {
      await confirm();
      createTicket.mockRejectedValueOnce(
        new Error("synthetic interruption after request"),
      );
      await expect(worker()(signal)).rejects.toThrow("synthetic interruption");
      expect(await job()).toMatchObject({ state: "PENDING", mutating: true });
      expect(await worker()(signal)).toBe(false);
      advance(45_001);
      expect(await worker()(signal)).toBe(true);
      expect(await job()).toMatchObject({
        state: "UNCERTAIN",
        ticketId: null,
        mutating: false,
      });
      const saved = await conversation();
      expect(saved.draft?.uncertainSubmission).toBe(true);
      expect(await messages()).toContainEqual(
        expect.stringContaining("informe a referência " + saved.draft?.id),
      );
      await send(saved, "Confirmar");
      expect(await worker()(signal)).toBe(false);
      expect(createTicket).toHaveBeenCalledTimes(1);
      await send(await conversation(), "Novo chamado");
      expect((await conversation()).draft?.step).toBe("category");
      expect((await conversation()).draft?.id).not.toBe(saved.draft?.id);
    },
  );
}, 120_000);

it("keeps a fully reviewed draft after bounded pre-write failures and allows reconfirmation", async () => {
  await fixture(
    async ({
      confirm,
      worker,
      advance,
      createTicket,
      job,
      conversation,
      messages,
      send,
    }) => {
      await confirm();
      createTicket
        .mockResolvedValueOnce({ kind: "not_sent", reason: "transport" })
        .mockResolvedValueOnce({ kind: "not_sent", reason: "timeout" })
        .mockResolvedValueOnce({ kind: "rejected", reason: "session" });
      await worker()(signal);
      advance(2001);
      await worker()(signal);
      advance(8001);
      await worker()(signal);
      expect(await job()).toMatchObject({ state: "FAILED", ticketId: null });
      expect((await conversation()).draft).toMatchObject({
        step: "review",
        description: "Falha no caixa",
      });
      expect(await worker()(signal)).toBe(false);
      expect(await messages()).toContainEqual(
        expect.stringContaining("Seu rascunho está salvo"),
      );
      await send(await conversation(), "Abrir chamado");
      await send(await conversation(), "Confirmar");
      await worker()(signal);
      expect(createTicket).toHaveBeenCalledTimes(4);
      expect(await job()).toMatchObject({ state: "COMPLETED", ticketId: 801n });
    },
  );
}, 120_000);
