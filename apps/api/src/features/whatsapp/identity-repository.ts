import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "../../database.js";
import type { IdentityRepository } from "./identity-service.js";

const clearChallenge = { active: false, glpiUserId: null, codeDigest: null };
type IdentityTransaction = Pick<
  Database,
  "$queryRaw" | "whatsAppIdentityEvent"
>;

export async function lockIdentityScope(
  tx: IdentityTransaction,
  scopeKey: string,
): Promise<void> {
  await lockIdentityKey(tx, "channel:" + scopeKey);
}

async function lockIdentityKey(tx: IdentityTransaction, key: string) {
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

async function saveLink(
  tx: Pick<Database, "whatsAppVerifiedIdentity">,
  {
    scopeKey,
    now,
    linkExpiresAt,
    phoneLastFour,
  }:
    | Parameters<IdentityRepository["linkDirectoryPhone"]>[0]
    | Parameters<IdentityRepository["confirm"]>[0],
  glpiUserId: bigint,
) {
  const link = {
    glpiUserId,
    verifiedAt: now,
    expiresAt: linkExpiresAt,
    linkId: randomUUID(),
    phoneLastFour: phoneLastFour ?? null,
    revokedAt: null,
    revokedBy: null,
  };
  await tx.whatsAppVerifiedIdentity.upsert({
    where: { scopeKey },
    create: { scopeKey, ...link },
    update: link,
  });
}

export function createPostgresIdentityRepository(
  store: Database,
): IdentityRepository {
  return {
    reserve: (input) =>
      store.$transaction(async (tx) => {
        const { scopeKey, eventKey, now, mailboxKey, maximumStarts } = input;
        await lockIdentityScope(tx, scopeKey);
        if (
          !(await recordReceipt(tx, eventKey, scopeKey, now, mailboxKey)) ||
          !mailboxKey
        )
          return false;
        await lockIdentityKey(tx, "mailbox:" + mailboxKey);
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

    linkDirectoryPhone: (input) =>
      store.$transaction(async (tx) => {
        const { scopeKey, eventKey, now, userId } = input;
        await lockIdentityScope(tx, scopeKey);
        const current = await tx.whatsAppVerifiedIdentity.findUnique({
          where: { scopeKey },
          select: { glpiUserId: true, revokedAt: true, expiresAt: true },
        });
        if (
          current &&
          (current.revokedAt || current.glpiUserId !== BigInt(userId))
        )
          return false;
        const reserved = await tx.whatsAppIdentityEvent.updateMany({
          where: {
            eventKey,
            scopeKey,
            active: true,
            expiresAt: { gt: now },
            codeDigest: null,
          },
          data: clearChallenge,
        });
        if (reserved.count !== 1) return false;
        if (!current || current.expiresAt <= now)
          await saveLink(tx, input, BigInt(userId));
        return true;
      }),

    confirm: (input) =>
      store.$transaction(async (tx) => {
        const { scopeKey, eventKey, now, digest } = input;
        await lockIdentityScope(tx, scopeKey);
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
        await saveLink(tx, input, glpiUserId);
        return { kind: "verified", glpiUserId: Number(glpiUserId) };
      }),

    async findVerifiedUser(scopeKey, now) {
      const link = await store.whatsAppVerifiedIdentity.findUnique({
        where: { scopeKey, expiresAt: { gt: now }, revokedAt: null },
        select: { glpiUserId: true },
      });
      return link ? Number(link.glpiUserId) : undefined;
    },
  };
}
