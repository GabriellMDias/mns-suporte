import { createHmac, randomBytes } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { withMigratedDatabase } from "../../scripts/migrated-database.js";
import { createApp } from "../../src/app.js";
import { parseServerConfig, whatsappWebhookFrom } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { activateModules } from "../../src/module.js";
import { apiModules } from "../../src/modules.js";
import { registerWhatsAppWebhook } from "../../src/features/whatsapp/routes.js";

const config = {
  appSecret: randomBytes(32).toString("hex"),
  verifyToken: randomBytes(32).toString("hex"),
  phoneNumberId: "10001",
};
const path = "/webhooks/whatsapp";
const logger = pino({ level: "silent" });

function change(message: object, phoneNumberId = config.phoneNumberId) {
  return {
    field: "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: phoneNumberId },
      messages: [message],
    },
  };
}

function payload(...changes: ReturnType<typeof change>[]) {
  return JSON.stringify(
    { object: "whatsapp_business_account", entry: [{ changes }] },
    null,
    2,
  );
}

function delivery(body: string, signedBody = body) {
  const signature = createHmac("sha256", config.appSecret)
    .update(signedBody)
    .digest("hex");
  return {
    method: "POST" as const,
    url: path,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + signature,
    },
    payload: body,
  };
}

const message = {
  id: "wamid.synthetic-001",
  timestamp: "1795600000",
  from_user_id: "BR.syntheticEmployee",
  type: "text",
  text: { body: "Impressora da recepção parada." },
};

describe("WhatsApp webhook", () => {
  it("requires a complete server-only configuration and fails closed in production", () => {
    const env = {
      ORION_ENV: "test",
      WHATSAPP_APP_SECRET: config.appSecret,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: config.verifyToken,
      WHATSAPP_PHONE_NUMBER_ID: config.phoneNumberId,
    };
    expect(whatsappWebhookFrom(parseServerConfig(env))).toEqual(config);
    expect(
      whatsappWebhookFrom(parseServerConfig({ ORION_ENV: "test" })),
    ).toBeUndefined();
    expect(() =>
      parseServerConfig({ ...env, WHATSAPP_APP_SECRET: undefined }),
    ).toThrow("incomplete WhatsApp webhook");
    expect(() =>
      parseServerConfig({ ...env, WHATSAPP_PHONE_NUMBER_ID: "invalid" }),
    ).toThrow("Invalid API configuration");
    expect(activateModules(apiModules, {}, "development")).toEqual([]);
    expect(() => activateModules(apiModules, {}, "production")).toThrow(
      "whatsappWebhook",
    );
  });

  it("verifies the challenge and authenticates the exact UTF-8 bytes before parsing", async () => {
    let received = 0;
    const { app } = createApp(logger);
    registerWhatsAppWebhook(app, config, ({ messages }) => {
      received += messages.length;
      return Promise.resolve();
    });
    try {
      const query = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": config.verifyToken,
        "hub.challenge": "00001234",
      });
      const accepted = await app.inject(path + "?" + query.toString());
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers["content-type"]).toMatch(/^text\/plain/);
      expect(accepted.body).toBe("00001234");
      query.set("hub.verify_token", "incorrect");
      expect((await app.inject(path + "?" + query.toString())).statusCode).toBe(
        403,
      );
      query.delete("hub.verify_token");
      expect((await app.inject(path + "?" + query.toString())).statusCode).toBe(
        400,
      );

      const body = payload(change(message));
      const altered = await app.inject(
        delivery(JSON.stringify(JSON.parse(body)), body),
      );
      expect(altered.statusCode).toBe(403);
      const unsigned = await app.inject({
        ...delivery(body),
        headers: { "content-type": "application/json" },
      });
      expect(unsigned.statusCode).toBe(403);
      expect((await app.inject(delivery("{", body))).statusCode).toBe(403);
      expect((await app.inject(delivery("{"))).statusCode).toBe(400);
      expect((await app.inject(delivery("{}"))).statusCode).toBe(400);
      expect(
        (
          await app.inject({
            ...delivery(body),
            headers: {
              ...delivery(body).headers,
              "content-type": "text/plain",
            },
          })
        ).statusCode,
      ).toBe(415);
      expect(
        (await app.inject(delivery(" ".repeat(3 * 1024 * 1024 + 1))))
          .statusCode,
      ).toBe(413);
      expect(received).toBe(0);

      const valid = await app.inject(delivery(body));
      expect(valid.statusCode).toBe(200);
      expect(valid.body).toBe("EVENT_RECEIVED");
      expect(received).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("withholds success when the inbox is unavailable", async () => {
    const { app } = createApp(logger);
    registerWhatsAppWebhook(app, config, () =>
      Promise.reject(new Error("synthetic database outage")),
    );
    try {
      const response = await app.inject(delivery(payload(change(message))));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: { code: "INTERNAL_ERROR" },
      });
      expect(response.body).not.toContain("synthetic database outage");
    } finally {
      await app.close();
    }
  });

  it("persists with insert-only privileges and deduplicates concurrent delivery", async () => {
    await withMigratedDatabase(async (runtimeUrl, migrationUrl) => {
      const database = createDatabase(runtimeUrl);
      const inspection = createDatabase(migrationUrl);
      const modules = activateModules(
        apiModules,
        { database, whatsappWebhook: config },
        "test",
      );
      const { app } = createApp(logger, undefined, { modules });
      const audio = {
        id: "wamid.synthetic-002",
        timestamp: message.timestamp,
        from: "5511990000100",
        type: "audio",
        audio: { id: "101010", mime_type: "audio/ogg" },
      };
      const body = payload(
        change(message),
        change(audio),
        change({ ...message, id: "wamid.wrong-recipient" }, "99999"),
        change({ ...message, id: "wamid.unsupported", type: "video" }),
      );
      try {
        const results = await Promise.all(
          Array.from({ length: 6 }, () => app.inject(delivery(body))),
        );
        expect(results.map(({ statusCode }) => statusCode)).toEqual(
          Array(6).fill(200),
        );
        expect(
          (
            await app.inject(
              delivery(
                payload(
                  change({
                    ...message,
                    text: { body: "Altered retry" },
                  }),
                ),
              ),
            )
          ).statusCode,
        ).toBe(200);
        expect(
          await inspection.whatsAppInboundMessage.findMany({
            orderBy: { messageId: "asc" },
          }),
        ).toMatchObject([
          {
            messageId: message.id,
            businessPhoneId: config.phoneNumberId,
            senderBusinessId: message.from_user_id,
            senderPhone: null,
            content: { type: "text", body: message.text.body },
          },
          {
            messageId: audio.id,
            senderBusinessId: null,
            senderPhone: audio.from,
            content: {
              type: "audio",
              mediaId: audio.audio.id,
              mimeType: "audio/ogg",
            },
          },
        ]);
        await expect(database.whatsAppInboundMessage.count()).rejects.toThrow();
      } finally {
        await app.close();
        await Promise.all([database.$disconnect(), inspection.$disconnect()]);
      }
    });
  }, 120_000);
});
