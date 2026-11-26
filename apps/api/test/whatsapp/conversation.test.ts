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
import * as verificationMail from "../../src/integrations/mail/verification.js";
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
    WHATSAPP_CLOSURE_TEMPLATE_NAME: "mns_chamado_encerrado_v1",
  });
  expect(whatsappConversationFrom(configured)?.supportContact).toBe(
    supportContact,
  );
  expect(whatsappWebhookFrom(configured)?.outbound?.accessToken).toBe(
    env.WHATSAPP_ACCESS_TOKEN,
  );
  expect(whatsappWebhookFrom(configured)?.outbound?.closureTemplateName).toBe(
    "mns_chamado_encerrado_v1",
  );
  expect(() =>
    parseServerConfig({
      ...env,
      WHATSAPP_CLOSURE_TEMPLATE_NAME: "Invalid Name",
    }),
  ).toThrow("Invalid API configuration");
  expect(() =>
    parseServerConfig({
      ...env,
      WHATSAPP_ACCESS_TOKEN: undefined,
      WHATSAPP_CLOSURE_TEMPLATE_NAME: "mns_chamado_encerrado_v1",
    }),
  ).toThrow("closure template needs outbound");
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
  expect(route(chatText("Abrir chamado")).reply?.body).toContain(
    "título do chamado",
  );
  route(chatText("Falha no caixa"));
  route(chatText("x".repeat(1201)));
  expect(state.draft?.step).toBe("description");
  const review = route(chatText("x".repeat(1200)));
  expect(state.draft?.step).toBe("review");
  expect(review.reply).toMatchObject({ type: "text" });
  expect(review.reply?.body).toContain("Título: Falha no caixa");
  expect(review.reply?.body).toContain("x".repeat(1200));
  for (let i = 1; i <= 6; i++)
    route({ type: "document", mediaId: "synthetic-" + i });
  expect(state.draft?.attachments).toHaveLength(5);
  route(chatText("Limpar anexos"));
  expect(state.draft?.attachments).toEqual([]);
  const differentEmployee = routeConversation(state, chatText("retomar"), {
    ...context,
    userId: 99,
    draftId: "new-draft",
  });
  expect(differentEmployee.reply?.body).not.toContain("x".repeat(80));
  expect(differentEmployee.state.draft).toMatchObject({
    id: "new-draft",
    ownerId: 99,
    step: "title",
  });
  route(chatText("Cancelar"));
  expect(state).toEqual({ phase: "menu" });
});

it("resumes legacy drafts without the removed fields and requires a fresh review", () => {
  const context = {
    userId: 37,
    supportContact,
    draftId: "new-draft",
    now: new Date(),
  };
  const legacy = {
    id: "legacy-draft",
    ownerId: 37,
    revision: 5,
    editing: false,
    category: "Sistema",
    unit: "Centro",
    attachments: [{ type: "document", mediaId: "existing-file" }],
  };
  const incomplete = readConversationState({
    phase: "intake",
    draft: { ...legacy, step: "unit" },
  });
  expect(incomplete.draft?.step).toBe("title");
  const stored = readConversationState({
    phase: "intake",
    draft: {
      ...legacy,
      step: "review",
      description: "  Erro\tno caixa\nErro ao concluir o pagamento.",
      impact: "Um caixa",
    },
  });
  expect(
    routeConversation(stored, chatText("Confirmar"), context).submission,
  ).toBeUndefined();
  const resumed = routeConversation(stored, chatText("Erro no caixa"), context);
  expect(resumed.reply?.body).toContain("Título: Erro no caixa");
  const stale = routeConversation(
    resumed.state,
    { type: "reply", replyId: "draft:confirm:legacy-draft:5" },
    context,
  );
  expect(stale.submission).toBeUndefined();
  expect(
    routeConversation(resumed.state, chatText("Confirmar"), context).submission,
  ).toEqual({
    draftId: legacy.id,
    requesterId: 37,
    title: "Erro no caixa",
    description:
      "  Erro\tno caixa\nErro ao concluir o pagamento.\n\nReferência MNS: legacy-draft",
    mediaIds: ["existing-file"],
  });
});

function delivery(
  timestamp: number,
  id: string,
  message: object,
  phoneNumberId = businessPhoneId,
) {
  return signedWebhook(phoneNumberId, {
    messages: [
      {
        id,
        from_user_id: sender.senderBusinessId,
        timestamp: String(Math.floor(timestamp / 1000)),
        ...message,
      },
    ],
  });
}

function signedWebhook(phoneNumberId: string, events: object) {
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
              ...events,
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
  await withMigratedDatabase(async (runtimeUrl, migrationUrl) => {
    let now = Date.now();
    const clock = () => new Date(now);
    let database = createDatabase(runtimeUrl);
    const inspector = createDatabase(migrationUrl);
    const options = {
      businessPhoneId,
      supportContact,
      readOwnedTickets: vi
        .fn<
          Parameters<typeof createConversationProcessor>[1]["readOwnedTickets"]
        >()
        .mockResolvedValue({ kind: "ready", tickets: [] }),
    };
    const lookup = vi
      .fn<(email: string) => Promise<{ kind: "found"; userId: number }>>()
      .mockResolvedValue({ kind: "found", userId: 37 });
    const sendCode = vi
      .fn<(email: string, code: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const directoryPhone = "5511990000100";
    const matchPhone = vi.fn((phone: string, userId: number) =>
      Promise.resolve(phone === directoryPhone && userId === 37),
    );
    const identity = () =>
      createIdentityVerification(
        createPostgresIdentityRepository(database),
        identitySettings,
        lookup,
        sendCode,
        clock,
        matchPhone,
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
      expect((await send(metaText("Oi"))).reply.body).toContain(
        "e-mail corporativo",
      );
      const { request, reply } = await send(
        metaText("funcionario@company.example"),
      );
      expect(reply.body).toContain("Se o e-mail puder");
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
        "título do chamado",
      );
      await send(metaText("Impressora do caixa"));
      await restart();
      expect((await draftState()).draft?.step).toBe("description");
      expect((await send(metaText("menu"))).reply.body).toContain("retomar");
      expect((await send(metaText("retomar"))).reply.body).toContain(
        "Descreva o problema",
      );
      const offer = (
        await send(metaText("A impressora não imprime durante a emissão."))
      ).reply;
      expect(offer.body).toContain("Impressora indisponível");
      if (offer.type !== "buttons")
        throw new Error("Expected troubleshooting buttons");
      const continueButton = offer.buttons.find(
        ({ title }) => title === "Ainda preciso",
      );
      if (!continueButton) throw new Error("Expected continue button");
      const draftId = (await draftState()).draft?.id;
      if (!draftId) throw new Error("Expected a durable draft");

      await restart();
      expect((await draftState()).draft?.step).toBe("guidance");
      const feedbackInput = await send(metaButton(continueButton.id));
      expect(feedbackInput.reply.body).toContain("Anexos: 0");
      expect((await app.inject(feedbackInput.request)).statusCode).toBe(200);
      expect(await process(signal)).toBe(false);
      expect(
        await inspector.whatsAppTroubleshootingFeedback.findMany(),
      ).toMatchObject([
        { draftId, guidanceId: "printer_offline_v1", outcome: "NOT_RESOLVED" },
      ]);
      const review = (
        await send({
          type: "image",
          image: { id: "10002", mime_type: "image/jpeg" },
        })
      ).reply;
      expect(review.body).toContain("Anexos: 1");
      if (review.type !== "buttons") throw new Error("Expected review buttons");
      const oldConfirm = review.buttons.find(
        ({ title }) => title === "Confirmar",
      )?.id;
      if (!oldConfirm) throw new Error("Expected confirmation button");

      await send(metaText("Editar"));
      await send(metaText("2"));
      const edited = (
        await send(metaText("Impressora travou mesmo após reiniciar."))
      ).reply;
      expect(edited.body).toContain("Título: Impressora do caixa");
      await send(metaButton(oldConfirm));
      expect((await draftState()).draft?.confirmedAt).toBeUndefined();
      expect((await send(metaText("Avisos"))).reply.body).toContain(
        "mudança de status",
      );
      expect((await send(metaButton("closure:enable"))).reply.body).toContain(
        "Avisos ativados",
      );
      const consentScope = scopeOf(sender)!;
      const previousConsent =
        await database.whatsAppClosurePreference.findUniqueOrThrow({
          where: { scopeKey: consentScope },
        });
      await send(metaText("Ativar avisos"));
      expect(
        await database.whatsAppClosurePreference.findUnique({
          where: { scopeKey: consentScope },
        }),
      ).toMatchObject({
        grantId: previousConsent.grantId,
        glpiUserId: 37n,
        revokedAt: null,
      });
      await inspector.whatsAppClosurePreference.update({
        where: { scopeKey: consentScope },
        data: { glpiUserId: 38n },
      });
      const confirmed = await send(metaText("Confirmar"));
      expect(confirmed.reply.body).toContain("Rascunho confirmado");
      const consent =
        await database.whatsAppClosurePreference.findUniqueOrThrow({
          where: { scopeKey: consentScope },
        });
      expect(consent).toMatchObject({ glpiUserId: 37n, revokedAt: null });
      expect(consent.grantId).not.toBe(previousConsent.grantId);
      expect((await app.inject(confirmed.request)).statusCode).toBe(200);
      await send(metaText("Confirmar"));
      expect(await database.whatsAppTicketSubmission.findMany()).toMatchObject([
        {
          draftId,
          requesterId: 37n,
          mediaIds: ["10002"],
          state: "PENDING",
          closureConsentId: consent.grantId,
          closureCheckAt: null,
        },
      ]);
      expect((await draftState()).draft).toMatchObject({
        ownerId: 37,
        description: "Impressora travou mesmo após reiniciar.",
        attachments: [{ type: "image", mediaId: "10002" }],
      });
      expect((await draftState()).draft?.confirmedAt).toBeDefined();
      expect((await send(metaText("Parar avisos"))).reply.body).toContain(
        "desativados",
      );
      expect(
        await database.whatsAppClosurePreference.findUnique({
          where: { scopeKey: consentScope },
        }),
      ).toMatchObject({
        grantId: consent.grantId,
        revokedAt: clock(),
        recipient: null,
      });

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
      // A lookup already in progress cannot publish under a different binding.
      const scopeKey = scopeOf(sender)!;
      options.readOwnedTickets.mockImplementationOnce(async (owner) => {
        expect(owner).toBe(37);
        await inspector.whatsAppVerifiedIdentity.update({
          where: { scopeKey },
          data: { glpiUserId: 38 },
        });
        return {
          kind: "ready",
          tickets: [{ id: 80, title: "Private old ticket", status: 6 }],
        };
      });
      await receive(metaText("Chamado 80"));
      expect(await process(signal)).toBe(true);
      expect(await database.whatsAppOutboundMessage.count()).toBe(before);

      options.readOwnedTickets.mockRejectedValueOnce(
        new Error("Synthetic lookup interruption"),
      );
      await receive(metaText("Chamado 80"), "wamid.interrupted-lookup");
      await expect(process(signal)).rejects.toThrow(
        "Synthetic lookup interruption",
      );
      expect(
        await database.whatsAppInboundMessage.findUnique({
          where: { messageId: "wamid.interrupted-lookup" },
        }),
      ).toMatchObject({
        conversationRequesterId: 38n,
        conversationAction: "QUERY_TICKETS",
      });
      await inspector.whatsAppVerifiedIdentity.update({
        where: { scopeKey },
        data: { glpiUserId: 39 },
      });
      await restart();
      now += 45_001;
      expect(await process(signal)).toBe(true);
      expect(options.readOwnedTickets).toHaveBeenCalledTimes(2);
      expect(await database.whatsAppOutboundMessage.count()).toBe(before);
      const knownSender = {
        businessPhoneId,
        senderBusinessId: "BR.directory-phone",
        senderPhone: directoryPhone,
      };
      const fromKnownSender = (body: string) => ({
        ...metaText(body),
        from_user_id: knownSender.senderBusinessId,
        from: knownSender.senderPhone,
      });
      expect((await send(fromKnownSender("Oi"))).reply.body).toContain(
        "e-mail corporativo",
      );
      expect(
        (await send(fromKnownSender("funcionario@company.example"))).reply.body,
      ).toContain("Número reconhecido no GLPI");
      expect(matchPhone).toHaveBeenCalledWith(directoryPhone, 37);
      expect(sendCode).toHaveBeenCalledTimes(1);
      const knownScope = scopeOf(knownSender)!;
      expect(
        await database.whatsAppVerifiedIdentity.findUnique({
          where: { scopeKey: knownScope },
        }),
      ).toMatchObject({
        glpiUserId: 37n,
        expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
        phoneLastFour: "0100",
      });
      await inspector.whatsAppVerifiedIdentity.update({
        where: { scopeKey: knownScope },
        data: {
          revokedAt: clock(),
          revokedBy: "6d9bf45d-3d5e-4ef6-a47d-1c8bdfbe11fb",
        },
      });
      await send(fromKnownSender("Oi"));
      expect(
        (await send(fromKnownSender("funcionario@company.example"))).reply.body,
      ).toContain("receberá um código");
      expect(sendCode).toHaveBeenCalledTimes(2);
      // Exercise the normal route, worker, and database composition with synthetic providers.
      const wiredPhone = "20202";
      const wiredScope = scopeOf({ ...sender, businessPhoneId: wiredPhone })!;
      const account = "piloto@company.example";
      const templateName = "mns_chamado_encerrado_v1";
      const notificationId = "wamid.synthetic-closure";
      let wiredDraftId: string;
      let closed = false;
      let createCalls = 0;
      const noticeAttempts: unknown[] = [];
      const replies: string[] = [];
      const relay = vi
        .fn<(recipient: string, code: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const mailer = vi
        .spyOn(verificationMail, "createVerificationMailer")
        .mockReturnValue(relay);
      const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/messages")) {
          const body = (await request.json()) as {
            text?: { body: string };
            interactive?: { body: { text: string } };
            template?: unknown;
            requiredGlpiUserId?: number;
          };
          expect(body.requiredGlpiUserId).toBeUndefined();
          if (body.template) {
            noticeAttempts.push(body);
            if (noticeAttempts.length === 1)
              return Response.json(
                { error: { code: 130429 } },
                { status: 429, headers: { "retry-after": "1" } },
              );
            return Response.json({ messages: [{ id: notificationId }] });
          }
          const rendered = body.text?.body ?? body.interactive?.body.text;
          if (!rendered) throw new Error("Missing WhatsApp content");
          replies.push(rendered);
          return Response.json({
            messages: [{ id: "wamid.synthetic-runtime-" + replies.length }],
          });
        }
        if (url.pathname.endsWith("/initSession"))
          return Response.json({ session_token: "synthetic-session" });
        if (url.pathname.endsWith("/search/User")) {
          expect(url.searchParams.get("criteria[0][value]")).toBe(account);
          return Response.json({
            totalcount: 2,
            count: 2,
            data: [
              { "2": 37, "5": account, "8": 1 },
              { "2": 93, "5": "outro." + account, "8": 1 },
            ],
          });
        }
        if (url.pathname.endsWith("/search/Ticket")) {
          const filter = url.searchParams.get("criteria[1][value]");
          const candidates =
            filter === "notold"
              ? [{ "1": "Chamado antigo em atendimento", "2": "76", "12": "2" }]
              : filter === "80"
                ? [
                    {
                      "1": "Chamado antigo fechado",
                      "2": "80",
                      "12": "6",
                      "19": "2026-08-20 13:14:15",
                    },
                  ]
                : filter === "112"
                  ? [
                      {
                        "1": "Suporte via WhatsApp",
                        "2": "112",
                        "12": closed ? "6" : "2",
                      },
                    ]
                  : [];
          return Response.json({
            totalcount: candidates.length,
            count: candidates.length,
            data: candidates,
          });
        }
        if (url.pathname.endsWith("/Ticket_User")) {
          const id = Number(url.pathname.split("/").at(-2));
          return Response.json([{ tickets_id: id, users_id: 37, type: 1 }]);
        }
        if (url.pathname.endsWith("/Ticket")) {
          expect(request.method).toBe("POST");
          createCalls += 1;
          expect(await request.json()).toEqual({
            input: {
              name: "Impressora do caixa",
              content:
                "Impressora &lt;travou&gt;.<br><br>Referência MNS: " +
                wiredDraftId,
              _users_id_requester: 37,
            },
          });
          return Response.json({ id: 112 }, { status: 201 });
        }
        if (url.pathname.endsWith("/10003")) {
          expect(url.searchParams.get("phone_number_id")).toBe(wiredPhone);
          return Response.json({
            id: "10003",
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=10003",
            mime_type: "image/jpeg",
            file_size: 3,
          });
        }
        if (url.hostname === "lookaside.fbsbx.com")
          return new Response(new Uint8Array([255, 216, 255]), {
            headers: { "content-type": "image/jpeg" },
          });
        if (url.pathname.endsWith("/Document")) {
          const multipart = await request.formData();
          const filename = "mns-" + wiredDraftId + "-1.jpg";
          const manifest = multipart.get("uploadManifest");
          if (typeof manifest !== "string")
            throw new Error("Expected GLPI upload manifest");
          expect(JSON.parse(manifest)).toMatchObject({
            input: { _filename: [filename], itemtype: "Ticket", items_id: 112 },
          });
          const file = multipart.get("filename[0]");
          if (!(file instanceof File)) throw new Error("Expected a file");
          expect(file.name).toBe(filename);
          expect(new Uint8Array(await file.arrayBuffer())).toEqual(
            new Uint8Array([255, 216, 255]),
          );
          return Response.json({ id: "19" }, { status: 201 });
        }
        if (url.pathname.endsWith("/ITILFollowup")) return Response.json([]);
        if (url.pathname.endsWith("/ITILSolution"))
          return Response.json([
            {
              id: 22,
              itemtype: "Ticket",
              items_id: 112,
              status: 3,
              date_creation: "2026-11-26 11:00:00",
              content: "<p>Equipamento normalizado.</p>",
            },
          ]);
        if (url.pathname.endsWith("/Ticket/112")) {
          if (url.searchParams.get("with_documents") !== "true")
            return Response.json({
              id: 112,
              status: closed ? 6 : 2,
              solvedate: "2026-11-26 11:00:00",
            });
          return Response.json({ id: 112, _documents: [{ id: 19 }] });
        }
        throw new Error("Unexpected provider request");
      });
      const networkFetch = fetch;
      vi.stubGlobal("fetch", fakeFetch);
      const wiredAppFor = () =>
        createApp(logger, undefined, {
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
                  closureTemplateName: templateName,
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
      let wiredApp = wiredAppFor();
      try {
        const listen = () => wiredApp.listen({ host: "127.0.0.1", port: 0 });
        let address = await listen();
        const post = async ({
          method,
          url,
          headers,
          payload,
        }: ReturnType<typeof delivery>) => {
          const response = await networkFetch(new URL(url, address), {
            method,
            headers,
            body: payload,
            signal: AbortSignal.timeout(4000),
          });
          await response.arrayBuffer();
          expect(response.status).toBe(200);
        };
        const challenge = new URL("/webhooks/whatsapp", address);
        challenge.search = new URLSearchParams({
          "hub.mode": "subscribe",
          "hub.verify_token": verificationToken,
          "hub.challenge": "00001234",
        }).toString();
        const verified = await networkFetch(challenge, {
          signal: AbortSignal.timeout(4000),
        });
        expect(verified.status).toBe(200);
        expect(await verified.text()).toBe("00001234");

        async function consult(id: string, message: object) {
          const previous = replies.length;
          const request = delivery(Date.now(), id, message, wiredPhone);
          await post(request);
          await vi.waitFor(() => expect(replies).toHaveLength(previous + 1), {
            timeout: 8000,
          });
          return { body: replies[previous], request };
        }
        const step = async (id: string, body: string) =>
          (await consult("wamid.pilot-" + id, metaText(body))).body;
        expect(await step("greeting", "Oi")).toContain("e-mail corporativo");
        expect(await step("mail", account)).toContain("receberá um código");
        await vi.waitFor(() => expect(relay).toHaveBeenCalledTimes(1));
        const [recipient, receivedCode] = relay.mock.calls[0];
        expect(recipient).toBe(account);
        expect(await step("verification", receivedCode)).toContain(
          "E-mail verificado",
        );
        expect(await step("intake", "Abrir chamado")).toContain(
          "título do chamado",
        );
        expect(await step("title", "Impressora do caixa")).toContain(
          "Descreva o problema",
        );

        await vi.waitFor(async () => {
          const accepted = await database.whatsAppOutboundMessage.count({
            where: { businessPhoneId: wiredPhone, state: "ACCEPTED" },
          });
          expect(accepted).toBe(replies.length);
        });
        await wiredApp.close();
        wiredApp = wiredAppFor();
        address = await listen();
        expect(await step("resume", "retomar")).toContain(
          "Descreva o problema",
        );
        expect(await step("description", "Impressora <travou>.")).toContain(
          "Título: Impressora do caixa",
        );
        const attachment = await consult("wamid.pilot-attachment", {
          type: "image",
          image: { id: "10003", mime_type: "image/jpeg" },
        });
        expect(attachment.body).toContain("Anexos: 1");
        const store = await database.whatsAppConversation.findUniqueOrThrow({
          where: { scopeKey: wiredScope },
        });
        const draft = readConversationState(store.state).draft;
        if (!draft) throw new Error("Expected a persisted pilot draft");
        wiredDraftId = draft.id;
        const repliesBefore = replies.length;
        const incoming = delivery(
          Date.now(),
          "wamid.runtime-guided",
          metaText("Confirmar"),
          wiredPhone,
        );
        await Promise.all([post(incoming), post(incoming), post(incoming)]);
        await vi.waitFor(
          async () => {
            const sent = await database.whatsAppOutboundMessage.findMany({
              where: { businessPhoneId: wiredPhone, state: "ACCEPTED" },
            });
            expect(sent.map(({ payload }) => payload)).toContainEqual(
              expect.objectContaining({
                content: {
                  type: "text",
                  body: "Chamado *#112* aberto no GLPI.\nAnexos incluídos: 1.",
                },
              }),
            );
          },
          { timeout: 6000 },
        );
        expect(replies).toHaveLength(repliesBefore + 2);
        expect(createCalls).toBe(1);
        const submitted =
          await database.whatsAppTicketSubmission.findUniqueOrThrow({
            where: { draftId: wiredDraftId },
          });
        expect(submitted).toMatchObject({
          state: "COMPLETED",
          ticketId: 112n,
          attachedCount: 1,
          mediaIds: [],
          recipient: null,
        });
        expect(submitted.closureConsentId).toBeTruthy();
        expect(submitted.closureCheckAt).toBeInstanceOf(Date);
        const listed = await consult(
          "wamid.legacy-list",
          metaButton("menu:tickets"),
        );
        expect(listed.body).toContain(
          "#76 · Chamado antigo em atendimento · Em atendimento",
        );
        await post(listed.request);
        const detail = await consult(
          "wamid.legacy-detail",
          metaText("Chamado 80"),
        );
        expect(detail.body).toContain(
          "Chamado antigo fechado\nSituação: Fechado\nÚltima atualização: 20/08/2026 às 13:14",
        );

        const otherSender = "BR.synthetic-other-reader";
        await database.whatsAppVerifiedIdentity.create({
          data: {
            scopeKey: scopeOf({
              businessPhoneId: wiredPhone,
              senderBusinessId: otherSender,
            })!,
            glpiUserId: 93,
            verifiedAt: clock(),
            expiresAt: new Date(now + 86_400_000),
          },
        });
        const inaccessible = await consult("wamid.other-detail", {
          ...metaText("Chamado 80"),
          from_user_id: otherSender,
        });
        const missing = await consult("wamid.other-missing", {
          ...metaText("Chamado 81"),
          from_user_id: otherSender,
        });
        expect(inaccessible.body).toBe(missing.body);
        expect(inaccessible.body).not.toContain("80");

        const searchCallsBefore = fakeFetch.mock.calls.filter(([input]) =>
          new Request(input).url.includes("/search/Ticket"),
        ).length;
        const unverified = await consult("wamid.unverified-detail", {
          ...metaText("Chamado 80"),
          from_user_id: "BR.synthetic-guest",
        });
        expect(unverified.body).toContain("e-mail corporativo");
        expect(
          fakeFetch.mock.calls.filter(([input]) =>
            new Request(input).url.includes("/search/Ticket"),
          ),
        ).toHaveLength(searchCallsBefore);

        // Advance only this synthetic conversation beyond the service window and
        // make its scheduled watch due without changing the runtime clock.
        const pastWindow = new Date(Date.now() - 25 * 60 * 60_000);
        await inspector.whatsAppInboundMessage.updateMany({
          where: {
            businessPhoneId: wiredPhone,
            senderBusinessId: sender.senderBusinessId,
          },
          data: { occurredAt: pastWindow, receivedAt: pastWindow },
        });
        closed = true;
        await inspector.whatsAppTicketSubmission.update({
          where: { draftId: wiredDraftId },
          data: { closureCheckAt: new Date() },
        });
        const notice = () =>
          database.whatsAppOutboundMessage.findUnique({
            where: { id: wiredDraftId },
          });
        await vi.waitFor(
          async () => {
            expect(await notice()).toMatchObject({
              state: "ACCEPTED",
              providerMessageId: notificationId,
              attempts: 2,
            });
          },
          { timeout: 12_000 },
        );
        expect(noticeAttempts).toHaveLength(2);
        expect(noticeAttempts[1]).toEqual(noticeAttempts[0]);
        expect(noticeAttempts[1]).toMatchObject({
          recipient: sender.senderBusinessId,
          biz_opaque_callback_data: wiredDraftId,
          type: "template",
          template: {
            name: templateName,
            language: { code: "pt_BR" },
            components: [
              { type: "body", parameters: [{ type: "text", text: "112" }] },
            ],
          },
        });
        const callback = signedWebhook(wiredPhone, {
          statuses: [
            {
              id: notificationId,
              status: "delivered",
              timestamp: String(Math.floor(Date.now() / 1000)),
              biz_opaque_callback_data: wiredDraftId,
            },
          ],
        });
        await post(callback);
        await post(callback);
        expect(await notice()).toMatchObject({
          state: "DELIVERED",
          attempts: 2,
        });
        expect(await step("opt-out", "Parar avisos")).toContain("desativados");
        const preference =
          await database.whatsAppClosurePreference.findUniqueOrThrow({
            where: { scopeKey: wiredScope },
          });
        expect(preference.revokedAt).toBeInstanceOf(Date);
        expect(createCalls).toBe(1);
        expect(noticeAttempts).toHaveLength(2);
      } finally {
        await wiredApp.close();
        vi.unstubAllGlobals();
        mailer.mockRestore();
      }
    } finally {
      await app.close();
      await Promise.all([database.$disconnect(), inspector.$disconnect()]);
    }
  });
}, 120_000);
