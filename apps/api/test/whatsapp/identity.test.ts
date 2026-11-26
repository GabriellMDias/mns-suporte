import { createHmac, randomBytes } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { withMigratedDatabase } from "../../scripts/migrated-database.js";
import { createApp } from "../../src/app.js";
import {
  identityVerificationFrom,
  parseServerConfig,
  whatsappWebhookFrom,
  clientConfigFrom,
} from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  protectIdentityCode,
  type MessengerIdentity,
} from "../../src/features/whatsapp/identity-code.js";
import { createPostgresIdentityRepository } from "../../src/features/whatsapp/identity-repository.js";
import { createIdentityVerification } from "../../src/features/whatsapp/identity-service.js";
import { activateModules } from "../../src/module.js";
import { apiModules } from "../../src/modules.js";

const codeSecret = randomBytes(32).toString("hex");
const appSecret = randomBytes(32).toString("hex");
const phone = "10101";
const first = {
  businessPhoneId: phone,
  senderBusinessId: "BR.synthetic-one",
  senderPhone: "5511990000100",
};
const second = {
  businessPhoneId: phone,
  senderBusinessId: "BR.synthetic-two",
  senderPhone: "5511990000200",
};
const email = "employee@company.example";

function digest(code: string, messenger: MessengerIdentity) {
  const protectedCode = protectIdentityCode(code, messenger, codeSecret);
  if (protectedCode.type !== "verification_code")
    throw new Error("Expected code");
  return protectedCode.digest;
}

function inbound(id: string, body: string) {
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phone },
              messages: [
                {
                  id,
                  from_user_id: first.senderBusinessId,
                  from: first.senderPhone,
                  type: "text",
                  timestamp: "1795600000",
                  text: { body },
                },
              ],
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
        createHmac("sha256", appSecret).update(payload).digest("hex"),
    },
    payload,
  };
}

it("keeps verification settings server-side, canonicalizes domains and requires full GLPI and mail settings", () => {
  const config = {
    ORION_ENV: "test",
    GLPI_API_URL: "https://glpi.example.test/apirest.php",
    GLPI_APP_TOKEN: "synthetic-provider-app-token",
    GLPI_USER_TOKEN: "synthetic-provider-user-token",
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "synthetic-verify-token",
    WHATSAPP_PHONE_NUMBER_ID: phone,
    IDENTITY_CODE_SECRET: codeSecret,
    IDENTITY_ALLOWED_EMAIL_DOMAINS:
      " Company.Example, company.example, filial.example ",
    IDENTITY_SMTP_HOST: "relay.company.example",
    IDENTITY_SMTP_USER: "synthetic-service-user",
    IDENTITY_SMTP_PASSWORD: "synthetic-service-password",
    IDENTITY_SMTP_FROM: "NoReply@company.example",
  };
  const parsed = parseServerConfig(config);
  expect(clientConfigFrom(parsed)).toEqual({});
  expect(whatsappWebhookFrom(parsed)?.verificationCodeSecret).toBe(codeSecret);
  expect(identityVerificationFrom(parsed)).toMatchObject({
    allowedEmailDomains: ["company.example", "filial.example"],
    smtp: { port: 587, from: "noreply@company.example" },
  });
  expect(
    identityVerificationFrom(parseServerConfig({ ORION_ENV: "test" })),
  ).toBeUndefined();
  expect(() =>
    parseServerConfig({ ...config, IDENTITY_SMTP_PASSWORD: undefined }),
  ).toThrow("incomplete employee verification");
  expect(() =>
    parseServerConfig({
      ...config,
      GLPI_API_URL: undefined,
      GLPI_APP_TOKEN: undefined,
      GLPI_USER_TOKEN: undefined,
    }),
  ).toThrow("incomplete employee verification");
  expect(() =>
    parseServerConfig({
      ...config,
      IDENTITY_ALLOWED_EMAIL_DOMAINS: "*.example",
    }),
  ).toThrow("employee email domains");
});

it("scopes the digest to the sender, prefers the business ID, and removes other mentions", () => {
  const code = "MNS-ABCDEFGH";
  expect(digest(code, first)).toHaveLength(64);
  expect(digest(code, first)).not.toBe(digest(code, second));
  expect(digest(code, first)).toBe(
    digest(code.toLowerCase(), { ...first, senderPhone: undefined }),
  );
  expect(digest(code, first)).not.toBe(
    digest(code, { ...first, businessPhoneId: "99999" }),
  );
  expect(protectIdentityCode("  " + code + "  ", first, undefined)).toEqual({
    type: "verification_code",
  });
  expect(
    protectIdentityCode("Meu código é " + code, first, codeSecret),
  ).toEqual({
    type: "text",
    body: "Meu código é [código removido]",
  });
  expect(protectIdentityCode("123456", first, codeSecret)).toEqual({
    type: "text",
    body: "123456",
  });
});

it("verifies an isolated mailbox over signed WhatsApp input and consumes the code only once", async () => {
  await withMigratedDatabase(async (runtimeUrl, migrationUrl) => {
    const database = createDatabase(runtimeUrl);
    const inspection = createDatabase(migrationUrl);
    const repository = createPostgresIdentityRepository(database);
    const settings = { codeSecret, allowedEmailDomains: ["company.example"] };
    let now = Date.now();
    const clock = () => new Date(now);
    const findUser = vi
      .fn<Parameters<typeof createIdentityVerification>[2]>()
      .mockResolvedValue({ kind: "found", userId: 37 });
    const sendCode = vi
      .fn<(email: string, code: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const service = createIdentityVerification(
      repository,
      settings,
      findUser,
      sendCode,
      clock,
    );
    const modules = activateModules(
      apiModules,
      {
        database,
        whatsappWebhook: {
          appSecret,
          verifyToken: "synthetic-verification-token",
          phoneNumberId: phone,
          verificationCodeSecret: codeSecret,
        },
      },
      "test",
    );
    const { app } = createApp(pino({ level: "silent" }), undefined, {
      modules,
    });
    try {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          service.requestVerification(
            first,
            "request-1",
            " EMPLOYEE@company.example ",
          ),
        ),
      );
      expect(findUser).toHaveBeenCalledExactlyOnceWith(email);
      expect(sendCode).toHaveBeenCalledTimes(1);
      const code = sendCode.mock.calls[0][1];
      expect(code).toMatch(/^MNS-[A-HJ-NP-Z2-9]{8}$/);
      const response = await app.inject(
        inbound("wamid.confirmation-test", code),
      );
      expect(response.statusCode).toBe(200);
      const message = await inspection.whatsAppInboundMessage.findUniqueOrThrow(
        {
          where: { messageId: "wamid.confirmation-test" },
        },
      );
      expect(message.content).toEqual({
        type: "verification_code",
        digest: digest(code, first),
      });
      expect(JSON.stringify(message.content)).not.toContain(code);
      expect(
        await service.confirmVerification(
          second,
          "bad-peer",
          digest(code, second),
        ),
      ).toEqual({ kind: "invalid" });
      expect(await service.findVerifiedGlpiUser(second)).toBeUndefined();

      const protectedContent = message.content;
      if (
        !protectedContent ||
        typeof protectedContent !== "object" ||
        Array.isArray(protectedContent) ||
        typeof protectedContent.digest !== "string"
      )
        throw new Error("Expected stored verification digest");
      const storedDigest = protectedContent.digest;
      const confirmations = await Promise.all([
        service.confirmVerification(message, message.messageId, storedDigest),
        service.confirmVerification(message, message.messageId, storedDigest),
      ]);
      expect(confirmations.map(({ kind }) => kind).sort()).toEqual([
        "duplicate",
        "verified",
      ]);
      expect(
        await service.confirmVerification(
          first,
          "replayed-code",
          digest(code, first),
        ),
      ).toEqual({ kind: "invalid" });
      expect(await service.findVerifiedGlpiUser(first)).toBe(37);
      expect(
        await service.findVerifiedGlpiUser({ ...first, businessPhoneId: "90" }),
      ).toBeUndefined();
      expect(
        await database.whatsAppIdentityEvent.count({
          where: { codeDigest: { not: null } },
        }),
      ).toBe(0);
      now += 30 * 24 * 60 * 60 * 1000;
      expect(await service.findVerifiedGlpiUser(first)).toBeUndefined();
    } finally {
      await app.close();
      await Promise.all([database.$disconnect(), inspection.$disconnect()]);
    }
  });
}, 120_000);

it("enforces attempts, expiry and shared mailbox quotas without exposing directory matches", async () => {
  await withMigratedDatabase(async (runtimeUrl) => {
    const database = createDatabase(runtimeUrl);
    let now = Date.now();
    const clock = () => new Date(now);
    const sendCode = vi
      .fn<(email: string, code: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const lookup = vi
      .fn<
        (
          email: string,
        ) => Promise<{ kind: "found"; userId: number } | { kind: "not_found" }>
      >()
      .mockImplementation((input) =>
        Promise.resolve(
          input.startsWith("missing@")
            ? { kind: "not_found" }
            : { kind: "found", userId: 37 },
        ),
      );
    const service = createIdentityVerification(
      createPostgresIdentityRepository(database),
      { codeSecret, allowedEmailDomains: ["company.example"] },
      lookup,
      sendCode,
      clock,
    );
    try {
      await service.requestVerification(
        first,
        "external",
        "employee@untrusted.example",
      );
      await service.requestVerification(
        first,
        "missing",
        "missing@company.example",
      );
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(sendCode).not.toHaveBeenCalled();

      await service.requestVerification(first, "valid", email);
      const code = sendCode.mock.calls[0][1];
      const wrong = code === "MNS-ABCDEFGH" ? "MNS-ABCDEFGA" : "MNS-ABCDEFGH";
      expect(
        await service.confirmVerification(
          first,
          "invalid-1",
          digest(wrong, first),
        ),
      ).toEqual({ kind: "invalid" });
      expect(
        await service.confirmVerification(
          first,
          "invalid-1",
          digest(wrong, first),
        ),
      ).toEqual({ kind: "duplicate" });
      for (let attempt = 2; attempt <= 5; attempt++)
        expect(
          await service.confirmVerification(
            first,
            "invalid-" + attempt,
            digest(wrong, first),
          ),
        ).toEqual({ kind: "invalid" });
      expect(
        await service.confirmVerification(
          first,
          "correct-too-late",
          digest(code, first),
        ),
      ).toEqual({ kind: "invalid" });
      expect(await service.findVerifiedGlpiUser(first)).toBeUndefined();

      await Promise.all(
        ["BR.alt-1", "BR.alt-2", "BR.alt-3"].map((id) =>
          service.requestVerification(
            { ...second, senderBusinessId: id },
            "mailbox-" + id,
            email,
          ),
        ),
      );
      expect(sendCode).toHaveBeenCalledTimes(3);
      await service.requestVerification(
        first,
        "third-same-sender",
        "alias@company.example",
      );
      await service.requestVerification(
        first,
        "limited-sender",
        "another@company.example",
      );
      expect(sendCode).toHaveBeenCalledTimes(4);
      const expiring = sendCode.mock.calls[3][1];
      now += 10 * 60 * 1000;
      expect(
        await service.confirmVerification(
          first,
          "past-expiry",
          digest(expiring, first),
        ),
      ).toEqual({ kind: "invalid" });
      expect(await service.findVerifiedGlpiUser(first)).toBeUndefined();
      now += 60 * 60 * 1000;
      await service.requestVerification(first, "new-hour", email);
      expect(sendCode).toHaveBeenCalledTimes(5);
    } finally {
      await database.$disconnect();
    }
  });
}, 120_000);

it("lists two independently verified WhatsApp accounts and revokes only the selected link", async () => {
  await withMigratedDatabase(async (runtimeUrl) => {
    const db = createDatabase(runtimeUrl);
    const service = createIdentityVerification(
      createPostgresIdentityRepository(db),
      { codeSecret, allowedEmailDomains: ["company.example"] },
      vi
        .fn<Parameters<typeof createIdentityVerification>[2]>()
        .mockResolvedValue({ kind: "found", userId: 37 }),
      vi.fn(),
    );
    const mail = vi
      .fn<Parameters<typeof createIdentityVerification>[3]>()
      .mockResolvedValue(undefined);
    let now = Date.now();
    const identity = createIdentityVerification(
      createPostgresIdentityRepository(db),
      { codeSecret, allowedEmailDomains: ["company.example"] },
      vi
        .fn<Parameters<typeof createIdentityVerification>[2]>()
        .mockResolvedValue({ kind: "found", userId: 37 }),
      mail,
      () => new Date(now),
    );
    const actor = "6d9bf45d-3d5e-4ef6-a47d-1c8bdfbe11fb";
    const { app } = createApp(pino({ level: "silent" }), undefined, {
      modules: activateModules(
        apiModules,
        {
          database: db,
          whatsappWebhook: {
            appSecret,
            verifyToken: "synthetic-verify-token",
            phoneNumberId: phone,
          },
          verifier: {
            verify: (authorization) =>
              Promise.resolve(
                authorization === "Bearer synthetic-admin"
                  ? {
                      id: actor,
                      scopes: new Set([
                        "whatsapp:links:read",
                        "whatsapp:links:revoke",
                      ]),
                    }
                  : authorization === "Bearer synthetic-reader"
                    ? { id: actor, scopes: new Set(["whatsapp:links:read"]) }
                    : null,
              ),
          },
        },
        "test",
      ),
    });
    const root = "/admin/whatsapp/identity-links";
    const admin = { authorization: "Bearer synthetic-admin" };
    try {
      for (const [index, messenger] of [first, second].entries()) {
        await identity.requestVerification(messenger, "start-" + index, email);
        const code = mail.mock.calls[index][1];
        expect(
          await identity.confirmVerification(
            messenger,
            "finish-" + index,
            digest(code, messenger),
          ),
        ).toEqual({ kind: "verified", glpiUserId: 37 });
      }
      const query = root + "?glpiUserId=37";
      expect((await app.inject({ url: query })).statusCode).toBe(401);
      const page = await app.inject({ url: query, headers: admin });
      expect(page.statusCode).toBe(200);
      expect(page.headers["cache-control"]).toBe("no-store");
      expect(page.body).not.toContain(first.senderPhone);
      expect(page.body).not.toContain(second.senderBusinessId);
      const { items } = page.json<{
        items: { id: string; phoneLastFour: string; status: string }[];
      }>();
      expect(items.map((item) => item.phoneLastFour).sort()).toEqual([
        "0100",
        "0200",
      ]);
      expect(items.every((item) => item.status === "active")).toBe(true);
      const personal = items.find((item) => item.phoneLastFour === "0100")!;
      const revoke = {
        method: "POST" as const,
        url: root + "/" + personal.id + "/revoke",
      };
      expect(
        (
          await app.inject({
            ...revoke,
            headers: { authorization: "Bearer synthetic-reader" },
          })
        ).statusCode,
      ).toBe(403);
      await identity.requestVerification(first, "pending-code", email);
      const pending = mail.mock.calls[2][1];
      const [one, two] = await Promise.all([
        app.inject({ ...revoke, headers: admin }),
        app.inject({ ...revoke, headers: admin }),
      ]);
      expect(one.statusCode).toBe(200);
      expect(two.body).toBe(one.body);
      expect(await service.findVerifiedGlpiUser(first)).toBeUndefined();
      expect(await service.findVerifiedGlpiUser(second)).toBe(37);
      expect(
        await identity.confirmVerification(
          first,
          "revoked-code",
          digest(pending, first),
        ),
      ).toEqual({ kind: "invalid" });
      expect(
        await db.whatsAppVerifiedIdentity.findUnique({
          where: { linkId: personal.id },
          select: { revokedBy: true },
        }),
      ).toEqual({ revokedBy: actor });
      now += 3_600_001;
      await identity.requestVerification(first, "fresh-start", email);
      const fresh = mail.mock.calls[3][1];
      expect(
        await identity.confirmVerification(
          first,
          "fresh-finish",
          digest(fresh, first),
        ),
      ).toEqual({ kind: "verified", glpiUserId: 37 });
      expect((await app.inject({ ...revoke, headers: admin })).statusCode).toBe(
        404,
      );
      expect(await identity.findVerifiedGlpiUser(first)).toBe(37);
      expect(await identity.findVerifiedGlpiUser(second)).toBe(37);
    } finally {
      await app.close();
      await db.$disconnect();
    }
  });
}, 120_000);
