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

const leaseMs = 45_000;
const retryMs = 15 * 60_000;
const noticeLifetimeMs = 48 * 60 * 60_000;
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
        where: { scopeKey: watch.scopeKey, glpiUserId: watch.requesterId },
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
    if (!ticket || ticket.status !== 6) {
      await schedule(ticket ? closurePollIntervalMs : null);
      return true;
    }

    const consentId = watch.closureConsentId;
    await store.$transaction(async (tx) => {
      const checkedAt = clock();
      if (checkedAt >= lease) return;
      const current = await readAuthorization(tx, watch);
      const window =
        current && !templateConfigured
          ? await readCustomerWindow(
              tx,
              businessPhoneId,
              current.recipient,
              checkedAt,
            )
          : undefined;
      const sendable =
        current &&
        current.expiresAt > checkedAt &&
        (templateConfigured || window);
      const saved = await tx.whatsAppTicketSubmission.updateMany({
        where: owned,
        data: {
          closureCheckAt:
            current && !sendable
              ? new Date(checkedAt.getTime() + retryMs)
              : null,
        },
      });
      if (saved.count !== 1 || !sendable) return;
      await enqueueWhatsAppReply(tx, {
        id: watch.draftId,
        businessPhoneId,
        expiresAt: window ?? new Date(checkedAt.getTime() + noticeLifetimeMs),
        payload: {
          recipient: current.recipient,
          content: {
            type: "text",
            body:
              "O chamado nº " +
              ticketId +
              " foi encerrado pela equipe de TI. Digite Chamado seguido do número para consultar ou Parar avisos para cancelar os avisos.",
          },
          requiredGlpiUserId: requesterId,
          closure: { consentId, ticketId },
        },
      });
    });
    return true;
  };
}
