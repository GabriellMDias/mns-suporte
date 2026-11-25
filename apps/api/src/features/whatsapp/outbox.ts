import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { Database } from "../../database.js";
import type { WhatsAppOutboundState } from "../../generated/prisma/client.js";
import type { SendReply } from "./graph-client.js";
import { scopeOf } from "./identity-code.js";
import type { DeliveryStatus } from "./inbound.js";
import {
  deliveryIdSchema,
  isOutboundPayload,
  type OutboundPayload,
} from "./outbound-contract.js";

type OutboxStore = Pick<Database, "whatsAppOutboundMessage">;
const retryLimit = 4;
const indeterminateAfterMs = 30_000;

export async function enqueueWhatsAppReply(
  store: OutboxStore,
  input: {
    id: string;
    businessPhoneId: string;
    expiresAt: Date;
    payload: OutboundPayload;
  },
): Promise<void> {
  if (
    !Value.Check(deliveryIdSchema, input.id) ||
    !/^[0-9]{1,20}$/.test(input.businessPhoneId) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    !isOutboundPayload(input.payload)
  )
    throw new Error("Invalid WhatsApp reply intent");

  const result = await store.whatsAppOutboundMessage.createMany({
    data: input,
    skipDuplicates: true,
  });
  if (result.count === 1) return;
  const existing = await store.whatsAppOutboundMessage.findUniqueOrThrow({
    where: { id: input.id },
  });
  if (
    existing.businessPhoneId !== input.businessPhoneId ||
    existing.expiresAt.getTime() !== input.expiresAt.getTime() ||
    !isDeepStrictEqual(existing.payload, input.payload)
  )
    throw new Error("Conflicting WhatsApp reply intent");
}

export async function dispatchNextWhatsAppReply(
  store: OutboxStore & Pick<Database, "whatsAppVerifiedIdentity">,
  businessPhoneId: string,
  send: SendReply,
  signal: AbortSignal,
  clock = () => new Date(),
): Promise<boolean> {
  const queue = store.whatsAppOutboundMessage;
  const now = clock();
  // An abandoned claim may have reached Meta. Recover without sending again.
  await queue.updateMany({
    where: {
      businessPhoneId,
      state: "SENDING",
      attemptStartedAt: { lte: new Date(now.getTime() - indeterminateAfterMs) },
    },
    data: { state: "UNCERTAIN" },
  });
  await queue.updateMany({
    where: { businessPhoneId, state: "PENDING", expiresAt: { lte: now } },
    data: { state: "EXPIRED" },
  });
  if (signal.aborted) return false;
  const candidate = await queue.findFirst({
    where: {
      businessPhoneId,
      state: "PENDING",
      availableAt: { lte: now },
      expiresAt: { gt: now },
    },
    orderBy: [{ availableAt: "asc" }, { id: "asc" }],
  });
  if (!candidate) return false;

  const { id, payload, expiresAt } = candidate;
  const attempt = candidate.attempts + 1;
  const claim = await queue.updateMany({
    where: { id, state: "PENDING", attempts: candidate.attempts },
    data: {
      state: "SENDING",
      attemptStartedAt: now,
      attempts: attempt,
      providerErrorCode: null,
    },
  });
  if (claim.count === 0) return true;

  const finalizable = {
    id,
    attempts: attempt,
    state: { in: ["SENDING", "UNCERTAIN"] satisfies WhatsAppOutboundState[] },
  };
  if (!isOutboundPayload(payload)) {
    await queue.updateMany({ where: finalizable, data: { state: "FAILED" } });
    return true;
  }
  if (expiresAt <= clock()) {
    await queue.updateMany({ where: finalizable, data: { state: "EXPIRED" } });
    return true;
  }
  if (payload.requiredGlpiUserId !== undefined) {
    const { recipient } = payload;
    const scopeKey = scopeOf({
      businessPhoneId,
      ...(recipient.kind === "business_id"
        ? { senderBusinessId: recipient.value }
        : { senderPhone: recipient.value }),
    });
    const valid =
      scopeKey &&
      (await store.whatsAppVerifiedIdentity.findUnique({
        where: {
          scopeKey,
          glpiUserId: payload.requiredGlpiUserId,
          expiresAt: { gt: clock() },
        },
        select: { scopeKey: true },
      }));
    if (!valid || expiresAt <= clock()) {
      await queue.updateMany({
        where: finalizable,
        data: { state: "EXPIRED" },
      });
      return true;
    }
  }

  const outcome = await send(id, payload, signal);
  switch (outcome.kind) {
    case "accepted":
      await queue.updateMany({
        where: finalizable,
        data: { state: "ACCEPTED", providerMessageId: outcome.messageId },
      });
      break;
    case "uncertain":
      await queue.updateMany({
        where: finalizable,
        data: { state: "UNCERTAIN" },
      });
      break;
    case "rejected":
      await queue.updateMany({
        where: finalizable,
        data: { state: "FAILED", providerErrorCode: outcome.code },
      });
      break;
    case "throttled": {
      const delay = Math.max(outcome.retryAfterMs, 2000 * 2 ** (attempt - 1));
      const availableAt = new Date(clock().getTime() + delay);
      const canRetry = attempt < retryLimit && availableAt < expiresAt;
      await queue.updateMany({
        where: finalizable,
        data: {
          ...(canRetry
            ? { state: "PENDING", availableAt }
            : { state: "FAILED" }),
          providerErrorCode: outcome.code,
        },
      });
      break;
    }
  }
  return true;
}

// Delivery evidence supersedes local uncertainty and late failure. Weaker and
// repeated webhooks leave the first observation of the current state intact.
const awaitingDelivery: WhatsAppOutboundState[] = [
  "PENDING",
  "SENDING",
  "ACCEPTED",
  "UNCERTAIN",
  "EXPIRED",
];
const predecessors: Record<DeliveryStatus["state"], WhatsAppOutboundState[]> = {
  SENT: awaitingDelivery,
  FAILED: [...awaitingDelivery, "SENT"],
  DELIVERED: [...awaitingDelivery, "SENT", "FAILED"],
  READ: [...awaitingDelivery, "SENT", "FAILED", "DELIVERED"],
};

export async function applyWhatsAppDeliveryStatuses(
  store: OutboxStore,
  businessPhoneId: string,
  statuses: readonly DeliveryStatus[],
): Promise<void> {
  const ordered = [...statuses].sort((left, right) =>
    (left.callbackId ?? left.messageId).localeCompare(
      right.callbackId ?? right.messageId,
      "en",
    ),
  );
  for (const {
    messageId,
    callbackId,
    state,
    occurredAt,
    errorCode,
  } of ordered) {
    await store.whatsAppOutboundMessage.updateMany({
      where: {
        businessPhoneId,
        attempts: { gt: 0 },
        state: { in: predecessors[state] },
        ...(callbackId
          ? {
              id: callbackId,
              OR: [
                { providerMessageId: messageId },
                { providerMessageId: null },
              ],
            }
          : { providerMessageId: messageId }),
      },
      data: {
        state,
        providerMessageId: messageId,
        deliveryStatusAt: occurredAt,
        providerErrorCode: state === "FAILED" ? (errorCode ?? null) : null,
      },
    });
  }
}
