import { Type } from "typebox";
import { defineErrors, errorEnvelopeSchema } from "../../errors.js";
import type { ApiOperation } from "../../module.js";

const url = "/webhooks/whatsapp";
export const webhookErrors = defineErrors({
  WHATSAPP_WEBHOOK_UNVERIFIED: {
    status: 403,
    message: "The webhook request could not be verified.",
    category: "authentication",
    retryable: false,
  },
  WHATSAPP_WEBHOOK_TOO_LARGE: {
    status: 413,
    message: "The webhook payload is too large.",
    category: "validation",
    retryable: false,
  },
  WHATSAPP_WEBHOOK_UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "The webhook must use JSON.",
    category: "validation",
    retryable: false,
  },
});

export const webhookVerificationQuery = Type.Object({
  "hub.mode": Type.Literal("subscribe"),
  "hub.verify_token": Type.String({ minLength: 1, maxLength: 512 }),
  "hub.challenge": Type.String({ minLength: 1, maxLength: 512 }),
});

export const webhookEnvelope = Type.Object({
  object: Type.String(),
  entry: Type.Array(
    Type.Object({
      changes: Type.Array(
        Type.Object({ field: Type.String(), value: Type.Unknown() }),
      ),
    }),
  ),
});

export const webhookOperations = [
  {
    method: "GET",
    url,
    operationId: "verifyWhatsAppWebhook",
    description:
      "Echo the Meta subscription challenge after verifying the callback token.",
    schema: {
      querystring: webhookVerificationQuery,
      response: {
        200: Type.String(),
        400: errorEnvelopeSchema,
        403: errorEnvelopeSchema,
      },
    },
    responseContentTypes: { 200: "text/plain" },
    expectedErrors: ["VALIDATION_FAILED", "WHATSAPP_WEBHOOK_UNVERIFIED"],
  },
  {
    method: "POST",
    url,
    operationId: "receiveWhatsAppWebhook",
    description:
      "Verify Meta's HMAC over the original request bytes. Acknowledge after supported incoming messages and tracked outbound delivery updates commit.",
    schema: {
      headers: Type.Object({
        "x-hub-signature-256": Type.String({
          pattern: "^sha256=[a-fA-F0-9]{64}$",
        }),
      }),
      body: webhookEnvelope,
      response: {
        200: Type.Literal("EVENT_RECEIVED"),
        400: errorEnvelopeSchema,
        403: errorEnvelopeSchema,
        413: errorEnvelopeSchema,
        415: errorEnvelopeSchema,
        500: errorEnvelopeSchema,
        503: errorEnvelopeSchema,
      },
    },
    responseContentTypes: { 200: "text/plain" },
    expectedErrors: [
      "VALIDATION_FAILED",
      "WHATSAPP_WEBHOOK_UNVERIFIED",
      "WHATSAPP_WEBHOOK_TOO_LARGE",
      "WHATSAPP_WEBHOOK_UNSUPPORTED_MEDIA_TYPE",
      "INTERNAL_ERROR",
      "SERVICE_UNAVAILABLE",
    ],
  },
] as const satisfies readonly ApiOperation[];
