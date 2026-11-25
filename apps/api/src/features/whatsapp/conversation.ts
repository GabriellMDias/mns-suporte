import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { normalizeEmail } from "../../email-address.js";
import type { OutboundPayload } from "./outbound-contract.js";
import { readTicketQuery } from "./ticket-query.js";
import {
  guidanceIdSchema,
  guidanceInstructions,
  selectGuidance,
  type GuidanceId,
} from "./troubleshooting.js";

const category = Type.Literal("category");
const unit = Type.Literal("unit");
const description = Type.Literal("description");
const impact = Type.Literal("impact");
const attachments = Type.Literal("attachments");
const draftStep = Type.Union([
  category,
  unit,
  description,
  impact,
  attachments,
  Type.Literal("review"),
  Type.Literal("guidance"),
  Type.Literal("edit"),
]);
const attachment = Type.Object({
  type: Type.Union([
    Type.Literal("image"),
    Type.Literal("audio"),
    Type.Literal("document"),
  ]),
  mediaId: Type.String({ minLength: 1, maxLength: 512 }),
  filename: Type.Optional(Type.String({ maxLength: 1024 })),
  mimeType: Type.Optional(Type.String({ maxLength: 255 })),
  caption: Type.Optional(Type.String({ maxLength: 4096 })),
});
const fieldLimits = {
  category: 80,
  unit: 80,
  description: 1200,
  impact: 300,
} as const;
const draftSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  ownerId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  step: draftStep,
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  editing: Type.Boolean(),
  category: Type.Optional(Type.String({ maxLength: fieldLimits.category })),
  unit: Type.Optional(Type.String({ maxLength: fieldLimits.unit })),
  description: Type.Optional(
    Type.String({ maxLength: fieldLimits.description }),
  ),
  impact: Type.Optional(Type.String({ maxLength: fieldLimits.impact })),
  attachments: Type.Array(attachment, { maxItems: 5 }),
  confirmedAt: Type.Optional(Type.String()),
  submissionVersion: Type.Optional(Type.Literal(1)),
  uncertainSubmission: Type.Optional(Type.Literal(true)),
  guidanceId: Type.Optional(guidanceIdSchema),
});
const conversationSchema = Type.Object({
  phase: Type.Union([
    Type.Literal("new"),
    Type.Literal("email"),
    Type.Literal("code"),
    Type.Literal("menu"),
    Type.Literal("intake"),
  ]),
  draft: Type.Optional(draftSchema),
});
const inboxContent = Type.Union([
  Type.Object({ type: Type.Literal("text"), body: Type.String() }),
  Type.Object({ type: Type.Literal("reply"), replyId: Type.String() }),
  Type.Object({
    type: Type.Literal("verification_code"),
    digest: Type.Optional(Type.String()),
  }),
  attachment,
]);

export type Conversation = Static<typeof conversationSchema>;
type Draft = Static<typeof draftSchema>;
export type ConversationInput = Static<typeof inboxContent>;
type Reply = OutboundPayload["content"];
export type IdentityAction = "request_code" | "confirm_code";
export type TroubleshootingFeedback = {
  draftId: string;
  guidanceId: GuidanceId;
  outcome: "RESOLVED" | "NOT_RESOLVED" | "SKIPPED";
};
export type ConversationMove = {
  state: Conversation;
  reply?: Reply;
  action?: IdentityAction | "query_tickets";
  feedback?: TroubleshootingFeedback;
  submission?: TicketSubmission;
};

export type TicketSubmission = {
  draftId: string;
  requesterId: number;
  title: string;
  description: string;
  mediaIds: string[];
};

const text = (body: string): Reply => ({ type: "text", body });
const buttons = (body: string, ...choices: [string, string][]): Reply => ({
  type: "buttons",
  body,
  buttons: choices.map(([id, title]) => ({ id, title })),
});
const emailPrompt = text(
  "Olá! Para liberar o atendimento, informe seu e-mail corporativo. Para falar com a TI, digite *Falar com a TI*.",
);
const codePrompt = text(
  "Se o e-mail puder ser verificado, você receberá um código. Envie apenas o código completo, começando com MNS-. Para informar o e-mail novamente, digite *Reenviar*.",
);
const pendingReply = text(
  "Rascunho confirmado. Vou enviar o chamado ao GLPI e avisar quando houver um resultado.",
);
const menu = buttons(
  "Como posso ajudar? Você pode retomar um rascunho em *Abrir chamado*.",
  ["menu:open", "Abrir chamado"],
  ["menu:tickets", "Meus chamados"],
  ["menu:it", "Falar com a TI"],
);
function draftButtons(
  draft: Draft,
  body: string,
  ...choices: [string, string][]
): Reply {
  return buttons(
    body,
    ...choices.map(([action, label]): [string, string] => [
      "draft:" + action + ":" + draft.id + ":" + draft.revision,
      label,
    ]),
  );
}
function mediaPrompt(draft: Draft): Reply {
  return draftButtons(
    draft,
    "Envie até cinco anexos de até 10 MB cada. Aceitamos fotos JPEG/PNG, áudios OGG/MP3/AAC/MP4/AMR e documentos PDF. Selecione *Revisar rascunho* quando terminar.",
    ["review", "Revisar rascunho"],
    ["cancel", "Cancelar"],
  );
}
const prompts = {
  category: text(
    "Qual é a categoria do problema? Por exemplo, acesso, sistema ou equipamento.",
  ),
  unit: text("Qual unidade ou setor precisa de ajuda?"),
  description: text(
    "Descreva o problema e o que já tentou. Você pode incluir anexos na próxima etapa.",
  ),
  impact: text(
    "Qual é o impacto? Informe quantas pessoas ou operações foram afetadas.",
  ),
  edit: text(
    "Qual campo deseja editar? Responda com o número:\n1. Categoria\n2. Unidade ou setor\n3. Descrição\n4. Impacto\n5. Anexos",
  ),
};
const fieldOrder = [
  "category",
  "unit",
  "description",
  "impact",
  "attachments",
] as const;
const fieldNext = {
  category: "unit",
  unit: "description",
  description: "impact",
  impact: "attachments",
} as const;
const aliases: Readonly<Record<string, string>> = {
  "abrir chamado": "menu:open",
  retomar: "menu:open",
  "falar com a ti": "menu:it",
  "falar com ti": "menu:it",
  menu: "menu",
  cancelar: "draft:cancel",
  "revisar rascunho": "draft:review",
  pular: "draft:review",
  confirmar: "draft:confirm",
  "novo chamado": "draft:new",
  editar: "draft:edit",
  resolveu: "draft:resolved",
  "ainda preciso de ajuda": "draft:unresolved",
  "ainda preciso": "draft:unresolved",
  "ir para o chamado": "draft:skip-guide",
  reenviar: "auth:retry",
  "limpar anexos": "draft:clear-media",
};

function withDraft(
  phase: Conversation["phase"],
  draft: Draft | undefined,
): Conversation {
  return draft ? { phase, draft } : { phase };
}

function review(draft: Draft): Reply {
  const summary =
    "Revise o rascunho:\nCategoria: " +
    (draft.category ?? "") +
    "\nUnidade ou setor: " +
    (draft.unit ?? "") +
    "\nDescrição: " +
    (draft.description ?? "") +
    "\nImpacto: " +
    (draft.impact ?? "") +
    "\nAnexos: " +
    draft.attachments.length;
  // WhatsApp button bodies are limited to 1024 characters. Keep the full review.
  return summary.length <= 1024
    ? draftButtons(
        draft,
        summary,
        ["confirm", "Confirmar"],
        ["edit", "Editar"],
        ["cancel", "Cancelar"],
      )
    : text(summary + "\n\nDigite *Confirmar*, *Editar* ou *Cancelar*.");
}

function troubleshooting(draft: Draft): Reply {
  if (!draft.guidanceId)
    throw new Error("Missing active troubleshooting guide");
  return draftButtons(
    draft,
    guidanceInstructions(draft.guidanceId) +
      "\n\nSe preferir, siga direto para revisar o chamado.",
    ["resolved", "Resolveu"],
    ["unresolved", "Ainda preciso"],
    ["skip-guide", "Ir para o chamado"],
  );
}

function intake(draft: Draft, reply?: Reply): ConversationMove {
  return {
    state: { phase: "intake", draft },
    reply:
      reply ??
      (draft.step === "review"
        ? review(draft)
        : draft.step === "attachments"
          ? mediaPrompt(draft)
          : draft.step === "guidance"
            ? troubleshooting(draft)
            : prompts[draft.step]),
  };
}

function routeDraft(
  draft: Draft,
  input: ConversationInput,
  command: string | undefined,
  now: Date,
): ConversationMove {
  if (draft.confirmedAt)
    return { state: withDraft("menu", draft), reply: pendingReply };
  switch (draft.step) {
    case "guidance": {
      if (!draft.guidanceId)
        throw new Error("Missing active troubleshooting guide");
      const outcome =
        command === "draft:resolved"
          ? "RESOLVED"
          : command === "draft:unresolved"
            ? "NOT_RESOLVED"
            : command === "draft:skip-guide" ||
                command === "draft:review" ||
                command === "menu:open"
              ? "SKIPPED"
              : undefined;
      if (!outcome) return intake(draft);
      const feedback: TroubleshootingFeedback = {
        draftId: draft.id,
        guidanceId: draft.guidanceId,
        outcome,
      };
      if (outcome === "RESOLVED")
        return {
          state: { phase: "menu" },
          reply: buttons(
            "Que bom que resolveu. Vou encerrar este rascunho.",
            ["menu:open", "Abrir chamado"],
            ["menu:it", "Falar com a TI"],
          ),
          feedback,
        };
      return {
        ...intake({ ...draft, step: "review", revision: draft.revision + 1 }),
        feedback,
      };
    }
    case "review":
      if (command === "draft:edit") return intake({ ...draft, step: "edit" });
      if (command === "draft:confirm")
        return {
          state: withDraft("menu", {
            ...draft,
            confirmedAt: now.toISOString(),
            submissionVersion: 1,
          }),
          reply: pendingReply,
          submission: {
            draftId: draft.id,
            requesterId: draft.ownerId,
            title:
              "Suporte via WhatsApp — " +
              draft.category?.replace(/\p{Cc}+/gu, " "),
            description: [
              "Categoria: " + draft.category,
              "Unidade ou setor: " + draft.unit,
              "Descrição: " + draft.description,
              "Impacto: " + draft.impact,
              "Referência MNS: " + draft.id,
            ].join("\n"),
            mediaIds: draft.attachments.map(({ mediaId }) => mediaId),
          },
        };
      return intake(draft);
    case "edit": {
      const field =
        input.type === "text" && /^[1-5]$/.test(input.body.trim())
          ? fieldOrder[Number(input.body.trim()) - 1]
          : undefined;
      return intake(field ? { ...draft, step: field, editing: true } : draft);
    }
    case "attachments":
      if (command === "draft:review") {
        // Editing an existing draft must not replay prior advice.
        const guide =
          draft.editing || draft.guidanceId
            ? undefined
            : selectGuidance(draft.description);
        if (guide)
          return intake({
            ...draft,
            step: "guidance",
            guidanceId: guide,
            revision: draft.revision + 1,
          });
        return intake({ ...draft, step: "review", editing: false });
      }
      if (command === "draft:clear-media")
        return intake(
          { ...draft, revision: draft.revision + 1, attachments: [] },
          text(
            "Anexos removidos do rascunho. Envie outros ou digite *Revisar rascunho*.",
          ),
        );
      if (
        input.type === "image" ||
        input.type === "audio" ||
        input.type === "document"
      ) {
        if (draft.attachments.some(({ mediaId }) => mediaId === input.mediaId))
          return intake(
            draft,
            text(
              "Este anexo já está no rascunho. Envie outro ou digite *Revisar rascunho*.",
            ),
          );
        if (draft.attachments.length >= 5)
          return intake(
            draft,
            text(
              "O rascunho já tem cinco anexos. Digite *Revisar rascunho* ou *Limpar anexos*.",
            ),
          );
        return intake(
          {
            ...draft,
            revision: draft.revision + 1,
            attachments: [...draft.attachments, input],
          },
          text("Anexo recebido. Envie outro ou digite *Revisar rascunho*."),
        );
      }
      return intake(draft);
    default: {
      const step = draft.step;
      const value = input.type === "text" ? input.body.trim() : "";
      if (!value || value.length > fieldLimits[step])
        return intake(
          draft,
          text(
            "Envie este campo em texto, com até " +
              fieldLimits[step] +
              " caracteres.",
          ),
        );
      const next = draft.editing ? "review" : fieldNext[step];
      return intake({
        ...draft,
        revision: draft.revision + 1,
        [step]: value,
        step: next,
        editing: false,
      });
    }
  }
}

export function readConversationState(value: unknown): Conversation {
  if (value === undefined) return { phase: "new" };
  if (!Value.Check(conversationSchema, value))
    throw new Error("Invalid stored WhatsApp conversation");
  return value;
}

export function reopenTicketReview(draft: Draft): ConversationMove {
  const fields = { ...draft };
  delete fields.confirmedAt;
  delete fields.submissionVersion;
  delete fields.uncertainSubmission;
  return intake({ ...fields, step: "review", revision: draft.revision + 1 });
}

export function uncertainTicket(
  draft: Draft,
  supportContact: string,
): ConversationMove {
  return {
    state: withDraft("menu", {
      ...draft,
      uncertainSubmission: true,
      attachments: [],
    }),
    reply: draftButtons(
      draft,
      "O GLPI não confirmou se o chamado foi aberto. Para verificar antes de reenviar este problema, contate a TI por " +
        supportContact +
        " e informe a referência " +
        draft.id +
        ".",
      ["new", "Novo chamado"],
      ["menu:it", "Falar com a TI"],
    ),
  };
}

export function readConversationInput(
  input: unknown,
): ConversationInput | undefined {
  return Value.Check(inboxContent, input) ? input : undefined;
}

function currentButtonCommand(
  raw: string,
  draft: Draft | undefined,
): string | undefined {
  if (!raw.startsWith("draft:")) return raw;
  if (!draft) return undefined;
  const revisionSuffix = ":" + draft.id + ":" + draft.revision;
  return raw.endsWith(revisionSuffix)
    ? raw.slice(0, -revisionSuffix.length)
    : undefined;
}

export function routeConversation(
  state: Conversation,
  input: ConversationInput,
  context: {
    userId: number | undefined;
    supportContact: string;
    draftId: string;
    now: Date;
  },
): ConversationMove {
  const raw = input.type === "text" ? input.body.trim().toLowerCase() : "";
  const command =
    input.type === "reply"
      ? currentButtonCommand(input.replyId, state.draft)
      : Object.hasOwn(aliases, raw)
        ? aliases[raw]
        : undefined;
  const { userId, supportContact } = context;
  if (command === "menu:it" || (raw === "3" && state.phase !== "intake"))
    return {
      state,
      reply: text("Fale com a equipe de TI por " + supportContact + "."),
    };

  if (userId === undefined) {
    const draft = state.draft;
    if (
      command === "draft:cancel" ||
      command === "auth:retry" ||
      command === "menu"
    )
      return { state: withDraft("email", draft), reply: emailPrompt };
    if (state.phase === "code") {
      if (input.type === "verification_code")
        return { state: withDraft("code", draft), action: "confirm_code" };
      return { state: withDraft("code", draft), reply: codePrompt };
    }
    if (
      state.phase === "email" &&
      input.type === "text" &&
      normalizeEmail(input.body)
    )
      return {
        state: withDraft("code", draft),
        action: "request_code",
        reply: codePrompt,
      };
    return { state: withDraft("email", draft), reply: emailPrompt };
  }

  const draft = state.draft?.ownerId === userId ? state.draft : undefined;
  const menuState = withDraft("menu", draft);
  if (readTicketQuery(input, state.phase === "menu"))
    return { state: withDraft(state.phase, draft), action: "query_tickets" };
  if (draft?.uncertainSubmission) {
    if (command !== "draft:new") return uncertainTicket(draft, supportContact);
    return intake({
      id: context.draftId,
      ownerId: userId,
      step: "category",
      revision: 1,
      editing: false,
      attachments: [],
    });
  }
  if (command === "menu") return { state: menuState, reply: menu };
  if (
    draft?.confirmedAt &&
    !draft.submissionVersion &&
    command !== "draft:cancel"
  )
    return reopenTicketReview(draft);
  if (draft?.submissionVersion && command === "draft:confirm")
    return { state: menuState, reply: pendingReply };
  if (command === "draft:cancel") {
    if (draft?.submissionVersion)
      return { state: menuState, reply: pendingReply };
    return {
      state: { phase: "menu" },
      reply: buttons(
        "Rascunho cancelado.",
        ["menu:open", "Abrir chamado"],
        ["menu:it", "Falar com a TI"],
      ),
    };
  }
  if (command === "menu:open" || (raw === "1" && state.phase === "menu")) {
    if (draft?.confirmedAt) return { state: menuState, reply: pendingReply };
    if (
      draft?.step === "guidance" &&
      state.phase === "intake" &&
      command === "menu:open"
    )
      return routeDraft(draft, input, command, context.now);
    return intake(
      draft ?? {
        id: context.draftId,
        ownerId: userId,
        step: "category",
        revision: 1,
        editing: false,
        attachments: [],
      },
    );
  }
  if (state.phase === "intake" && draft)
    return routeDraft(draft, input, command, context.now);
  return { state: menuState, reply: menu };
}

export function finishVerification(
  state: Conversation,
  userId: number | undefined,
): ConversationMove {
  if (userId === undefined)
    return {
      state: withDraft("code", state.draft),
      reply: text(
        "Código inválido ou expirado. Envie o código completo ou digite *Reenviar*.",
      ),
    };
  const draft = state.draft?.ownerId === userId ? state.draft : undefined;
  return {
    state: withDraft("menu", draft),
    reply: { ...menu, body: "E-mail verificado. " + menu.body },
  };
}
