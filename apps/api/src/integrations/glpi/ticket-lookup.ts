import { Type } from "typebox";
import { Value } from "typebox/value";
import { positiveId, readSearchPage } from "./directory.js";

export type TicketQuery =
  { kind: "open"; before?: number } | { kind: "detail"; ticketId: number };
export type OwnedTicket = {
  id: number;
  title: string;
  status: number;
  updatedAt?: string;
};
export type TicketLookupResult =
  | { kind: "ready"; tickets: OwnedTicket[]; nextBefore?: number }
  | { kind: "unavailable" };

export const ticketPageSize = 5;
const searchRow = Type.Object({
  "1": Type.String({ maxLength: 4096 }),
  "2": Type.Unknown(),
  "12": Type.Unknown(),
  "19": Type.Optional(
    Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  ),
});
const actors = Type.Array(
  Type.Object({
    tickets_id: Type.Unknown(),
    users_id: Type.Union([
      Type.Integer({ minimum: 0 }),
      Type.String({ pattern: "^[0-9]{1,16}$" }),
    ]),
    type: Type.Unknown(),
  }),
  { maxItems: 5 },
);

export function ticketSearch(
  requesterId: number,
  query: TicketQuery,
): URLSearchParams {
  const params = new URLSearchParams({
    "criteria[0][field]": "4",
    "criteria[0][searchtype]": "equals",
    "criteria[0][value]": String(requesterId),
    "criteria[1][link]": "AND",
    "criteria[1][field]": query.kind === "open" ? "12" : "2",
    "criteria[1][searchtype]": "equals",
    "criteria[1][value]":
      query.kind === "open" ? "notold" : String(query.ticketId),
    "forcedisplay[0]": "1",
    "forcedisplay[1]": "2",
    "forcedisplay[2]": "12",
    "forcedisplay[3]": "19",
    is_deleted: "false",
    sort: "2",
    order: "DESC",
    range: query.kind === "open" ? "0-" + ticketPageSize : "0-0",
  });
  if (query.kind === "open" && query.before !== undefined) {
    params.set("criteria[2][link]", "AND");
    params.set("criteria[2][field]", "2");
    // GLPI REST v1 uses a comparison prefix in numeric search values.
    params.set("criteria[2][searchtype]", "contains");
    params.set("criteria[2][value]", "<" + query.before);
  }
  return params;
}

export function readTicketCandidates(
  payload: unknown,
  query: TicketQuery,
): OwnedTicket[] | undefined {
  const limit = query.kind === "open" ? ticketPageSize + 1 : 1;
  const page = readSearchPage(payload, 0, limit);
  if (!page || page.rows.length !== Math.min(page.total, limit))
    return undefined;
  if (query.kind === "detail" && page.total > 1) return undefined;
  const tickets = new Map<number, OwnedTicket>();
  for (const row of page.rows) {
    if (!Value.Check(searchRow, row)) return undefined;
    const id = positiveId(row["2"]);
    const status = positiveId(row["12"]);
    if (!id || !status || status > 6 || tickets.has(id)) return undefined;
    if (
      query.kind === "detail"
        ? id !== query.ticketId
        : status > 4 || (query.before !== undefined && id >= query.before)
    )
      return undefined;
    const updatedAt = row["19"];
    tickets.set(id, {
      id,
      status,
      title: row["1"],
      ...(updatedAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(updatedAt)
        ? { updatedAt }
        : {}),
    });
  }
  return [...tickets.values()].sort((left, right) => right.id - left.id);
}

export function isTicketRequester(
  payload: unknown,
  ticketId: number,
  requesterId: number,
): boolean {
  if (!Value.Check(actors, payload)) return false;
  return (
    payload.every((actor) => positiveId(actor.tickets_id) === ticketId) &&
    payload.some(
      (actor) =>
        positiveId(actor.users_id) === requesterId &&
        positiveId(actor.type) === 1,
    )
  );
}
