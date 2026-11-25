import { createHmac, randomBytes } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { withMigratedDatabase } from "../../scripts/migrated-database.js";
import { createApp } from "../../src/app.js";
import {
  parseServerConfig,
  whatsappConversationFrom,
  whatsappWebhookFrom,
} from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  readConversationState,
  routeConversation,
  type Conversation,
  type ConversationInput,
} from "../../src/features/whatsapp/conversation.js";
import { createConversationProcessor } from "../../src/features/whatsapp/conversation-processor.js";
import { scopeOf } from "../../src/features/whatsapp/identity-code.js";
import { createPostgresIdentityRepository } from "../../src/features/whatsapp/identity-repository.js";
import { createIdentityVerification } from "../../src/features/whatsapp/identity-service.js";
import { isOutboundPayload } from "../../src/features/whatsapp/outbound-contract.js";
import { activateModules } from "../../src/module.js";
import { apiModules } from "../../src/modules.js";

const businessPhoneId = "10101";
const supportContact = "https://ti.company.example/";
const sender = {
  businessPhoneId,
  senderBusinessId: "BR.synthetic-conversation",
};
const codeSecret = randomBytes(32).toString("hex");
const appSecret = randomBytes(32).toString("hex");
const verificationToken = randomBytes(16).toString("hex");
const identitySettings = {
  codeSecret,
  allowedEmailDomains: ["company.example"],
};
const logger = pino({ level: "silent" });
const signal = new AbortController().signal;
const chatText = (body: string): ConversationInput => ({ type: "text", body });

it("enables guided processing only with its real integration settings and direct IT contact", () => {
  const env = {
    ORION_ENV: "test",
    ORION_DATABASE_URL: "postgresql://postgres:synthetic@127.0.0.1:5432/orion",
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: verificationToken,
    WHATSAPP_PHONE_NUMBER_ID: businessPhoneId,
    WHATSAPP_ACCESS_TOKEN: "synthetic-meta-access-token",
    GLPI_API_URL: "https://glpi.company.example/apirest.php",
    GLPI_APP_TOKEN: "synthetic-glpi-app-token",
    GLPI_USER_TOKEN: "synthetic-glpi-user-token",
    IDENTITY_CODE_SECRET: codeSecret,
    IDENTITY_ALLOWED_EMAIL_DOMAINS: "company.example",
    IDENTITY_SMTP_HOST: "smtp.company.example",
    IDENTITY_SMTP_USER: "synthetic-account",
    IDENTITY_SMTP_PASSWORD: "synthetic-mail-password",
    IDENTITY_SMTP_FROM: "suporte@company.example",
  };
  expect(whatsappConversationFrom(parseServerConfig(env))).toBeUndefined();
  const configured = parseServerConfig({
    ...env,
    WHATSAPP_SUPPORT_CONTACT: supportContact,
  });
  expect(whatsappConversationFrom(configured)?.supportContact).toBe(
    supportContact,
  );
  expect(whatsappWebhookFrom(configured)?.outbound?.accessToken).toBe(
    env.WHATSAPP_ACCESS_TOKEN,
  );
  expect(() =>
    parseServerConfig({
      ...env,
      WHATSAPP_SUPPORT_CONTACT: "http://internal.example/",
    }),
  ).toThrow("WhatsApp support contact");
  expect(() =>
    parseServerConfig({
      ...env,
      WHATSAPP_SUPPORT_CONTACT: supportContact,
      WHATSAPP_ACCESS_TOKEN: undefined,
    }),
  ).toThrow("incomplete WhatsApp conversation");
});

it("reviews long descriptions, clears attachments, and keeps another GLPI user's draft private", () => {
  const context = {
    userId: 37,
    supportContact,
    draftId: "durable-draft",
    now: new Date(),
  };
  let state: Conversation = { phase: "menu" };
  const route = (input: ConversationInput) => {
    const response = routeConversation(state, input, context);
    state = response.state;
    return response;
  };
  route(chatText("Abrir chamado"));
  route(chatText("Sistemas"));
  route(chatText("Financeiro"));
  route(chatText("x".repeat(1201)));
  expect(state.draft?.step).toBe("description");
  route(chatText("x".repeat(1200)));
  route(chatText("Equipe parada"));
  for (let i = 1; i <= 6; i++)
    route({ type: "document", mediaId: "synthetic-" + i });
  expect(state.draft?.attachments).toHaveLength(5);
  route(chatText("Limpar anexos"));
  expect(state.draft?.attachments).toEqual([]);
  const review = route(chatText("Revisar rascunho"));
  expect(review.reply).toMatchObject({ type: "text" });
  expect(review.reply?.body).toContain("x".repeat(1200));
  const differentEmployee = routeConversation(state, chatText("retomar"), {
    ...context,
    userId: 99,
    draftId: "new-draft",
  });
  expect(differentEmployee.reply?.body).not.toContain("Financeiro");
  expect(differentEmployee.state.draft).toMatchObject({
    id: "new-draft",
    ownerId: 99,
    step: "category",
  });
  route(chatText("Cancelar"));
  expect(state).toEqual({ phase: "menu" });
});

function delivery(
  timestamp: number,
  id: string,
  message: object,
  phoneNumberId = businessPhoneId,
) {
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  id,
                  from_user_id: sender.senderBusinessId,
                  timestamp: String(Math.floor(timestamp / 1000)),
                  ...message,
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

const metaText = (body: string) => ({ type: "text", text: { body } });
const metaButton = (id: string) => ({
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id } },
});

it("continues signed onboarding and intake after restarts, with one reply per processed input", async () => {
  await withMigratedDatabase(async (runtimeUrl) => {
    let now = Date.now();
    const clock = () => new Date(now);
    let database = createDatabase(runtimeUrl);
    const options = { businessPhoneId, supportContact };
    const lookup = vi
      .fn<(email: string) => Promise<{ kind: "found"; userId: number }>>()
      .mockResolvedValue({ kind: "found", userId: 37 });
    const sendCode = vi
      .fn<(email: string, code: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const identity = () =>
      createIdentityVerification(
        createPostgresIdentityRepository(database),
        identitySettings,
        lookup,
        sendCode,
        clock,
      );
    const appFor = () =>
      createApp(logger, undefined, {
        modules: activateModules(
          apiModules,
          {
            database,
            whatsappWebhook: {
              appSecret,
              verifyToken: verificationToken,
              phoneNumberId: businessPhoneId,
              verificationCodeSecret: codeSecret,
            },
          },
          "test",
        ),
      }).app;
    let app = appFor();
    let process = createConversationProcessor(
      database,
      options,
      identity(),
      clock,
    );
    let index = 0;

    async function restart() {
      await app.close();
      await database.$disconnect();
      database = createDatabase(runtimeUrl);
      app = appFor();
      process = createConversationProcessor(
        database,
        options,
        identity(),
        clock,
      );
    }

    async function receive(message: object, id?: string) {
      const request = delivery(
        now,
        id ?? "wamid.conversation-" + ++index,
        message,
      );
      expect((await app.inject(request)).statusCode).toBe(200);
      return request;
    }

    async function send(message: object) {
      const before = new Set(
        (
          await database.whatsAppOutboundMessage.findMany({
            select: { id: true },
          })
        ).map(({ id }) => id),
      );
      const request = await receive(message);
      await Promise.all([process(signal), process(signal)]);
      const replies = (
        await database.whatsAppOutboundMessage.findMany()
      ).filter(({ id }) => !before.has(id));
      expect(replies).toHaveLength(1);
      const payload = replies[0].payload;
      if (!isOutboundPayload(payload))
        throw new Error("Expected a valid outbound reply");
      return { request, reply: payload.content };
    }

    async function draftState() {
      const row = await database.whatsAppConversation.findUniqueOrThrow({
        where: { scopeKey: scopeOf(sender)! },
      });
      return readConversationState(row.state);
    }

    try {
      expect((await send(metaText("Falar com a TI"))).reply.body).toContain(
        supportContact,
      );
      expect((await send(metaText("Oi"))).reply.body).toContain(
        "e-mail corporativo",
      );
      sendCode.mockImplementationOnce(async () => {
        const pending = await database.whatsAppOutboundMessage.findMany({
          where: { state: "PENDING" },
        });
        expect(
          pending.some(
            ({ payload }) =>
              isOutboundPayload(payload) &&
              payload.content.body.includes("Se o e-mail puder"),
          ),
        ).toBe(true);
      });
      const { request } = await send(metaText("funcionario@company.example"));
      expect(lookup).toHaveBeenCalledExactlyOnceWith(
        "funcionario@company.example",
      );
      expect(sendCode).toHaveBeenCalledTimes(1);
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(await process(signal)).toBe(false);
      expect(sendCode).toHaveBeenCalledTimes(1);

      const code = sendCode.mock.calls[0][1];
      const realIdentity = identity();
      const interrupted = createConversationProcessor(
        database,
        options,
        {
          requestVerification: (...args) =>
            realIdentity.requestVerification(...args),
          async confirmVerification(...args) {
            await realIdentity.confirmVerification(...args);
            throw new Error("synthetic stop after consuming the code");
          },
        },
        clock,
      );
      await receive(metaText(code));
      await expect(interrupted(signal)).rejects.toThrow(
        "synthetic stop after consuming",
      );
      expect((await draftState()).phase).toBe("code");
      await restart();
      expect(await process(signal)).toBe(false);
      now += 45_001;
      expect(await process(signal)).toBe(true);
      expect((await draftState()).phase).toBe("menu");

      expect((await send(metaButton("menu:open"))).reply.body).toContain(
        "categoria",
      );
      await send(metaText("Equipamentos"));
      await restart();
      expect((await draftState()).draft?.step).toBe("unit");
      expect((await send(metaText("menu"))).reply.body).toContain("retomar");
      expect((await send(metaText("retomar"))).reply.body).toContain("unidade");
      await send(metaText("Loja Centro"));
      await send(metaText("Impressora travou durante a emissão."));
      await send(metaText("Um caixa afetado"));
      await send({
        type: "image",
        image: { id: "10002", mime_type: "image/jpeg" },
      });
      const review = (await send(metaText("Revisar rascunho"))).reply;
      expect(review.body).toContain("Anexos: 1");
      if (review.type !== "buttons") throw new Error("Expected review buttons");
      const oldConfirm = review.buttons.find(
        ({ title }) => title === "Confirmar",
      )?.id;
      if (!oldConfirm) throw new Error("Expected confirmation button");

      await send(metaText("Editar"));
      await send(metaText("3"));
      const edited = (
        await send(metaText("Impressora travou mesmo após reiniciar."))
      ).reply;
      expect(edited.body).toContain("após reiniciar");
      await send(metaButton(oldConfirm));
      expect((await draftState()).draft?.confirmedAt).toBeUndefined();
      expect((await send(metaText("Confirmar"))).reply.body).toContain(
        "rascunho está confirmado",
      );
      expect((await draftState()).draft).toMatchObject({
        ownerId: 37,
        description: "Impressora travou mesmo após reiniciar.",
        attachments: [{ type: "image", mediaId: "10002" }],
      });
      expect((await draftState()).draft?.confirmedAt).toBeDefined();

      const stale = delivery(
        now - 24 * 60 * 60 * 1000 - 1000,
        "wamid.stale",
        metaText("Cancelar"),
      );
      const before = await database.whatsAppOutboundMessage.count();
      expect((await app.inject(stale)).statusCode).toBe(200);
      expect(await process(signal)).toBe(true);
      expect(await database.whatsAppOutboundMessage.count()).toBe(before);
      expect(
        await database.whatsAppInboundMessage.count({
          where: { conversationProcessedAt: null },
        }),
      ).toBe(0);
      // Enable the real module wiring for a second business number. Only
      // the provider transport is stubbed, so both workers run normally.
      const wiredPhone = "20202";
      const fakeFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({
            messages: [{ id: "wamid.synthetic-runtime-reply" }],
          }),
        );
      vi.stubGlobal("fetch", fakeFetch);
      const wiredApp = createApp(logger, undefined, {
        modules: activateModules(
          apiModules,
          {
            database,
            whatsappWebhook: {
              appSecret,
              verifyToken: verificationToken,
              phoneNumberId: wiredPhone,
              verificationCodeSecret: codeSecret,
              outbound: {
                accessToken: "synthetic-graph-token",
                graphVersion: "v27.0",
              },
            },
            whatsappConversation: {
              supportContact,
              glpi: {
                apiUrl: "https://glpi.company.example/apirest.php",
                appToken: "synthetic-app",
                userToken: "synthetic-user",
              },
              identity: {
                ...identitySettings,
                smtp: {
                  host: "relay.company.example",
                  port: 587,
                  user: "synthetic-user",
                  password: "synthetic-password",
                  from: "help@company.example",
                },
              },
            },
          },
          "test",
        ),
      }).app;
      try {
        const incoming = delivery(
          now,
          "wamid.runtime-guided",
          metaText("Falar com a TI"),
          wiredPhone,
        );
        expect((await wiredApp.inject(incoming)).statusCode).toBe(200);
        await vi.waitFor(
          async () => {
            const sent = await database.whatsAppOutboundMessage.findFirst({
              where: { businessPhoneId: wiredPhone, state: "ACCEPTED" },
            });
            expect(sent?.payload).toMatchObject({
              content: {
                type: "text",
                body: "Fale com a equipe de TI por " + supportContact + ".",
              },
            });
          },
          { timeout: 6000 },
        );
        expect(fakeFetch).toHaveBeenCalledTimes(1);
      } finally {
        await wiredApp.close();
        vi.unstubAllGlobals();
      }
    } finally {
      await app.close();
      await database.$disconnect();
    }
  });
}, 120_000);
