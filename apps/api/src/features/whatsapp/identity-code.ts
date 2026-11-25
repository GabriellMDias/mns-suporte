import { createHash, createHmac, randomBytes } from "node:crypto";

export type MessengerIdentity = Readonly<{
  businessPhoneId: string;
  senderBusinessId?: string | null;
  senderPhone?: string | null;
}>;

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codePattern = "MNS-[" + alphabet + "]{8}";
const exactCode = new RegExp("^" + codePattern + "$", "i");
const mentionedCode = new RegExp(codePattern, "gi");

export function scopeOf(messenger: MessengerIdentity): string | undefined {
  const address = messenger.senderBusinessId
    ? ["business", messenger.senderBusinessId]
    : messenger.senderPhone
      ? ["phone", messenger.senderPhone]
      : undefined;
  if (!address) return undefined;
  return createHash("sha256")
    .update(JSON.stringify([messenger.businessPhoneId, address]))
    .digest("hex");
}

export function newIdentityCode(): string {
  const characters = Array.from(randomBytes(8), (byte) => alphabet[byte & 31]);
  return "MNS-" + characters.join("");
}

export function identityCodeDigest(
  secret: string,
  scope: string,
  code: string,
): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("identity-code:" + scope + ":" + code.toUpperCase())
    .digest("hex");
}

export function protectIdentityCode(
  body: string,
  messenger: MessengerIdentity,
  secret: string | undefined,
):
  | { type: "text"; body: string }
  | { type: "verification_code"; digest?: string } {
  const candidate = body.trim();
  if (exactCode.test(candidate)) {
    const scope = scopeOf(messenger);
    return {
      type: "verification_code",
      ...(secret && scope
        ? { digest: identityCodeDigest(secret, scope, candidate) }
        : {}),
    };
  }
  return {
    type: "text",
    body: body.replace(mentionedCode, "[código removido]"),
  };
}
