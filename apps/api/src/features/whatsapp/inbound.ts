import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { webhookEnvelope } from "./contracts.js";

import {
  deliveryIdSchema,
  providerIdentifier as identifier,
} from "./outbound-contract.js";
const phone = Type.String({ pattern: "^[0-9]{1,20}$" });
const media = Type.Object({
  id: identifier,
  caption: Type.Optional(Type.String({ maxLength: 4096 })),
  filename: Type.Optional(Type.String({ maxLength: 1024 })),
  mime_type: Type.Optional(Type.String({ maxLength: 255 })),
});
const reply = Type.Object({ id: identifier });
const base = {
  id: identifier,
  timestamp: Type.String({ pattern: "^[0-9]{1,10}$" }),
  from: Type.Optional(phone),
  from_user_id: Type.Optional(identifier),
};
const messageSchema = Type.Union([
  Type.Object({
    ...base,
    type: Type.Literal("text"),
    text: Type.Object({ body: Type.String({ maxLength: 16384 }) }),
  }),
  Type.Object({ ...base, type: Type.Literal("image"), image: media }),
  Type.Object({ ...base, type: Type.Literal("audio"), audio: media }),
  Type.Object({ ...base, type: Type.Literal("document"), document: media }),
  Type.Object({
    ...base,
    type: Type.Literal("interactive"),
    interactive: Type.Union([
      Type.Object({ type: Type.Literal("button_reply"), button_reply: reply }),
      Type.Object({ type: Type.Literal("list_reply"), list_reply: reply }),
    ]),
  }),
  Type.Object({
    ...base,
    type: Type.Literal("button"),
    button: Type.Object({ payload: identifier }),
  }),
]);
const messageChange = Type.Object({
  messaging_product: Type.Literal("whatsapp"),
  metadata: Type.Object({ phone_number_id: phone }),
  messages: Type.Optional(Type.Array(Type.Unknown())),
  statuses: Type.Optional(Type.Array(Type.Unknown())),
});

const statusSchema = Type.Object({
  id: identifier,
  status: Type.Union([
    Type.Literal("sent"),
    Type.Literal("delivered"),
    Type.Literal("read"),
    Type.Literal("failed"),
  ]),
  timestamp: base.timestamp,
  biz_opaque_callback_data: Type.Optional(Type.String({ maxLength: 512 })),
  errors: Type.Optional(Type.Array(Type.Unknown())),
});
const providerError = Type.Object({
  code: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
});
const deliveryStates = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
} as const;
type Message = Static<typeof messageSchema>;

type Content =
  | { type: "text"; body: string }
  | { type: "reply"; replyId: string }
  | {
      type: "image" | "audio" | "document";
      mediaId: string;
      caption?: string;
      filename?: string;
      mimeType?: string;
    };

export type InboundMessage = Readonly<{
  messageId: string;
  businessPhoneId: string;
  senderBusinessId?: string;
  senderPhone?: string;
  occurredAt: Date;
  content: Content;
}>;

export type DeliveryStatus = Readonly<{
  messageId: string;
  callbackId?: string;
  state: (typeof deliveryStates)[keyof typeof deliveryStates];
  occurredAt: Date;
  errorCode?: number;
}>;

export type WebhookEvents = {
  messages: InboundMessage[];
  statuses: DeliveryStatus[];
};

function safeText(value: string): string {
  return value.toWellFormed().replaceAll("\u0000", "");
}

function normalizeContent(message: Message): Content {
  if (message.type === "text")
    return { type: "text", body: safeText(message.text.body) };
  if (message.type === "button")
    return { type: "reply", replyId: message.button.payload };
  if (message.type === "interactive") {
    const response = message.interactive;
    return {
      type: "reply",
      replyId:
        response.type === "button_reply"
          ? response.button_reply.id
          : response.list_reply.id,
    };
  }

  const file =
    message.type === "image"
      ? message.image
      : message.type === "audio"
        ? message.audio
        : message.document;
  return {
    type: message.type,
    mediaId: file.id,
    ...(file.caption === undefined ? {} : { caption: safeText(file.caption) }),
    ...(file.filename === undefined
      ? {}
      : { filename: safeText(file.filename) }),
    ...(file.mime_type === undefined
      ? {}
      : { mimeType: safeText(file.mime_type) }),
  };
}

export function readWebhookEvents(
  payload: unknown,
  businessPhoneId: string,
): WebhookEvents | undefined {
  if (!Value.Check(webhookEnvelope, payload)) return undefined;
  const events: WebhookEvents = { messages: [], statuses: [] };
  if (payload.object !== "whatsapp_business_account") return events;
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (
        change.field !== "messages" ||
        !Value.Check(messageChange, change.value)
      )
        continue;
      if (change.value.metadata.phone_number_id !== businessPhoneId) continue;
      for (const status of change.value.statuses ?? []) {
        if (!Value.Check(statusSchema, status)) continue;
        const callbackId = status.biz_opaque_callback_data;
        const error = status.errors?.[0];
        events.statuses.push({
          messageId: status.id,
          callbackId: Value.Check(deliveryIdSchema, callbackId)
            ? callbackId
            : undefined,
          state: deliveryStates[status.status],
          occurredAt: new Date(Number(status.timestamp) * 1000),
          errorCode: Value.Check(providerError, error) ? error.code : undefined,
        });
      }
      for (const message of change.value.messages ?? []) {
        if (
          !Value.Check(messageSchema, message) ||
          (!message.from && !message.from_user_id)
        )
          continue;
        events.messages.push({
          messageId: message.id,
          businessPhoneId,
          senderBusinessId: message.from_user_id,
          senderPhone: message.from,
          occurredAt: new Date(Number(message.timestamp) * 1000),
          content: normalizeContent(message),
        });
      }
    }
  }
  return events;
}
