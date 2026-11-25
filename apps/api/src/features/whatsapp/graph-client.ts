import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WhatsAppOutboundConfig } from "../../config.js";
import {
  providerIdentifier,
  type OutboundPayload,
} from "./outbound-contract.js";

export type SendOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "throttled"; code: number; retryAfterMs: number }
  | { kind: "rejected"; code: number }
  | { kind: "uncertain" };

export type SendReply = (
  id: string,
  payload: OutboundPayload,
  signal: AbortSignal,
) => Promise<SendOutcome>;

const successSchema = Type.Object({
  messages: Type.Array(Type.Object({ id: providerIdentifier }), {
    minItems: 1,
    maxItems: 1,
  }),
});
const errorSchema = Type.Object({
  error: Type.Object({
    code: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  }),
});
// Explicit rate-limit rejections identify requests that Meta did not accept.
const throttleCodes = new Set([4, 130429, 131056]);

function retryAfter(header: string | null): number {
  if (!header) return 0;
  if (/^[0-9]+$/.test(header))
    return Math.min(2_147_483_647, Number(header) * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

function messageRequest(id: string, payload: OutboundPayload) {
  const { recipient, content } = payload;
  const address =
    recipient.kind === "phone"
      ? { to: recipient.value }
      : { recipient: recipient.value };
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...address,
    biz_opaque_callback_data: id,
    ...(content.type === "text"
      ? { type: "text", text: { body: content.body, preview_url: false } }
      : {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: content.body },
            action: {
              buttons: content.buttons.map((reply) => ({
                type: "reply",
                reply,
              })),
            },
          },
        }),
  };
}

export function createWhatsAppGraphSender(
  phoneNumberId: string,
  config: WhatsAppOutboundConfig,
  fetchMessage = fetch,
): SendReply {
  const url =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/" +
    phoneNumberId +
    "/messages";
  return async (id, payload, signal) => {
    try {
      const response = await fetchMessage(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.accessToken,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
        body: JSON.stringify(messageRequest(id, payload)),
      });
      const body: unknown = await response.json();
      if (response.status === 408) return { kind: "uncertain" };
      if (response.ok && Value.Check(successSchema, body))
        return { kind: "accepted", messageId: body.messages[0].id };
      if (
        response.status >= 400 &&
        response.status < 500 &&
        Value.Check(errorSchema, body)
      ) {
        const { code } = body.error;
        if (throttleCodes.has(code))
          return {
            kind: "throttled",
            code,
            retryAfterMs: retryAfter(response.headers.get("retry-after")),
          };
        return { kind: "rejected", code };
      }
      return { kind: "uncertain" };
    } catch {
      return { kind: "uncertain" };
    }
  };
}
