import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const replyText = Type.String({ minLength: 1, maxLength: 4096 });
const replyButton = Type.Object(
  {
    id: Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,256}$" }),
    title: Type.String({ minLength: 1, maxLength: 20 }),
  },
  { additionalProperties: false },
);

export const providerIdentifier = Type.String({
  pattern: "^[A-Za-z0-9_.=:~+/\\-]{1,512}$",
});
export const deliveryIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
});

const recipientSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("phone"),
      value: Type.String({ pattern: "^[1-9][0-9]{5,14}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("business_id"), value: providerIdentifier },
    { additionalProperties: false },
  ),
]);
const glpiIdentifier = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

const payloadSchema = Type.Object(
  {
    recipient: recipientSchema,
    content: Type.Union([
      Type.Object(
        { type: Type.Literal("text"), body: replyText },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("buttons"),
          body: Type.String({ minLength: 1, maxLength: 1024 }),
          buttons: Type.Array(replyButton, { minItems: 1, maxItems: 3 }),
        },
        { additionalProperties: false },
      ),
    ]),
    requiredGlpiUserId: Type.Optional(glpiIdentifier),
    closure: Type.Optional(
      Type.Object(
        {
          consentId: deliveryIdSchema,
          ticketId: glpiIdentifier,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type OutboundPayload = Static<typeof payloadSchema>;
export type WhatsAppRecipient = OutboundPayload["recipient"];

export function readRecipient(value: unknown): WhatsAppRecipient | undefined {
  return Value.Check(recipientSchema, value) ? value : undefined;
}

export function recipientIdentity(
  businessPhoneId: string,
  recipient: WhatsAppRecipient,
) {
  return {
    businessPhoneId,
    ...(recipient.kind === "business_id"
      ? { senderBusinessId: recipient.value }
      : { senderBusinessId: null, senderPhone: recipient.value }),
  };
}

export function isOutboundPayload(
  payload: unknown,
): payload is OutboundPayload {
  if (!Value.Check(payloadSchema, payload)) return false;
  if (
    payload.closure &&
    (!payload.requiredGlpiUserId || payload.content.type !== "text")
  )
    return false;
  const validText = (text: string) =>
    Boolean(text.trim()) && text.isWellFormed() && !text.includes("\u0000");
  if (!validText(payload.content.body)) return false;
  if (payload.content.type === "text") return true;
  const { buttons } = payload.content;
  return (
    buttons.every(({ title }) => validText(title) && title === title.trim()) &&
    new Set(buttons.map(({ id }) => id)).size === buttons.length &&
    new Set(buttons.map(({ title }) => title)).size === buttons.length
  );
}
