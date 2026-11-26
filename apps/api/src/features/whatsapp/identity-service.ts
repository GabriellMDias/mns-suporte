import { createHash, createHmac } from "node:crypto";
import { normalizeEmail } from "../../email-address.js";
import {
  identityCodeDigest,
  newIdentityCode,
  scopeOf,
  type MessengerIdentity,
} from "./identity-code.js";

const hour = 60 * 60 * 1000;
const codeLifetime = 10 * 60 * 1000;
const linkLifetime = 30 * 24 * hour;

type DirectoryLookup = (
  email: string,
) => Promise<
  | { kind: "found"; userId: number }
  | { kind: "not_found" | "ambiguous" | "invalid_email" | "unavailable" }
>;
type CodeSender = (email: string, code: string) => Promise<void>;
type DirectoryPhoneMatch = (phone: string, userId: number) => Promise<boolean>;
type Confirmation =
  { kind: "verified"; glpiUserId: number } | { kind: "invalid" | "duplicate" };
type Receipt = { scopeKey: string; eventKey: string; now: Date };
type LinkProof = Receipt & { linkExpiresAt: Date; phoneLastFour?: string };

export type IdentityRepository = {
  reserve(
    input: Receipt & {
      mailboxKey?: string;
      windowStart: Date;
      expiresAt: Date;
      maximumStarts: number;
      maximumAttempts: number;
    },
  ): Promise<boolean>;
  prepare(input: {
    eventKey: string;
    now: Date;
    userId: number;
    digest: string;
  }): Promise<boolean>;
  linkDirectoryPhone(input: LinkProof & { userId: number }): Promise<boolean>;
  confirm(input: LinkProof & { digest: string }): Promise<Confirmation>;
  findVerifiedUser(scopeKey: string, now: Date): Promise<number | undefined>;
};

function identityEventKey(scope: string, eventId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([scope, eventId]))
    .digest("hex");
}

function phoneSuffix(messenger: MessengerIdentity) {
  const phone = messenger.senderPhone;
  return phone && /^[1-9][0-9]{5,14}$/.test(phone)
    ? phone.slice(-4)
    : undefined;
}

export function createIdentityVerification(
  repository: IdentityRepository,
  config: { codeSecret: string; allowedEmailDomains: readonly string[] },
  findUser: DirectoryLookup,
  sendCode: CodeSender,
  clock = () => new Date(),
  matchesDirectoryPhone?: DirectoryPhoneMatch,
) {
  const domains = new Set(config.allowedEmailDomains);
  return {
    async requestVerification(
      messenger: MessengerIdentity,
      inboundId: string,
      submitted: string,
    ): Promise<void> {
      const scopeKey = scopeOf(messenger);
      if (!scopeKey) return;
      const email = normalizeEmail(submitted);
      const eligibleEmail =
        email && domains.has(email.split("@")[1]) ? email : undefined;
      const mailboxKey = eligibleEmail
        ? createHmac("sha256", Buffer.from(config.codeSecret, "hex"))
            .update("identity-mailbox:" + eligibleEmail)
            .digest("hex")
        : undefined;
      const eventKey = identityEventKey(scopeKey, inboundId);
      const now = clock();
      const reserved = await repository.reserve({
        scopeKey,
        eventKey,
        now,
        mailboxKey,
        windowStart: new Date(now.getTime() - hour),
        expiresAt: new Date(now.getTime() + codeLifetime),
        maximumStarts: 3,
        maximumAttempts: 5,
      });
      if (!reserved || !eligibleEmail) return;

      const user = await findUser(eligibleEmail);
      if (
        user.kind !== "found" ||
        !Number.isSafeInteger(user.userId) ||
        user.userId <= 0
      )
        return;
      if (
        messenger.senderPhone &&
        (await matchesDirectoryPhone?.(messenger.senderPhone, user.userId))
      ) {
        const checkedAt = clock();
        const linked = await repository.linkDirectoryPhone({
          scopeKey,
          eventKey,
          now: checkedAt,
          userId: user.userId,
          linkExpiresAt: new Date(+checkedAt + linkLifetime),
          phoneLastFour: phoneSuffix(messenger),
        });
        if (linked) return;
      }
      const code = newIdentityCode();
      const prepared = await repository.prepare({
        eventKey,
        now: clock(),
        userId: user.userId,
        digest: identityCodeDigest(config.codeSecret, scopeKey, code),
      });
      if (prepared) {
        // One reservation permits one submission. A lost SMTP response may still deliver mail.
        await sendCode(eligibleEmail, code);
      }
    },

    async confirmVerification(
      messenger: MessengerIdentity,
      inboundId: string,
      digest: string | undefined,
    ): Promise<Confirmation> {
      const scopeKey = scopeOf(messenger);
      if (!scopeKey || !digest || !/^[a-f0-9]{64}$/.test(digest))
        return { kind: "invalid" };
      const now = clock();
      return repository.confirm({
        scopeKey,
        eventKey: identityEventKey(scopeKey, inboundId),
        now,
        digest,
        phoneLastFour: phoneSuffix(messenger),
        linkExpiresAt: new Date(now.getTime() + linkLifetime),
      });
    },

    async findVerifiedGlpiUser(
      messenger: MessengerIdentity,
    ): Promise<number | undefined> {
      const scopeKey = scopeOf(messenger);
      return scopeKey
        ? repository.findVerifiedUser(scopeKey, clock())
        : undefined;
    },
  };
}
