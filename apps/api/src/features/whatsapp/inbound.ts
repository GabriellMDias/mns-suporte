import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { webhookEnvelope } from "./contracts.js";

const identifier = Type.String({ pattern: "^[A-Za-z0-9_.=:~+/\\-]{1,512}$" });
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
});
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

export function readInboundMessages(
  payload: unknown,
  businessPhoneId: string,
): InboundMessage[] | undefined {
  if (!Value.Check(webhookEnvelope, payload)) return undefined;
  if (payload.object !== "whatsapp_business_account") return [];

  const messages: InboundMessage[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (
        change.field !== "messages" ||
        !Value.Check(messageChange, change.value)
      )
        continue;
      if (change.value.metadata.phone_number_id !== businessPhoneId) continue;
      for (const message of change.value.messages ?? []) {
        if (
          !Value.Check(messageSchema, message) ||
          (!message.from && !message.from_user_id)
        )
          continue;
        messages.push({
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
  return messages;
}
