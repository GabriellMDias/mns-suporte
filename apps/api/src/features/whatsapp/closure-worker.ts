import { randomUUID } from "node:crypto";
import type { Database } from "../../database.js";
import type { WhatsAppTicketSubmission } from "../../generated/prisma/client.js";
import type { createGlpiClient } from "../../integrations/glpi/client.js";
import {
  closurePollIntervalMs,
  readCustomerWindow,
} from "./closure-preferences.js";
import { scopeOf } from "./identity-code.js";
import { readRecipient, recipientIdentity } from "./outbound-contract.js";
import { enqueueWhatsAppReply } from "./outbox.js";
import { ticketStatuses } from "./ticket-query.js";

const leaseMs = 45_000;
const retryMs = 15 * 60_000;
const noticeLifetimeMs = 48 * 60 * 60_000;
const closedWatchMs = 7 * 24 * 60 * 60 * 1000;
const followupsPerPoll = 20;
type NoticeCursor = { status: number; followupId: number; closedAt?: string };
function readCursor(value: unknown): NoticeCursor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cursor = value as Partial<NoticeCursor>;
  if (
    typeof cursor.status !== "number" ||
    !Object.hasOwn(ticketStatuses, cursor.status) ||
    typeof cursor.followupId !== "number" ||
    !Number.isSafeInteger(cursor.followupId) ||
    cursor.followupId < 0
  )
    return undefined;
  return {
    status: cursor.status,
    followupId: cursor.followupId,
    ...(typeof cursor.closedAt === "string" &&
    Number.isFinite(Date.parse(cursor.closedAt))
      ? { closedAt: cursor.closedAt }
      : {}),
  };
}
type Watch = Pick<
  WhatsAppTicketSubmission,
  "draftId" | "scopeKey" | "requesterId" | "closureConsentId"
>;
type IdentityStore = Pick<
  Database,
  "whatsAppVerifiedIdentity" | "whatsAppClosurePreference"
>;

export function createClosureWorker(
  store: Database,
  options: { businessPhoneId: string; templateConfigured: boolean },
  readOwnedTickets: ReturnType<typeof createGlpiClient>["readOwnedTickets"],
  clock = () => new Date(),
  readActivity?: ReturnType<typeof createGlpiClient>["readTicketActivity"],
) {
  const { businessPhoneId, templateConfigured } = options;
  const watches = store.whatsAppTicketSubmission;

  async function readAuthorization(tx: IdentityStore, watch: Watch) {
    if (!watch.closureConsentId) return undefined;
    const [consent, binding] = await Promise.all([
      tx.whatsAppClosurePreference.findUnique({
        where: {
          scopeKey: watch.scopeKey,
          glpiUserId: watch.requesterId,
          grantId: watch.closureConsentId,
          revokedAt: null,
        },
        select: { recipient: true },
      }),
      tx.whatsAppVerifiedIdentity.findUnique({
        where: {
          scopeKey: watch.scopeKey,
          glpiUserId: watch.requesterId,
          revokedAt: null,
        },
        select: { expiresAt: true },
      }),
    ]);
    const recipient = readRecipient(consent?.recipient);
    if (
      binding &&
      recipient &&
      scopeOf(recipientIdentity(businessPhoneId, recipient)) === watch.scopeKey
    )
      return { recipient, expiresAt: binding.expiresAt };
    return undefined;
  }

  return async (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false;
    const now = clock();
    const watch = await watches.findFirst({
      where: { businessPhoneId, closureCheckAt: { lte: now } },
      orderBy: [{ closureCheckAt: "asc" }, { draftId: "asc" }],
      select: {
        draftId: true,
        scopeKey: true,
        requesterId: true,
        ticketId: true,
        closureConsentId: true,
        closureCheckAt: true,
        noticeCursor: true,
      },
    });
    if (!watch || watch.ticketId === null || !watch.closureConsentId)
      return false;
    const lease = new Date(now.getTime() + leaseMs);
    const claimed = await watches.updateMany({
      where: { draftId: watch.draftId, closureCheckAt: watch.closureCheckAt },
      data: { closureCheckAt: lease },
    });
    if (claimed.count !== 1) return true;
    const owned = { draftId: watch.draftId, closureCheckAt: lease };
    const schedule = async (delay: number | null) => {
      await watches.updateMany({
        where: owned,
        data: {
          closureCheckAt:
            delay === null ? null : new Date(clock().getTime() + delay),
        },
      });
    };

    const authorization = await readAuthorization(store, watch);
    if (
      !authorization ||
      authorization.expiresAt <= clock() ||
      signal.aborted
    ) {
      if (!signal.aborted) await schedule(authorization ? retryMs : null);
      return true;
    }
    const requesterId = Number(watch.requesterId);
    const ticketId = Number(watch.ticketId);
    const result = await readOwnedTickets(
      requesterId,
      { kind: "detail", ticketId },
      signal,
    );
    if (signal.aborted) return true;
    if (result.kind === "unavailable") {
      await schedule(retryMs);
      return true;
    }
    const ticket = result.tickets.find(({ id }) => id === ticketId);
    if (!ticket) {
      await schedule(null);
      return true;
    }
    const cursor = readCursor(watch.noticeCursor);
    const trackActivity = !!readActivity && !!cursor;
    if (!trackActivity && ticket.status !== 6) {
      await schedule(closurePollIntervalMs);
      return true;
    }
    const activity = await readActivity?.(
      ticketId,
      ticket.status,
      cursor?.followupId ?? 0,
      signal,
    );
    if (signal.aborted) return true;
    if (readActivity && !activity) {
      await schedule(retryMs);
      return true;
    }

    const consentId = watch.closureConsentId;
    await store.$transaction(async (tx) => {
      const checkedAt = clock();
      if (checkedAt >= lease) return;
      const current = await readAuthorization(tx, watch);
      if (!current || current.expiresAt <= checkedAt) {
        await tx.whatsAppTicketSubmission.updateMany({
          where: owned,
          data: {
            closureCheckAt: current ? new Date(+checkedAt + retryMs) : null,
          },
        });
        return;
      }
      const window = await readCustomerWindow(
        tx,
        businessPhoneId,
        current.recipient,
        checkedAt,
      );
      const closed = ticket.status === 6;
      // Existing watches establish a baseline without replaying older replies.
      const previous = cursor ?? {
        status: closed ? 1 : ticket.status,
        followupId: 0,
      };
      const next: NoticeCursor = {
        status: previous.status,
        followupId: previous.followupId,
      };
      const statusChanged = previous.status !== ticket.status;
      const sendStatus =
        statusChanged && (window || (closed && templateConfigured));
      const sendFollowups = !!window && trackActivity;
      const unread = (activity?.followups ?? []).filter(
        (item) => item.id > previous.followupId,
      );
      const followups = sendFollowups
        ? unread.slice(0, followupsPerPoll)
        : unread;
      const remainingReplies =
        sendFollowups && unread.length > followups.length;
      const pendingFollowups = followups.some((item) => !!item.text);
      if (!cursor || sendFollowups || !pendingFollowups)
        next.followupId = Math.max(
          next.followupId,
          ...followups.map((item) => item.id),
        );
      if (sendStatus) next.status = ticket.status;
      if (closed) next.closedAt = previous.closedAt ?? checkedAt.toISOString();
      const waitingForWindow =
        (statusChanged && !sendStatus) ||
        (cursor && pendingFollowups && !window);
      const retire =
        closed &&
        !waitingForWindow &&
        !remainingReplies &&
        (!trackActivity ||
          +checkedAt - Date.parse(next.closedAt!) >= closedWatchMs);
      const saved = await tx.whatsAppTicketSubmission.updateMany({
        where: owned,
        data: {
          ...(trackActivity ? { noticeCursor: next } : {}),
          closureCheckAt: retire
            ? null
            : new Date(
                +checkedAt +
                  (waitingForWindow ? retryMs : closurePollIntervalMs),
              ),
        },
      });
      if (saved.count !== 1) return;
      const title = ticket.title
        .replace(/[\s\p{Cc}]+/gu, " ")
        .trim()
        .slice(0, 200)
        .toWellFormed();
      const heading =
        "Atualização do seu chamado #" +
        ticketId +
        "\n\nStatus: " +
        ticketStatuses[ticket.status] +
        "\nTítulo: " +
        (title || "Sem título");
      const enqueue = async (body: string, event?: "status" | "followup") => {
        const id =
          event ||
          (await tx.whatsAppOutboundMessage.findUnique({
            where: { id: watch.draftId },
            select: { id: true },
          }))
            ? randomUUID()
            : watch.draftId;
        await enqueueWhatsAppReply(tx, {
          id,
          businessPhoneId,
          expiresAt:
            event || !templateConfigured
              ? window!
              : new Date(+checkedAt + noticeLifetimeMs),
          payload: {
            recipient: current.recipient,
            content: { type: "text", body },
            requiredGlpiUserId: requesterId,
            closure: { consentId, ticketId, ...(event ? { event } : {}) },
          },
        });
      };
      if (sendFollowups) {
        for (const item of followups) {
          if (item.text)
            await enqueue(
              heading + "\n\nResposta da equipe de TI:\n" + item.text,
              "followup",
            );
        }
      }
      if (sendStatus) {
        if (closed) {
          await enqueue(
            heading +
              "\n\nSolução:\n" +
              (activity?.solution ??
                "Nenhuma solução foi registrada no GLPI.") +
              "\n\nSeu chamado foi finalizado pela equipe de TI.",
          );
        } else {
          await enqueue(heading, "status");
        }
      }
    });
    return true;
  };
}
