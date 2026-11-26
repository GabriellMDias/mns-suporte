import { randomUUID } from "node:crypto";
import type { Database } from "../../database.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { ClosurePreferenceAction } from "./conversation.js";
import {
  recipientIdentity,
  type WhatsAppRecipient,
} from "./outbound-contract.js";

export async function saveClosurePreference(
  tx: Pick<Database, "whatsAppClosurePreference">,
  scopeKey: string,
  recipient: WhatsAppRecipient,
  action: ClosurePreferenceAction,
  now: Date,
  requesterId?: number,
): Promise<void> {
  const preferences = tx.whatsAppClosurePreference;
  if (action === "disable") {
    await preferences.updateMany({
      where: { scopeKey, revokedAt: null },
      data: { revokedAt: now, recipient: Prisma.DbNull },
    });
    if (requesterId !== undefined)
      await preferences.createMany({
        data: {
          scopeKey,
          glpiUserId: requesterId,
          grantId: randomUUID(),
          grantedAt: now,
          revokedAt: now,
        },
        skipDuplicates: true,
      });
    return;
  }
  const active = await preferences.findUnique({
    where: { scopeKey, revokedAt: null, glpiUserId: action.requesterId },
    select: { grantId: true },
  });
  if (active) return;
  const grant = {
    glpiUserId: action.requesterId,
    grantId: randomUUID(),
    recipient,
    grantedAt: now,
    revokedAt: null,
  };
  await preferences.upsert({
    where: { scopeKey },
    create: { scopeKey, ...grant },
    update: grant,
  });
}

export const customerWindowMs = 24 * 60 * 60 * 1000;
export const closurePollIntervalMs = 5 * 60_000;

export async function readCustomerWindow(
  tx: Pick<Database, "whatsAppInboundMessage">,
  businessPhoneId: string,
  recipient: WhatsAppRecipient,
  now: Date,
): Promise<Date | undefined> {
  const cutoff = new Date(now.getTime() - customerWindowMs);
  const latest = await tx.whatsAppInboundMessage.findFirst({
    where: {
      ...recipientIdentity(businessPhoneId, recipient),
      occurredAt: { gt: cutoff, lte: now },
      receivedAt: { lte: now },
    },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true, receivedAt: true },
  });
  if (!latest) return undefined;
  const endsAt = new Date(
    Math.min(latest.occurredAt.getTime(), latest.receivedAt.getTime()) +
      customerWindowMs,
  );
  return endsAt > now ? endsAt : undefined;
}
