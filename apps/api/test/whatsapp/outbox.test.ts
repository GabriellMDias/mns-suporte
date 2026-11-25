import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { withMigratedDatabase } from "../../scripts/migrated-database.js";
import { createApp } from "../../src/app.js";
import { createDatabase } from "../../src/database.js";
import type { SendReply } from "../../src/features/whatsapp/graph-client.js";
import {
  dispatchNextWhatsAppReply,
  enqueueWhatsAppReply,
} from "../../src/features/whatsapp/outbox.js";
import { activateModules } from "../../src/module.js";
import { apiModules } from "../../src/modules.js";

const webhookConfig = {
  appSecret: randomBytes(32).toString("hex"),
  verifyToken: randomBytes(32).toString("hex"),
  phoneNumberId: "10001",
};
const businessPhoneId = webhookConfig.phoneNumberId;
const logger = pino({ level: "silent" });
const signal = new AbortController().signal;
const payload = {
  recipient: { kind: "phone", value: "5511990000100" },
  content: { type: "text", body: "Teste de suporte." },
} as const;

function statusCallback(status: object, phoneNumberId = businessPhoneId) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              statuses: [{ timestamp: "1795600000", ...status }],
            },
          },
        ],
      },
    ],
  });
  return {
    method: "POST" as const,
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256":
        "sha256=" +
        createHmac("sha256", webhookConfig.appSecret)
          .update(body)
          .digest("hex"),
    },
    payload: body,
  };
}

it("persists reply intents, claims them once and reconciles signed delivery evidence", async () => {
  await withMigratedDatabase(async (runtimeUrl) => {
    const db = createDatabase(runtimeUrl);
    const modules = activateModules(
      apiModules,
      { database: db, whatsappWebhook: webhookConfig },
      "test",
    );
    const { app } = createApp(logger, undefined, { modules });
    let now = Date.now() + 60_000;
    const clock = () => new Date(now);
    const intent = (expiresAt = new Date(now + 60_000)) => ({
      id: randomUUID(),
      businessPhoneId,
      expiresAt,
      payload,
    });
    const state = (id: string) =>
      db.whatsAppOutboundMessage.findUniqueOrThrow({ where: { id } });
    const dispatch = (send: SendReply) =>
      dispatchNextWhatsAppReply(db, businessPhoneId, send, signal, clock);

    try {
      const first = intent();
      await Promise.all(
        Array.from({ length: 4 }, () => enqueueWhatsAppReply(db, first)),
      );
      expect(await db.whatsAppOutboundMessage.count()).toBe(1);
      await expect(
        enqueueWhatsAppReply(db, {
          ...first,
          payload: {
            ...payload,
            content: { type: "text", body: "Conflicting text" },
          },
        }),
      ).rejects.toThrow("Conflicting WhatsApp reply intent");

      const accepted = vi.fn<SendReply>().mockImplementation(async (id) => {
        const response = await app.inject(
          statusCallback({
            id: "wamid.first",
            status: "delivered",
            biz_opaque_callback_data: id,
          }),
        );
        expect(response.statusCode).toBe(200);
        return { kind: "accepted", messageId: "wamid.first" };
      });
      await Promise.all(Array.from({ length: 6 }, () => dispatch(accepted)));
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(await state(first.id)).toMatchObject({
        state: "DELIVERED",
        attempts: 1,
        providerMessageId: "wamid.first",
      });
      await app.inject(
        statusCallback({
          id: "wamid.first",
          status: "failed",
          errors: [{ code: 131047 }],
        }),
      );
      expect(await state(first.id)).toMatchObject({
        state: "DELIVERED",
        providerErrorCode: null,
      });
      await app.inject(
        statusCallback({ id: "wamid.first", status: "read" }, "99999"),
      );
      expect((await state(first.id)).state).toBe("DELIVERED");
      await app.inject(statusCallback({ id: "wamid.first", status: "read" }));
      expect((await state(first.id)).state).toBe("READ");

      const retry = intent(new Date(now + 90_000));
      await enqueueWhatsAppReply(db, retry);
      const throttled = vi
        .fn<SendReply>()
        .mockResolvedValueOnce({
          kind: "throttled",
          code: 130429,
          retryAfterMs: 8000,
        })
        .mockResolvedValueOnce({ kind: "accepted", messageId: "wamid.retry" });
      await dispatch(throttled);
      expect(await state(retry.id)).toMatchObject({
        state: "PENDING",
        attempts: 1,
        providerErrorCode: 130429,
        availableAt: new Date(now + 8000),
      });
      expect(await dispatch(throttled)).toBe(false);
      now += 8001;
      await dispatch(throttled);
      expect(await state(retry.id)).toMatchObject({
        state: "ACCEPTED",
        attempts: 2,
        providerErrorCode: null,
      });

      const exhausted = intent(new Date(now + 180_000));
      await enqueueWhatsAppReply(db, exhausted);
      const rateLimited = vi.fn<SendReply>().mockResolvedValue({
        kind: "throttled",
        code: 130429,
        retryAfterMs: 0,
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        await dispatch(rateLimited);
        now += 16001;
      }
      expect(await state(exhausted.id)).toMatchObject({
        state: "FAILED",
        attempts: 4,
        providerErrorCode: 130429,
      });
      expect(await dispatch(rateLimited)).toBe(false);
      expect(rateLimited).toHaveBeenCalledTimes(4);

      const nearDeadline = intent(new Date(now + 500));
      await enqueueWhatsAppReply(db, nearDeadline);
      await dispatch(rateLimited);
      expect(await state(nearDeadline.id)).toMatchObject({
        state: "FAILED",
        attempts: 1,
      });

      const unknown = intent();
      await enqueueWhatsAppReply(db, unknown);
      const uncertain = vi
        .fn<SendReply>()
        .mockResolvedValue({ kind: "uncertain" });
      await dispatch(uncertain);
      expect(await state(unknown.id)).toMatchObject({
        state: "UNCERTAIN",
        attempts: 1,
      });
      expect(await dispatch(uncertain)).toBe(false);
      expect(uncertain).toHaveBeenCalledTimes(1);
      await app.inject(
        statusCallback({
          id: "wamid.uncertain",
          status: "sent",
          biz_opaque_callback_data: unknown.id,
        }),
      );
      expect(await state(unknown.id)).toMatchObject({
        state: "SENT",
        providerMessageId: "wamid.uncertain",
      });

      const stale = intent();
      await enqueueWhatsAppReply(db, stale);
      await db.whatsAppOutboundMessage.update({
        where: { id: stale.id },
        data: {
          state: "SENDING",
          attempts: 1,
          attemptStartedAt: new Date(now - 31_000),
        },
      });
      const expired = intent(new Date(now - 1));
      await enqueueWhatsAppReply(db, expired);
      expect(await dispatch(uncertain)).toBe(false);
      expect((await state(stale.id)).state).toBe("UNCERTAIN");
      expect((await state(expired.id)).state).toBe("EXPIRED");
      expect(uncertain).toHaveBeenCalledTimes(1);
      await expect(
        db.whatsAppOutboundMessage.update({
          where: { id: first.id },
          data: {
            payload: { ...payload, content: { type: "text", body: "Altered" } },
          },
        }),
      ).rejects.toThrow();
    } finally {
      await app.close();
      await db.$disconnect();
    }
  });
}, 120_000);
