import { randomUUID } from "node:crypto";
import type { Database } from "../../database.js";
import type {
  WhatsAppConversationAction,
  WhatsAppInboundMessage,
} from "../../generated/prisma/client.js";
import type { createGlpiClient } from "../../integrations/glpi/client.js";
import type { TicketQuery } from "../../integrations/glpi/ticket-lookup.js";
import {
  customerWindowMs,
  saveClosurePreference,
} from "./closure-preferences.js";
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
import { readTicketQuery, ticketQueryReply } from "./ticket-query.js";

type Transaction = Pick<
  Database,
  | "whatsAppVerifiedIdentity"
  | "whatsAppConversation"
  | "whatsAppInboundMessage"
  | "whatsAppOutboundMessage"
  | "whatsAppTroubleshootingFeedback"
  | "whatsAppTicketSubmission"
  | "whatsAppClosurePreference"
>;
type Identity = Pick<
  ReturnType<typeof createIdentityVerification>,
  "requestVerification" | "confirmVerification"
>;
export type ReplyAddress = {
  scopeKey: string;
  recipient: OutboundPayload["recipient"];
  expiresAt: Date;
  requiredGlpiUserId?: number;
};
type Claim = {
  kind: "claim";
  action: WhatsAppConversationAction;
  message: WhatsAppInboundMessage;
  address: ReplyAddress;
  id: string;
  lookup?: { requesterId: number; query: TicketQuery };
};
type ProcessResult = Claim | { kind: "idle" | "processed" };

const claimLifetime = 45_000;
const lookupReplyLifetime = 60_000;
const actions: Record<
  NonNullable<ConversationMove["action"]>,
  WhatsAppConversationAction
> = {
  request_code: "REQUEST_CODE",
  confirm_code: "CONFIRM_CODE",
  query_tickets: "QUERY_TICKETS",
};
const cleared = {
  conversationClaimId: null,
  conversationClaimUntil: null,
  conversationAction: null,
  conversationRequesterId: null,
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
    Math.min(message.occurredAt.getTime(), now.getTime()) + customerWindowMs,
  );
  return expiresAt > now ? { scopeKey, recipient, expiresAt } : undefined;
}

export async function verifiedUser(
  tx: Transaction,
  scopeKey: string,
  now: Date,
): Promise<number | undefined> {
  const link = await tx.whatsAppVerifiedIdentity.findUnique({
    where: { scopeKey, expiresAt: { gt: now }, revokedAt: null },
    select: { glpiUserId: true },
  });
  return link ? Number(link.glpiUserId) : undefined;
}

export async function stateFor(
  tx: Transaction,
  scopeKey: string,
): Promise<Conversation> {
  const row = await tx.whatsAppConversation.findUnique({
    where: { scopeKey },
    select: { state: true },
  });
  return readConversationState(row?.state);
}

export async function applyMove(
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
  if (move.closurePreference)
    await saveClosurePreference(
      tx,
      address.scopeKey,
      address.recipient,
      move.closurePreference,
      now,
      move.closurePreference === "disable"
        ? await verifiedUser(tx, address.scopeKey, now)
        : undefined,
    );
  if (move.submission) {
    const { draftId, requesterId, title, description, mediaIds } =
      move.submission;
    const preference = await tx.whatsAppClosurePreference.findUnique({
      where: { scopeKey: address.scopeKey },
    });
    if (
      !preference ||
      (preference.revokedAt === null &&
        preference.glpiUserId !== BigInt(requesterId))
    )
      await saveClosurePreference(
        tx,
        address.scopeKey,
        address.recipient,
        { requesterId },
        now,
      );
    const consent = await tx.whatsAppClosurePreference.findUnique({
      where: {
        scopeKey: address.scopeKey,
        glpiUserId: requesterId,
        revokedAt: null,
      },
      select: { grantId: true },
    });
    const payload = {
      recipient: address.recipient,
      replyExpiresAt: address.expiresAt,
      title,
      description,
      mediaIds,
      attachmentCount: mediaIds.length,
      availableAt: now,
      updatedAt: now,
      closureConsentId: consent?.grantId ?? null,
    };
    const inserted = await tx.whatsAppTicketSubmission.createMany({
      data: {
        draftId,
        businessPhoneId,
        scopeKey: address.scopeKey,
        requesterId,
        ...payload,
      },
      skipDuplicates: true,
    });
    if (inserted.count === 0)
      await tx.whatsAppTicketSubmission.updateMany({
        where: {
          draftId,
          businessPhoneId,
          scopeKey: address.scopeKey,
          requesterId,
          state: "FAILED",
        },
        data: { ...payload, state: "PENDING", attempts: 0 },
      });
  }
  if (move.feedback)
    await tx.whatsAppTroubleshootingFeedback.createMany({
      data: { ...move.feedback, recordedAt: now },
      skipDuplicates: true,
    });
  const requiredGlpiUserId =
    address.requiredGlpiUserId ??
    (move.state.phase === "intake" ? move.state.draft?.ownerId : undefined);
  if (move.reply && address.expiresAt > now)
    await enqueueWhatsAppReply(tx, {
      id: randomUUID(),
      businessPhoneId,
      expiresAt: address.expiresAt,
      payload: {
        recipient: address.recipient,
        content: move.reply,
        ...(requiredGlpiUserId === undefined ? {} : { requiredGlpiUserId }),
      },
    });
}

export function createConversationProcessor(
  store: Database,
  options: {
    businessPhoneId: string;
    supportContact: string;
    readOwnedTickets: ReturnType<typeof createGlpiClient>["readOwnedTickets"];
  },
  identity: Identity,
  clock = () => new Date(),
) {
  const { businessPhoneId, supportContact, readOwnedTickets } = options;

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
      let requesterId = message.conversationRequesterId;
      const userId =
        !action || action === "QUERY_TICKETS"
          ? await verifiedUser(tx, address.scopeKey, now)
          : undefined;
      if (!action) {
        const state = await stateFor(tx, address.scopeKey);
        const move = routeConversation(state, input, {
          userId,
          supportContact,
          noticesEnabled: !(await tx.whatsAppClosurePreference.findUnique({
            where: { scopeKey: address.scopeKey, revokedAt: { not: null } },
            select: { scopeKey: true },
          })),
          draftId: randomUUID(),
          now,
        });
        await applyMove(tx, address, businessPhoneId, move, now);
        action = move.action ? actions[move.action] : null;
        if (action === "QUERY_TICKETS" && userId !== undefined)
          requesterId = BigInt(userId);
      }
      if (!action) {
        await inbox.update({ where, data: { conversationProcessedAt: now } });
        return { kind: "processed" };
      }
      let lookup: Claim["lookup"];
      if (action === "QUERY_TICKETS") {
        const query = readTicketQuery(input, true);
        if (
          userId === undefined ||
          requesterId === null ||
          userId !== Number(requesterId) ||
          !query
        ) {
          await inbox.update({
            where,
            data: { ...cleared, conversationProcessedAt: now },
          });
          return { kind: "processed" };
        }
        lookup = { requesterId: userId, query };
      }
      const id = randomUUID();
      await inbox.update({
        where,
        data: {
          conversationAction: action,
          conversationClaimId: id,
          conversationClaimUntil: new Date(now.getTime() + claimLifetime),
          conversationRequesterId: requesterId,
        },
      });
      return { kind: "claim", action, message, address, id, lookup };
    });
  }

  async function complete(claim: Claim, signal: AbortSignal): Promise<void> {
    const { address, message, action, lookup } = claim;
    const result = lookup
      ? await readOwnedTickets(lookup.requesterId, lookup.query, signal)
      : undefined;
    if (lookup && signal.aborted) return;
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
          ...(lookup ? { conversationClaimUntil: { gt: now } } : {}),
        },
        data: { ...cleared, conversationProcessedAt: now },
      });
      if (accepted.count !== 1) return;
      if (lookup && result) {
        if (
          address.expiresAt <= now ||
          (await verifiedUser(tx, address.scopeKey, now)) !== lookup.requesterId
        )
          return;
        await enqueueWhatsAppReply(tx, {
          id: randomUUID(),
          businessPhoneId,
          expiresAt: new Date(
            Math.min(
              address.expiresAt.getTime(),
              now.getTime() + lookupReplyLifetime,
            ),
          ),
          payload: {
            recipient: address.recipient,
            content: ticketQueryReply(lookup.query, result),
            requiredGlpiUserId: lookup.requesterId,
          },
        });
        return;
      }
      if (action !== "CONFIRM_CODE" && action !== "REQUEST_CODE") return;
      // If the worker restarted after verifying the sender, the durable link
      // is the source of truth for the response.
      const userId = await verifiedUser(tx, address.scopeKey, now);
      const state = await stateFor(tx, address.scopeKey);
      await applyMove(
        tx,
        address,
        businessPhoneId,
        finishVerification(
          state,
          userId,
          action === "REQUEST_CODE" ? "email" : "code",
        ),
        now,
      );
    });
  }

  return async (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false;
    const next = await prepare();
    if (next.kind === "claim" && !signal.aborted) await complete(next, signal);
    return next.kind !== "idle";
  };
}
