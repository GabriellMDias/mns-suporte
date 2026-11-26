import { expect, it } from "vitest";
import {
  readConversationState,
  routeConversation,
  type Conversation,
  type ConversationInput,
} from "../../src/features/whatsapp/conversation.js";
import { selectGuidance } from "../../src/features/whatsapp/troubleshooting.js";

const context = {
  userId: 37,
  supportContact: "help@example.test",
  draftId: "synthetic-draft",
  now: new Date("2026-11-25T15:00:00Z"),
};
const text = (body: string): ConversationInput => ({ type: "text", body });
const existingDraft: Conversation = {
  phase: "intake",
  draft: {
    id: context.draftId,
    ownerId: context.userId,
    step: "attachments",
    revision: 5,
    editing: false,
    title: "Impressora indisponível",
    description: "A impressora não imprime",
    attachments: [{ type: "image", mediaId: "10002" }],
  },
};

it("only selects one matching guide from the reported symptoms", () => {
  expect(selectGuidance("A IMPRESSORA NÃO IMPRIME")).toBe("printer_offline_v1");
  expect(selectGuidance("O caixa está sem conexão")).toBe(
    "network_one_device_v1",
  );
  expect(
    selectGuidance("A impressora não imprime e o caixa está sem internet"),
  ).toBeUndefined();
  expect(selectGuidance("Preciso de acesso ao sistema")).toBeUndefined();
  expect(
    routeConversation(existingDraft, text("Revisar rascunho"), context).state
      .draft?.step,
  ).toBe("guidance");
  const unrelated: Conversation = {
    phase: "intake",
    draft: {
      ...existingDraft.draft!,
      description: "Preciso de acesso ao sistema",
    },
  };
  const review = routeConversation(
    unrelated,
    text("Revisar rascunho"),
    context,
  );
  expect(review.state.draft?.step).toBe("review");
  expect(review.feedback).toBeUndefined();
});

it.each([
  { choice: "Resolveu", expected: "RESOLVED", nextDraft: false },
  {
    choice: "Ainda preciso de ajuda",
    expected: "NOT_RESOLVED",
    nextDraft: true,
  },
  { choice: "Ir para o chamado", expected: "SKIPPED", nextDraft: true },
  { choice: "Abrir chamado", expected: "SKIPPED", nextDraft: true },
] as const)(
  "records $expected and preserves the right draft state",
  ({ choice, expected, nextDraft }) => {
    const offer = routeConversation(
      existingDraft,
      text("Revisar rascunho"),
      context,
    );
    const resumable = readConversationState(
      JSON.parse(JSON.stringify(offer.state)),
    );
    const result = routeConversation(resumable, text(choice), context);
    expect(result.feedback).toEqual({
      draftId: context.draftId,
      guidanceId: "printer_offline_v1",
      outcome: expected,
    });
    if (nextDraft) {
      expect(result.state.draft).toMatchObject({
        step: "review",
        description: "A impressora não imprime",
        attachments: [{ mediaId: "10002" }],
      });
    } else {
      expect(result.state).toEqual({ phase: "menu" });
    }
    expect(
      routeConversation(result.state, text("Resolveu"), context).feedback,
    ).toBeUndefined();
  },
);
