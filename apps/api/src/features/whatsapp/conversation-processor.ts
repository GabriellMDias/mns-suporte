import { randomUUID } from "node:crypto";
import type { Database } from "../../database.js";
import type {
  WhatsAppConversationAction,
  WhatsAppInboundMessage,
} from "../../generated/prisma/client.js";
import {
  finishVerification,
  readConversationInput,
  readConversationState,
  routeConversation,
  type Conversation,
  type ConversationMove,
} from "./conversation.js";
import { scopeOf } from "./identity-code.js";
import type { createIdentityVerification } from "./identity-service.js";
import type { OutboundPayload } from "./outbound-contract.js";
import { enqueueWhatsAppReply } from "./outbox.js";

type Transaction = Pick<
  Database,
  | "whatsAppVerifiedIdentity"
  | "whatsAppConversation"
  | "whatsAppInboundMessage"
  | "whatsAppOutboundMessage"
  | "whatsAppTroubleshootingFeedback"
>;
type Identity = Pick<
  ReturnType<typeof createIdentityVerification>,
  "requestVerification" | "confirmVerification"
>;
type ReplyAddress = {
  scopeKey: string;
  recipient: OutboundPayload["recipient"];
  expiresAt: Date;
};
type Claim = {
  kind: "identity";
  action: WhatsAppConversationAction;
  message: WhatsAppInboundMessage;
  address: ReplyAddress;
  id: string;
};
type ProcessResult = Claim | { kind: "idle" | "processed" };

const claimLifetime = 45_000;
const customerWindow = 24 * 60 * 60 * 1000;
const cleared = {
  conversationClaimId: null,
  conversationClaimUntil: null,
  conversationAction: null,
};

function resolveAddress(
  message: WhatsAppInboundMessage,
  now: Date,
): ReplyAddress | undefined {
  const scopeKey = scopeOf(message);
  if (!scopeKey) return undefined;
  const recipient = message.senderBusinessId
    ? { kind: "business_id" as const, value: message.senderBusinessId }
    : message.senderPhone && /^[1-9][0-9]{5,14}$/.test(message.senderPhone)
      ? { kind: "phone" as const, value: message.senderPhone }
      : undefined;
  if (!recipient) return undefined;
  const expiresAt = new Date(
    Math.min(message.occurredAt.getTime(), now.getTime()) + customerWindow,
  );
  return expiresAt > now ? { scopeKey, recipient, expiresAt } : undefined;
}

async function verifiedUser(
  tx: Transaction,
  scopeKey: string,
  now: Date,
): Promise<number | undefined> {
  const link = await tx.whatsAppVerifiedIdentity.findUnique({
    where: { scopeKey, expiresAt: { gt: now } },
    select: { glpiUserId: true },
  });
  return link ? Number(link.glpiUserId) : undefined;
}

async function stateFor(
  tx: Transaction,
  scopeKey: string,
): Promise<Conversation> {
  const row = await tx.whatsAppConversation.findUnique({
    where: { scopeKey },
    select: { state: true },
  });
  return readConversationState(row?.state);
}

async function applyMove(
  tx: Transaction,
  address: ReplyAddress,
  businessPhoneId: string,
  move: ConversationMove,
  now: Date,
) {
  const next = { state: move.state, updatedAt: now };
  await tx.whatsAppConversation.upsert({
    where: { scopeKey: address.scopeKey },
    create: { scopeKey: address.scopeKey, ...next },
    update: next,
  });
  if (move.feedback)
    await tx.whatsAppTroubleshootingFeedback.createMany({
      data: { ...move.feedback, recordedAt: now },
      skipDuplicates: true,
    });
  if (move.reply && address.expiresAt > now)
    await enqueueWhatsAppReply(tx, {
      id: randomUUID(),
      businessPhoneId,
      expiresAt: address.expiresAt,
      payload: { recipient: address.recipient, content: move.reply },
    });
}

export function createConversationProcessor(
  store: Database,
  options: { businessPhoneId: string; supportContact: string },
  identity: Identity,
  clock = () => new Date(),
) {
  const { businessPhoneId, supportContact } = options;

  async function prepare(): Promise<ProcessResult> {
    return store.$transaction(async (tx) => {
      // A short lock serializes inbox order per business number across API replicas.
      const [control] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${"conversation:" + businessPhoneId}, 0)) AS acquired
      `;
      if (!control.acquired) return { kind: "idle" };

      const now = clock();
      const inbox = tx.whatsAppInboundMessage;
      const message = await inbox.findFirst({
        where: { businessPhoneId, conversationProcessedAt: null },
        orderBy: [
          { receivedAt: "asc" },
          { occurredAt: "asc" },
          { messageId: "asc" },
        ],
      });
      if (
        !message ||
        (message.conversationClaimUntil && message.conversationClaimUntil > now)
      )
        return { kind: "idle" };

      const where = { messageId: message.messageId };
      const address = resolveAddress(message, now);
      const input = readConversationInput(message.content);
      if (!address || !input) {
        await inbox.update({
          where,
          data: { ...cleared, conversationProcessedAt: now },
        });
        return { kind: "processed" };
      }
      let action = message.conversationAction;
      if (!action) {
        const state = await stateFor(tx, address.scopeKey);
        const userId = await verifiedUser(tx, address.scopeKey, now);
        const move = routeConversation(state, input, {
          userId,
          supportContact,
          draftId: randomUUID(),
          now,
        });
        await applyMove(tx, address, businessPhoneId, move, now);
        action =
          move.action === "request_code"
            ? "REQUEST_CODE"
            : move.action === "confirm_code"
              ? "CONFIRM_CODE"
              : null;
      }
      if (!action) {
        await inbox.update({ where, data: { conversationProcessedAt: now } });
        return { kind: "processed" };
      }
      const id = randomUUID();
      await inbox.update({
        where,
        data: {
          conversationAction: action,
          conversationClaimId: id,
          conversationClaimUntil: new Date(now.getTime() + claimLifetime),
        },
      });
      return { kind: "identity", action, message, address, id };
    });
  }

  async function complete(claim: Claim): Promise<void> {
    const { address, message, action } = claim;
    const input = readConversationInput(message.content);
    if (action === "REQUEST_CODE" && input?.type === "text")
      await identity.requestVerification(
        message,
        message.messageId,
        input.body,
      );
    if (action === "CONFIRM_CODE" && input?.type === "verification_code")
      await identity.confirmVerification(
        message,
        message.messageId,
        input.digest,
      );

    await store.$transaction(async (tx) => {
      const now = clock();
      const accepted = await tx.whatsAppInboundMessage.updateMany({
        where: {
          messageId: message.messageId,
          conversationClaimId: claim.id,
          conversationProcessedAt: null,
        },
        data: { ...cleared, conversationProcessedAt: now },
      });
      if (accepted.count !== 1 || action !== "CONFIRM_CODE") return;
      // If the worker restarted after consuming the code, the durable link
      // is the source of truth for the response.
      const userId = await verifiedUser(tx, address.scopeKey, now);
      const state = await stateFor(tx, address.scopeKey);
      await applyMove(
        tx,
        address,
        businessPhoneId,
        finishVerification(state, userId),
        now,
      );
    });
  }

  return async (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false;
    const next = await prepare();
    if (next.kind === "identity" && !signal.aborted) await complete(next);
    return next.kind !== "idle";
  };
}
