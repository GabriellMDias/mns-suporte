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

const title = Type.Literal("title");
const description = Type.Literal("description");
const attachments = Type.Literal("attachments");
const draftStep = Type.Union([
  title,
  description,
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
const titleLimit = 120;
const descriptionLimit = 1200;
const draftSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  ownerId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  step: Type.Union([
    draftStep,
    Type.Literal("category"),
    Type.Literal("unit"),
    Type.Literal("impact"),
  ]),
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  editing: Type.Boolean(),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: titleLimit })),
  category: Type.Optional(Type.String({ maxLength: 80 })),
  unit: Type.Optional(Type.String({ maxLength: 80 })),
  description: Type.Optional(Type.String({ maxLength: descriptionLimit })),
  impact: Type.Optional(Type.String({ maxLength: 300 })),
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

type Draft = Omit<
  Static<typeof draftSchema>,
  "step" | "category" | "unit" | "impact"
> & { step: Static<typeof draftStep> };
export type Conversation = Omit<Static<typeof conversationSchema>, "draft"> & {
  draft?: Draft;
};
export type ConversationInput = Static<typeof inboxContent>;
type Reply = OutboundPayload["content"];
export type IdentityAction = "request_code" | "confirm_code";
export type ClosurePreferenceAction = "disable" | { requesterId: number };
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
  closurePreference?: ClosurePreferenceAction;
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
  "Olá! Para liberar o atendimento, informe seu e-mail corporativo.",
);
const codePrompt = text(
  "Se o e-mail puder ser verificado, você receberá um código. Envie apenas o código completo, começando com MNS-. Para informar o e-mail novamente, digite *Reenviar*.",
);
const pendingReply = text(
  "Rascunho confirmado. Vou enviar o chamado ao GLPI e avisar quando houver um resultado.",
);
const menu = buttons(
  "Como posso ajudar? Você pode retomar um rascunho em *Abrir chamado* ou digitar *Avisos* para gerenciar avisos de encerramento.",
  ["menu:open", "Abrir chamado"],
  ["menu:tickets", "Meus chamados"],
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
    "Envie até cinco fotos, áudios ou PDFs de até 10 MB cada. Para remover todos, digite *Limpar anexos*. Toque em *Revisar rascunho* para voltar.",
    ["review", "Revisar rascunho"],
    ["cancel", "Cancelar"],
  );
}
const prompts = {
  title: text("Qual é o título do chamado? Resuma o problema em uma linha."),
  description: text(
    "Descreva o problema em texto. Você pode enviar anexos ao revisar o chamado.",
  ),
  edit: text(
    "Digite *1* para editar o título, *2* para editar a descrição ou *3* para gerenciar os anexos.",
  ),
};
const aliases: Readonly<Record<string, string>> = {
  "abrir chamado": "menu:open",
  retomar: "menu:open",
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
  avisos: "closure:options",
  "ativar avisos": "closure:enable",
  "desativar avisos": "closure:disable",
  "parar avisos": "closure:disable",
};

function withDraft(
  phase: Conversation["phase"],
  draft: Draft | undefined,
): Conversation {
  return draft ? { phase, draft } : { phase };
}

function review(draft: Draft, noticesEnabled: boolean): Reply {
  const summary =
    "Revise o chamado:\nTítulo: " +
    (draft.title ?? "") +
    "\nDescrição: " +
    (draft.description ?? "") +
    "\nAnexos: " +
    draft.attachments.length +
    "\nSe quiser anexar algo, envie até cinco fotos, áudios ou PDFs de até 10 MB cada antes de confirmar." +
    (noticesEnabled
      ? "\nAo confirmar, você aceita receber avisos do MNS Suporte sobre este chamado pelo WhatsApp. Para desativar, digite *Parar avisos*."
      : "\nOs avisos deste chamado estão desativados.");
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

function intake(
  draft: Draft,
  reply?: Reply,
  noticesEnabled = true,
): ConversationMove {
  return {
    state: { phase: "intake", draft },
    reply:
      reply ??
      (draft.step === "review"
        ? review(draft, noticesEnabled)
        : draft.step === "attachments"
          ? mediaPrompt(draft)
          : draft.step === "guidance"
            ? troubleshooting(draft)
            : prompts[draft.step]),
  };
}

function reviewAfterDescription(
  draft: Draft,
  noticesEnabled: boolean,
): ConversationMove {
  const guidanceId =
    draft.editing || draft.guidanceId
      ? undefined
      : selectGuidance(draft.description);
  return guidanceId
    ? intake({ ...draft, step: "guidance", guidanceId })
    : intake(
        { ...draft, step: "review", editing: false },
        undefined,
        noticesEnabled,
      );
}

function routeDraft(
  draft: Draft,
  input: ConversationInput,
  command: string | undefined,
  now: Date,
  noticesEnabled: boolean,
): ConversationMove {
  const show = (draft: Draft, reply?: Reply) =>
    intake(draft, reply, noticesEnabled);
  if (draft.confirmedAt)
    return { state: withDraft("menu", draft), reply: pendingReply };
  if (draft.step === "review" || draft.step === "attachments") {
    if (command === "draft:clear-media")
      return show({
        ...draft,
        revision: draft.revision + 1,
        attachments: [],
      });
    if (
      input.type === "image" ||
      input.type === "audio" ||
      input.type === "document"
    ) {
      if (draft.attachments.some(({ mediaId }) => mediaId === input.mediaId))
        return show(draft, text("Este anexo já está no rascunho."));
      if (draft.attachments.length >= 5)
        return show(
          draft,
          text(
            "O rascunho já tem cinco anexos. Digite *Limpar anexos* para remover todos.",
          ),
        );
      return show({
        ...draft,
        revision: draft.revision + 1,
        attachments: [...draft.attachments, input],
      });
    }
  }
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
      if (!outcome) return show(draft);
      const feedback: TroubleshootingFeedback = {
        draftId: draft.id,
        guidanceId: draft.guidanceId,
        outcome,
      };
      if (outcome === "RESOLVED")
        return {
          state: { phase: "menu" },
          reply: buttons("Que bom que resolveu. Vou encerrar este rascunho.", [
            "menu:open",
            "Abrir chamado",
          ]),
          feedback,
        };
      return {
        ...show({ ...draft, step: "review", revision: draft.revision + 1 }),
        feedback,
      };
    }
    case "review":
      if (command === "draft:edit") return show({ ...draft, step: "edit" });
      if (command === "draft:confirm" && draft.title && draft.description)
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
            title: draft.title,
            description: [
              draft.description,
              "Referência MNS: " + draft.id,
            ].join("\n\n"),
            mediaIds: draft.attachments.map(({ mediaId }) => mediaId),
          },
        };
      return show(draft);
    case "edit": {
      const choice = input.type === "text" ? input.body.trim() : "";
      if (choice === "1")
        return show({ ...draft, step: "title", editing: true });
      if (choice === "2")
        return show({ ...draft, step: "description", editing: true });
      if (choice === "3")
        return show({ ...draft, step: "attachments", editing: true });
      return show(draft);
    }
    case "attachments":
      return command === "draft:review"
        ? reviewAfterDescription(
            { ...draft, revision: draft.revision + 1 },
            noticesEnabled,
          )
        : show(draft);
    case "title": {
      const value =
        input.type === "text" && !command
          ? input.body.replace(/[\s\p{Cc}]+/gu, " ").trim()
          : "";
      if (!value || value.length > titleLimit || !value.isWellFormed())
        return show(draft, text("Envie um título de até 120 caracteres."));
      const updated = { ...draft, title: value, revision: draft.revision + 1 };
      return draft.description
        ? reviewAfterDescription(updated, noticesEnabled)
        : show({ ...updated, step: "description" });
    }
    case "description": {
      const value = input.type === "text" && !command ? input.body.trim() : "";
      if (!value || value.length > descriptionLimit)
        return show(
          draft,
          text(
            "Envie a descrição do problema em texto, com até " +
              descriptionLimit +
              " caracteres.",
          ),
        );
      return reviewAfterDescription(
        {
          ...draft,
          revision: draft.revision + 1,
          description: value,
        },
        noticesEnabled,
      );
    }
  }
}

export function readConversationState(value: unknown): Conversation {
  if (value === undefined) return { phase: "new" };
  if (!Value.Check(conversationSchema, value))
    throw new Error("Invalid stored WhatsApp conversation");
  const { phase, draft } = value;
  if (!draft) return { phase };
  const { step, category, unit, impact, ...fields } = draft;
  const removedStep =
    step === "category" || step === "unit" || step === "impact";
  const needsTitle =
    !fields.title &&
    !fields.confirmedAt &&
    !fields.uncertainSubmission &&
    step !== "title";
  const legacy =
    removedStep ||
    category !== undefined ||
    unit !== undefined ||
    impact !== undefined ||
    needsTitle;
  if (!legacy) return { phase, draft: { ...fields, step } };
  // Older drafts keep their description and media, with a fresh review after the title.
  return {
    phase,
    draft: {
      ...fields,
      step: needsTitle || removedStep ? "title" : step,
      revision: fields.revision + 1,
      editing: !!fields.description,
    },
  };
}

export function reopenTicketReview(
  draft: Draft,
  noticesEnabled = true,
): ConversationMove {
  const fields = { ...draft };
  delete fields.confirmedAt;
  delete fields.submissionVersion;
  delete fields.uncertainSubmission;
  return intake(
    {
      ...fields,
      step: fields.title ? "review" : "title",
      revision: draft.revision + 1,
    },
    undefined,
    noticesEnabled,
  );
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
    noticesEnabled?: boolean;
  },
): ConversationMove {
  const raw = input.type === "text" ? input.body.trim().toLowerCase() : "";
  const command =
    input.type === "reply"
      ? currentButtonCommand(input.replyId, state.draft)
      : Object.hasOwn(aliases, raw)
        ? aliases[raw]
        : undefined;
  const { userId, supportContact, noticesEnabled = true } = context;
  if (command === "closure:disable")
    return {
      state,
      closurePreference: "disable",
      reply: text("Avisos de chamados desativados neste WhatsApp."),
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
      };
    return { state: withDraft("email", draft), reply: emailPrompt };
  }

  const draft = state.draft?.ownerId === userId ? state.draft : undefined;
  const menuState = withDraft("menu", draft);
  const currentState = withDraft(state.phase, draft);
  if (command === "closure:options")
    return {
      state: currentState,
      reply: buttons(
        "O MNS Suporte envia avisos de resposta, mudança de status e fechamento de chamados. Para cancelar, digite *Parar avisos*.",
        ["closure:enable", "Ativar avisos"],
        ["closure:disable", "Desativar avisos"],
        ["menu", "Menu"],
      ),
    };
  if (command === "closure:enable")
    return {
      state: currentState,
      closurePreference: { requesterId: userId },
      reply: text(
        "Avisos ativados para os próximos chamados que você confirmar. Para cancelar, digite *Parar avisos*.",
      ),
    };
  if (readTicketQuery(input, state.phase === "menu"))
    return { state: currentState, action: "query_tickets" };
  if (draft?.uncertainSubmission) {
    if (command !== "draft:new") return uncertainTicket(draft, supportContact);
    return intake({
      id: context.draftId,
      ownerId: userId,
      step: "title",
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
    return reopenTicketReview(draft, noticesEnabled);
  if (draft?.submissionVersion && command === "draft:confirm")
    return { state: menuState, reply: pendingReply };
  if (command === "draft:cancel") {
    if (draft?.submissionVersion)
      return { state: menuState, reply: pendingReply };
    return {
      state: { phase: "menu" },
      reply: buttons("Rascunho cancelado.", ["menu:open", "Abrir chamado"]),
    };
  }
  if (command === "menu:open" || (raw === "1" && state.phase === "menu")) {
    if (draft?.confirmedAt) return { state: menuState, reply: pendingReply };
    if (
      draft?.step === "guidance" &&
      state.phase === "intake" &&
      command === "menu:open"
    )
      return routeDraft(draft, input, command, context.now, noticesEnabled);
    return intake(
      draft ?? {
        id: context.draftId,
        ownerId: userId,
        step: "title",
        revision: 1,
        editing: false,
        attachments: [],
      },
      undefined,
      noticesEnabled,
    );
  }
  if (state.phase === "intake" && draft)
    return routeDraft(draft, input, command, context.now, noticesEnabled);
  return { state: menuState, reply: menu };
}

export function finishVerification(
  state: Conversation,
  userId: number | undefined,
  step: "email" | "code" = "code",
): ConversationMove {
  if (userId === undefined)
    return {
      state: withDraft("code", state.draft),
      reply:
        step === "email"
          ? codePrompt
          : text(
              "Código inválido ou expirado. Envie o código completo ou digite *Reenviar*.",
            ),
    };
  const draft = state.draft?.ownerId === userId ? state.draft : undefined;
  return {
    state: withDraft("menu", draft),
    reply: {
      ...menu,
      body:
        (step === "email"
          ? "Número reconhecido no GLPI. "
          : "E-mail verificado. ") + menu.body,
    },
  };
}
