import { timingSafeEqual } from "node:crypto";
import type { Database } from "../../database.js";
import type { IdentityRepository } from "./identity-service.js";

const clearChallenge = { active: false, glpiUserId: null, codeDigest: null };
type IdentityTransaction = Pick<
  Database,
  "$queryRaw" | "whatsAppIdentityEvent"
>;

async function lockIdentityScope(
  tx: IdentityTransaction,
  key: string,
): Promise<void> {
  // Channel first, mailbox second. External requests happen after this transaction.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function recordReceipt(
  tx: IdentityTransaction,
  eventKey: string,
  scopeKey: string,
  createdAt: Date,
  mailboxKey?: string,
): Promise<boolean> {
  const result = await tx.whatsAppIdentityEvent.createMany({
    data: { eventKey, scopeKey, createdAt, mailboxKey },
    skipDuplicates: true,
  });
  return result.count === 1;
}

export function createPostgresIdentityRepository(
  store: Database,
): IdentityRepository {
  return {
    reserve: (input) =>
      store.$transaction(async (tx) => {
        const { scopeKey, eventKey, now, mailboxKey, maximumStarts } = input;
        await lockIdentityScope(tx, "channel:" + scopeKey);
        if (
          !(await recordReceipt(tx, eventKey, scopeKey, now, mailboxKey)) ||
          !mailboxKey
        )
          return false;
        await lockIdentityScope(tx, "mailbox:" + mailboxKey);
        const recent = {
          createdAt: { gt: input.windowStart },
          expiresAt: { not: null },
        };
        const channelStarts = await tx.whatsAppIdentityEvent.count({
          where: { ...recent, scopeKey },
        });
        const mailboxStarts = await tx.whatsAppIdentityEvent.count({
          where: { ...recent, mailboxKey },
        });
        if (channelStarts >= maximumStarts || mailboxStarts >= maximumStarts)
          return false;

        await tx.whatsAppIdentityEvent.updateMany({
          where: { scopeKey, active: true },
          data: clearChallenge,
        });
        await tx.whatsAppIdentityEvent.update({
          where: { eventKey },
          data: {
            active: true,
            attemptsLeft: input.maximumAttempts,
            expiresAt: input.expiresAt,
          },
        });
        return true;
      }),

    async prepare({ eventKey, now, userId, digest }) {
      const prepared = await store.whatsAppIdentityEvent.updateMany({
        where: {
          eventKey,
          active: true,
          expiresAt: { gt: now },
          codeDigest: null,
        },
        data: { glpiUserId: BigInt(userId), codeDigest: digest },
      });
      return prepared.count === 1;
    },

    confirm: (input) =>
      store.$transaction(async (tx) => {
        const { scopeKey, eventKey, now, digest } = input;
        await lockIdentityScope(tx, "channel:" + scopeKey);
        if (!(await recordReceipt(tx, eventKey, scopeKey, now)))
          return { kind: "duplicate" };

        const challenge = await tx.whatsAppIdentityEvent.findFirst({
          where: { scopeKey, active: true },
        });
        if (!challenge) return { kind: "invalid" };
        const where = { eventKey: challenge.eventKey };
        if (!challenge.expiresAt || challenge.expiresAt <= now) {
          await tx.whatsAppIdentityEvent.update({
            where,
            data: clearChallenge,
          });
          return { kind: "invalid" };
        }
        const glpiUserId = challenge.glpiUserId;
        const accepted =
          glpiUserId !== null &&
          challenge.codeDigest !== null &&
          timingSafeEqual(
            Buffer.from(challenge.codeDigest, "hex"),
            Buffer.from(digest, "hex"),
          );
        if (!accepted || glpiUserId === null) {
          const attemptsLeft = challenge.attemptsLeft - 1;
          await tx.whatsAppIdentityEvent.update({
            where,
            data: attemptsLeft
              ? { attemptsLeft }
              : { ...clearChallenge, attemptsLeft },
          });
          return { kind: "invalid" };
        }

        await tx.whatsAppIdentityEvent.update({ where, data: clearChallenge });
        const link = {
          glpiUserId,
          verifiedAt: now,
          expiresAt: input.linkExpiresAt,
        };
        await tx.whatsAppVerifiedIdentity.upsert({
          where: { scopeKey },
          create: { scopeKey, ...link },
          update: link,
        });
        return { kind: "verified", glpiUserId: Number(glpiUserId) };
      }),

    async findVerifiedUser(scopeKey, now) {
      const link = await store.whatsAppVerifiedIdentity.findUnique({
        where: { scopeKey, expiresAt: { gt: now } },
        select: { glpiUserId: true },
      });
      return link ? Number(link.glpiUserId) : undefined;
    },
  };
}
