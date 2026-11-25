import type {
  OwnedTicket,
  TicketLookupResult,
  TicketQuery,
} from "../../integrations/glpi/ticket-lookup.js";
import type { ConversationInput } from "./conversation.js";
import type { OutboundPayload } from "./outbound-contract.js";

export function readTicketQuery(
  input: ConversationInput,
  allowMenuShortcut: boolean,
): TicketQuery | undefined {
  if (input.type === "reply") {
    if (input.replyId === "menu:tickets") return { kind: "open" };
    const next = /^tickets:before:([1-9][0-9]{0,15})$/.exec(input.replyId);
    if (next && Number.isSafeInteger(Number(next[1])))
      return { kind: "open", before: Number(next[1]) };
    return undefined;
  }
  if (input.type !== "text") return undefined;
  const text = input.body.trim().toLowerCase();
  if (text === "meus chamados" || (allowMenuShortcut && text === "2"))
    return { kind: "open" };
  const detail = /^(?:chamado\s+#?|#)([1-9][0-9]{0,15})$/.exec(text);
  if (detail && Number.isSafeInteger(Number(detail[1])))
    return { kind: "detail", ticketId: Number(detail[1]) };
  return undefined;
}

const statuses: Record<number, string> = {
  1: "Novo",
  2: "Em atendimento",
  3: "Planejado",
  4: "Pendente",
  5: "Solucionado",
  6: "Fechado",
};

function titleOf(ticket: OwnedTicket): string {
  const compact = ticket.title
    .toWellFormed()
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/[*_`~]/g, "")
    .trim();
  return compact.slice(0, 120).toWellFormed() || "Sem título";
}

export function ticketQueryReply(
  query: TicketQuery,
  result: TicketLookupResult,
): OutboundPayload["content"] {
  const detail = result.kind === "ready" ? result.tickets[0] : undefined;
  if (query.kind === "detail") {
    if (!detail)
      return {
        type: "text",
        body: "Não consegui consultar esse chamado. Confira o número e tente novamente, ou fale com a TI.",
      };
    const updated = detail.updatedAt;
    return {
      type: "buttons",
      body: [
        "*Chamado #" + detail.id + "*",
        titleOf(detail),
        "Situação: " + statuses[detail.status],
        ...(updated
          ? [
              "Última atualização: " +
                updated.slice(8, 10) +
                "/" +
                updated.slice(5, 7) +
                "/" +
                updated.slice(0, 4) +
                " às " +
                updated.slice(11, 16),
            ]
          : []),
      ].join("\n"),
      buttons: [
        { id: "menu:tickets", title: "Meus chamados" },
        { id: "menu", title: "Menu" },
      ],
    };
  }
  if (result.kind === "unavailable")
    return {
      type: "text",
      body: "A consulta está indisponível agora. Tente novamente daqui a pouco ou fale com a TI.",
    };
  const body = result.tickets.length
    ? [
        "*Meus chamados em aberto*",
        ...result.tickets.map(
          (ticket) =>
            "#" +
            ticket.id +
            " · " +
            titleOf(ticket) +
            " · " +
            statuses[ticket.status],
        ),
        "\nPara ver detalhes, digite *Chamado " + result.tickets[0].id + "*.",
      ].join("\n")
    : "Nenhum chamado em aberto nesta lista. Para ver um chamado pelo número, digite *Chamado* seguido do número.";
  return {
    type: "buttons",
    body,
    buttons: [
      ...(result.nextBefore
        ? [
            {
              id: "tickets:before:" + result.nextBefore,
              title: "Próxima página",
            },
          ]
        : []),
      ...(query.before
        ? [{ id: "menu:tickets", title: "Primeira página" }]
        : []),
      { id: "menu", title: "Menu" },
    ],
  };
}
