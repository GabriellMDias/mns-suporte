import { randomUUID } from "node:crypto";
import type { Database } from "../../database.js";
import {
  Prisma,
  type WhatsAppTicketSubmission,
} from "../../generated/prisma/client.js";
import type { createGlpiClient } from "../../integrations/glpi/client.js";
import { closurePollIntervalMs } from "./closure-preferences.js";
import {
  reopenTicketReview,
  uncertainTicket,
  type ConversationMove,
} from "./conversation.js";
import { applyMove, stateFor, verifiedUser } from "./conversation-processor.js";
import type { createWhatsAppMediaReader } from "./graph-media.js";
import { isOutboundPayload } from "./outbound-contract.js";

const leaseMs = 45_000;
const retryDelayMs = [2_000, 8_000];
type Glpi = Pick<
  ReturnType<typeof createGlpiClient>,
  "createTicket" | "attachDocument"
>;
type MediaReader = ReturnType<typeof createWhatsAppMediaReader>;
type Claim = WhatsAppTicketSubmission & { claimId: string };
type Outcome =
  | { kind: "created"; ticketId: number }
  | { kind: "attached" | "retry" | "failed" | "uncertain" };

function allowedRetry(result: { kind: string; reason: string }): boolean {
  return (
    (result.kind === "not_sent" &&
      (result.reason === "transport" || result.reason === "timeout")) ||
    (result.kind === "rejected" && result.reason === "session")
  );
}

export function createTicketSubmissionWorker(
  store: Database,
  options: { businessPhoneId: string; supportContact: string },
  glpi: Glpi,
  readMedia: MediaReader,
  clock = () => new Date(),
) {
  const { businessPhoneId, supportContact } = options;
  const submissions = store.whatsAppTicketSubmission;

  async function claimNext(): Promise<Claim | undefined> {
    const now = clock();
    const due = {
      businessPhoneId,
      state: "PENDING" as const,
      availableAt: { lte: now },
    };
    const candidate = await submissions.findFirst({
      where: due,
      orderBy: [{ availableAt: "asc" }, { draftId: "asc" }],
    });
    if (!candidate) return undefined;
    const claimId = randomUUID();
    const availableAt = new Date(now.getTime() + leaseMs);
    const [accepted] = await submissions.updateManyAndReturn({
      where: { ...due, draftId: candidate.draftId, claimId: candidate.claimId },
      data: {
        claimId,
        availableAt,
        attempts: { increment: 1 },
        updatedAt: now,
      },
    });
    return accepted && { ...accepted, claimId };
  }

  function owned(claim: Claim, now: Date) {
    return {
      draftId: claim.draftId,
      state: "PENDING" as const,
      claimId: claim.claimId,
      availableAt: { gt: now },
    };
  }

  async function execute(
    claim: Claim,
    signal: AbortSignal,
  ): Promise<Outcome | undefined> {
    // A reclaimed write could have succeeded before its response was persisted.
    if (claim.mutating) return { kind: "uncertain" };
    if (claim.attempts > retryDelayMs.length + 1) return { kind: "failed" };
    if (
      claim.ticketId === null &&
      (await verifiedUser(store, claim.scopeKey, clock())) !==
        Number(claim.requesterId)
    )
      return { kind: "failed" };

    const mediaId = Array.isArray(claim.mediaIds)
      ? claim.mediaIds[claim.nextAttachment]
      : null;
    const media =
      claim.ticketId !== null && typeof mediaId === "string"
        ? await readMedia(mediaId, signal)
        : undefined;
    if (signal.aborted) return undefined;
    if (claim.ticketId !== null && media?.kind !== "downloaded")
      return { kind: media?.kind === "unavailable" ? "retry" : "failed" };
    const marked = await submissions.updateMany({
      where: owned(claim, clock()),
      data: { mutating: true },
    });
    if (marked.count !== 1) return undefined;

    const result =
      media?.kind === "downloaded"
        ? await glpi.attachDocument(
            Number(claim.ticketId),
            "mns-" +
              claim.draftId +
              "-" +
              (claim.nextAttachment + 1) +
              "." +
              media.extension,
            media.file,
            signal,
          )
        : await glpi.createTicket(
            {
              requesterId: Number(claim.requesterId),
              title: claim.title ?? "",
              description: claim.description ?? "",
            },
            signal,
          );
    if (
      result.kind === "created" ||
      result.kind === "attached" ||
      result.kind === "uncertain"
    )
      return result;
    return { kind: allowedRetry(result) ? "retry" : "failed" };
  }

  async function finish(claim: Claim, outcome: Outcome): Promise<void> {
    await store.$transaction(async (tx) => {
      // Share the inbox lock when changing the current draft and enqueuing a reply.
      await tx.$queryRaw`SELECT true AS acquired FROM pg_advisory_xact_lock(hashtextextended(${"conversation:" + businessPhoneId}, 0))`;
      const now = clock();
      const delay =
        outcome.kind === "retry" ? retryDelayMs[claim.attempts - 1] : undefined;
      const availableAt = new Date(now.getTime() + (delay ?? 0));
      const advanced = claim.ticketId !== null && delay === undefined;
      const nextAttachment = claim.nextAttachment + Number(advanced);
      const attachedCount =
        claim.attachedCount + Number(outcome.kind === "attached");
      const uncertainAttachments =
        claim.uncertainAttachments +
        Number(advanced && outcome.kind === "uncertain");
      const ticketId =
        outcome.kind === "created" ? BigInt(outcome.ticketId) : claim.ticketId;
      const state =
        delay !== undefined
          ? "PENDING"
          : ticketId === null
            ? outcome.kind === "uncertain"
              ? "UNCERTAIN"
              : "FAILED"
            : nextAttachment === claim.attachmentCount
              ? "COMPLETED"
              : "PENDING";
      const terminal = state !== "PENDING";
      const saved = await tx.whatsAppTicketSubmission.updateMany({
        where: owned(claim, now),
        data: {
          claimId: null,
          mutating: false,
          availableAt,
          updatedAt: now,
          state,
          ticketId,
          ...(outcome.kind === "created" && claim.closureConsentId
            ? {
                closureCheckAt: new Date(now.getTime() + closurePollIntervalMs),
                noticeCursor: { status: 1, followupId: 0 },
              }
            : {}),
          nextAttachment,
          attachedCount,
          uncertainAttachments,
          attempts: delay === undefined ? 0 : claim.attempts,
          ...(ticketId !== null || terminal
            ? { title: null, description: null }
            : {}),
          ...(terminal ? { mediaIds: [], recipient: Prisma.DbNull } : {}),
        },
      });
      if (saved.count !== 1 || !terminal) return;

      const conversation = await stateFor(tx, claim.scopeKey);
      const draft = conversation.draft;
      if (
        draft?.id !== claim.draftId ||
        draft.ownerId !== Number(claim.requesterId)
      )
        return;
      let move: ConversationMove;
      if (state === "UNCERTAIN") {
        move = uncertainTicket(draft, supportContact);
      } else if (state === "FAILED") {
        const review = reopenTicketReview(draft);
        move = {
          state: { ...review.state, phase: "menu" },
          reply: {
            type: "text",
            body: "Não consegui criar o chamado no GLPI. Seu rascunho está salvo. Para revisar e tentar de novo, digite *Abrir chamado*.",
          },
        };
      } else {
        const missing =
          claim.attachmentCount - attachedCount - uncertainAttachments;
        const parts = ["Chamado *#" + ticketId + "* aberto no GLPI."];
        if (attachedCount > 0)
          parts.push("Anexos incluídos: " + attachedCount + ".");
        if (missing > 0)
          parts.push("Anexos que não puderam ser incluídos: " + missing + ".");
        if (uncertainAttachments > 0)
          parts.push(
            "Anexos sem confirmação do GLPI: " + uncertainAttachments + ".",
          );
        if (missing + uncertainAttachments > 0)
          parts.push(
            "Fale com a TI por " +
              supportContact +
              " e informe o número do chamado para complementar os anexos.",
          );
        move = {
          state: { phase: "menu" },
          reply: { type: "text", body: parts.join("\n") },
        };
      }
      const payload: unknown = {
        recipient: claim.recipient,
        content: move.reply,
      };
      if (!isOutboundPayload(payload))
        throw new Error("Invalid ticket submission reply");
      const currentUser = await verifiedUser(tx, claim.scopeKey, now);
      if (
        currentUser !== draft.ownerId &&
        (conversation.phase === "email" || conversation.phase === "code")
      )
        move.state.phase = conversation.phase;
      await applyMove(
        tx,
        {
          scopeKey: claim.scopeKey,
          recipient: payload.recipient,
          expiresAt: currentUser === draft.ownerId ? claim.replyExpiresAt : now,
          requiredGlpiUserId: draft.ownerId,
        },
        businessPhoneId,
        move,
        now,
      );
    });
  }

  return async (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false;
    const claim = await claimNext();
    if (!claim) return false;
    const result = await execute(claim, signal);
    if (result) await finish(claim, result);
    return true;
  };
}
