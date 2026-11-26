import { Prisma } from "../../generated/prisma/client.js";
import type { Database } from "../../database.js";
import { lockIdentityScope } from "./identity-repository.js";

const pageSize = 20;

export async function listIdentityLinks(
  store: Database,
  glpiUserId: number,
  after: string | undefined,
  now: Date,
) {
  const rows = await store.whatsAppVerifiedIdentity.findMany({
    where: {
      glpiUserId: BigInt(glpiUserId),
      ...(after ? { linkId: { gt: after } } : {}),
    },
    orderBy: { linkId: "asc" },
    take: pageSize + 1,
    select: {
      linkId: true,
      phoneLastFour: true,
      verifiedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  const page = rows.slice(0, pageSize);
  return {
    items: page.map((link) => ({
      id: link.linkId,
      phoneLastFour: link.phoneLastFour,
      verifiedAt: link.verifiedAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
      status: link.revokedAt
        ? ("revoked" as const)
        : link.expiresAt <= now
          ? ("expired" as const)
          : ("active" as const),
    })),
    next: rows.length > pageSize ? page.at(-1)!.linkId : null,
  };
}

export async function revokeIdentityLink(
  store: Database,
  linkId: string,
  principalId: string,
  clock = () => new Date(),
) {
  return store.$transaction(async (tx) => {
    const target = await tx.whatsAppVerifiedIdentity.findUnique({
      where: { linkId },
      select: { scopeKey: true },
    });
    if (!target) return null;
    await lockIdentityScope(tx, target.scopeKey);
    // Re-verifying issues a new identifier. A stale admin page cannot revoke the replacement.
    const link = await tx.whatsAppVerifiedIdentity.findUnique({
      where: { linkId, scopeKey: target.scopeKey },
      select: { revokedAt: true, verifiedAt: true },
    });
    if (!link) return null;
    if (link.revokedAt)
      return { changed: false, revokedAt: link.revokedAt.toISOString() };
    const revokedAt = new Date(Math.max(+clock(), +link.verifiedAt));
    await tx.whatsAppVerifiedIdentity.update({
      where: { linkId },
      data: { revokedAt, revokedBy: principalId },
    });
    await tx.whatsAppIdentityEvent.updateMany({
      where: { scopeKey: target.scopeKey, active: true },
      data: { active: false, glpiUserId: null, codeDigest: null },
    });
    await tx.whatsAppClosurePreference.updateMany({
      where: { scopeKey: target.scopeKey, revokedAt: null },
      data: { revokedAt, recipient: Prisma.DbNull },
    });
    return { changed: true, revokedAt: revokedAt.toISOString() };
  });
}
