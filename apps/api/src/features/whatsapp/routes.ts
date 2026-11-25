import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { WhatsAppWebhookConfig } from "../../config.js";
import { coreErrors, errorResponder } from "../../errors.js";
import type { AppInstance } from "../../module.js";
import { currentTraceId } from "../../request-context.js";
import {
  webhookErrors,
  webhookOperations,
  webhookVerificationQuery,
} from "./contracts.js";
import { readWebhookEvents, type WebhookEvents } from "./inbound.js";

type PersistEvents = (events: WebhookEvents) => Promise<void>;
const [verification, delivery] = webhookOperations;
const respond = errorResponder({ ...coreErrors, ...webhookErrors });
const maxWebhookBytes = 3 * 1024 * 1024;

export function registerWhatsAppWebhook(
  app: AppInstance,
  config: WhatsAppWebhookConfig,
  persist: PersistEvents,
): void {
  const verificationTokenHash = createHash("sha256")
    .update(config.verifyToken)
    .digest();
  void app.register((scope, _options, done) => {
    // Preserve the original bytes only in the webhook encapsulation scope.
    scope.removeContentTypeParser("text/plain");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    scope.setErrorHandler((error, request, reply) => {
      const fastifyCode =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      const code =
        fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? "WHATSAPP_WEBHOOK_TOO_LARGE"
          : fastifyCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
            ? "WHATSAPP_WEBHOOK_UNSUPPORTED_MEDIA_TYPE"
            : undefined;
      if (!code) throw error;
      const failure = respond(code, request.id, currentTraceId());
      void reply.code(failure.status).send(failure.body);
    });

    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.get(
      verification.url,
      {
        schema: {
          querystring: webhookVerificationQuery,
          response: verification.schema.response,
        },
      },
      async (request, reply) => {
        const tokenHash = createHash("sha256")
          .update(request.query["hub.verify_token"])
          .digest();
        if (!timingSafeEqual(tokenHash, verificationTokenHash)) {
          const failure = respond(
            "WHATSAPP_WEBHOOK_UNVERIFIED",
            request.id,
            currentTraceId(),
          );
          return reply.code(403).send(failure.body);
        }
        return reply.type("text/plain").send(request.query["hub.challenge"]);
      },
    );

    routes.post(
      delivery.url,
      {
        bodyLimit: maxWebhookBytes,
        // The signed byte buffer is parsed only after authentication.
        schema: { response: delivery.schema.response },
      },
      async (request, reply) => {
        const signature = request.headers["x-hub-signature-256"];
        const body = request.body;
        if (
          !Buffer.isBuffer(body) ||
          typeof signature !== "string" ||
          !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
          !timingSafeEqual(
            createHmac("sha256", config.appSecret).update(body).digest(),
            Buffer.from(signature.slice(7), "hex"),
          )
        ) {
          const failure = respond(
            "WHATSAPP_WEBHOOK_UNVERIFIED",
            request.id,
            currentTraceId(),
          );
          return reply.code(403).send(failure.body);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
        } catch {
          const failure = respond(
            "VALIDATION_FAILED",
            request.id,
            currentTraceId(),
          );
          return reply.code(400).send(failure.body);
        }
        const events = readWebhookEvents(payload, config.phoneNumberId);
        if (!events) {
          const failure = respond(
            "VALIDATION_FAILED",
            request.id,
            currentTraceId(),
          );
          return reply.code(400).send(failure.body);
        }

        if (events.messages.length > 0 || events.statuses.length > 0)
          await persist(events);
        return reply.type("text/plain").send("EVENT_RECEIVED");
      },
    );
    done();
  });
}
