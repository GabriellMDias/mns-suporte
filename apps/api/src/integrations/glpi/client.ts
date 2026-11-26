import { decodeHTML } from "entities";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { GlpiConfig } from "../../config.js";
import { normalizeEmail } from "../../email-address.js";
import {
  directoryQuery,
  isSupportedSenderPhone,
  phoneDirectoryQuery,
  positiveId,
  readDirectoryPage,
  readPhoneDirectoryPage,
} from "./directory.js";
import {
  isTicketRequester,
  readTicketCandidates,
  ticketPageSize,
  ticketSearch,
  type TicketLookupResult,
  type TicketQuery,
} from "./ticket-lookup.js";

type IoFailure = "timeout" | "transport" | "invalid_response";
type RequestFailure = IoFailure | "permission";
type HttpResult =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "request_failed"; reason: IoFailure };
type Session = { token: string };
type OperationResult =
  HttpResult | { kind: "not_sent"; reason: RequestFailure };
type DirectoryResult =
  | { kind: "found"; userId: number }
  | { kind: "not_found" | "ambiguous" }
  | { kind: "unavailable"; reason: RequestFailure | "directory_limit" };
type CreateTicketResult =
  | { kind: "created"; ticketId: number }
  | { kind: "not_sent"; reason: RequestFailure | "invalid_input" }
  | { kind: "rejected"; reason: "session" | "permission" | "invalid_input" }
  | { kind: "uncertain"; reason: IoFailure };
type MutationFailure = Exclude<CreateTicketResult, { kind: "created" }>;
export type TicketActivity = {
  followups: { id: number; text?: string }[];
  solution?: string;
};
type UploadResult = MutationFailure | { kind: "attached" };

type Ticket = Readonly<{
  requesterId: number;
  title: string;
  description: string;
}>;
type Operation =
  | { path: "search/User"; query: URLSearchParams }
  | { path: "search/Ticket"; query: URLSearchParams }
  | { path: `Ticket/${number}`; query: URLSearchParams }
  | {
      path: `Ticket/${number}/${"Ticket_User" | "ITILFollowup" | "ITILSolution"}`;
      query: URLSearchParams;
    }
  | { path: "Ticket"; input: object }
  | { path: "Document"; input: FormData };
const tokenSchema = Type.Object({
  session_token: Type.String({ pattern: "^[A-Za-z0-9._~+/=-]{1,256}$" }),
});
const createdItemSchema = Type.Object({ id: Type.Unknown() });
const documentListSchema = Type.Object({
  id: Type.Unknown(),
  _documents: Type.Array(createdItemSchema),
});
const permissionErrors = new Set([
  "ERROR_RIGHT_MISSING",
  "ERROR_NOT_ALLOWED_IP",
  "ERROR_WRONG_APP_TOKEN_PARAMETER",
  "ERROR_APP_TOKEN_PARAMETERS_MISSING",
  "ERROR_GLPI_LOGIN_USER_TOKEN",
  "ERROR_GLPI_LOGIN",
]);
const pageSize = 50;
const pageLimit = 10;

function protocolCode(result: HttpResult): string | undefined {
  if (
    result.kind !== "response" ||
    result.status < 400 ||
    result.status >= 500 ||
    !Array.isArray(result.body)
  )
    return undefined;
  const code: unknown = result.body[0];
  return typeof code === "string" ? code : undefined;
}

function sessionExpired(result: HttpResult): boolean {
  return (
    result.kind === "response" &&
    result.status === 401 &&
    protocolCode(result) === "ERROR_SESSION_TOKEN_INVALID"
  );
}

function responseFailure(result: HttpResult): RequestFailure {
  if (result.kind === "request_failed") return result.reason;
  if (
    result.status === 401 ||
    result.status === 403 ||
    permissionErrors.has(protocolCode(result) ?? "")
  )
    return "permission";
  if (result.status >= 500 || result.status === 429) return "transport";
  return "invalid_response";
}

function mutationResult(
  reply: OperationResult,
): MutationFailure | { kind: "created"; id: number } {
  if (reply.kind === "not_sent") return reply;
  if (reply.kind === "request_failed")
    return { kind: "uncertain", reason: reply.reason };
  if (reply.status === 201 && Value.Check(createdItemSchema, reply.body)) {
    const id = positiveId(reply.body.id);
    if (id) return { kind: "created", id };
  }
  const code = protocolCode(reply);
  if (sessionExpired(reply)) return { kind: "rejected", reason: "session" };
  if (code && permissionErrors.has(code))
    return { kind: "rejected", reason: "permission" };
  if (
    reply.status === 400 &&
    (code === "ERROR_BAD_ARRAY" ||
      code === "ERROR_UPLOAD_FILE_TOO_BIG_POST_MAX_SIZE")
  )
    return { kind: "rejected", reason: "invalid_input" };
  // A gateway or GLPI extension can fail after the database writes.
  return {
    kind: "uncertain",
    reason: reply.status >= 500 ? "transport" : "invalid_response",
  };
}

function ticketInput(ticket: Ticket) {
  const title = ticket.title.trim();
  const description = ticket.description.trim();
  if (
    !Number.isSafeInteger(ticket.requesterId) ||
    ticket.requesterId < 1 ||
    title.length === 0 ||
    title.length > 255 ||
    description.length === 0 ||
    description.length > 16_000 ||
    !title.isWellFormed() ||
    !description.isWellFormed() ||
    /\p{Cc}/u.test(title) ||
    description.includes("\u0000")
  )
    return undefined;

  // GLPI renders ticket descriptions as HTML. Convert plain text at the boundary.
  const escaped = description
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character] ?? character,
    )
    .replace(/\r\n|\r|\n/g, "<br>");
  return {
    name: title,
    content: escaped,
    _users_id_requester: ticket.requesterId,
  };
}

function publicText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = decodeHTML(value.slice(0, 32_000))
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|tr|h[1-6])\s*)>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/[\p{Cc}&&[^\n\t]]/gv, "")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return text.slice(0, 3000).toWellFormed() || undefined;
}

function publicFlag(flag: unknown, absentIsPublic = false): boolean {
  return (
    flag === false ||
    flag === 0 ||
    flag === "0" ||
    (absentIsPublic && flag === undefined)
  );
}

function children(payload: unknown, ticketId: number) {
  if (!Array.isArray(payload)) return undefined;
  const items = Type.Array(
    Type.Object({
      id: Type.Unknown(),
      itemtype: Type.Literal("Ticket"),
      items_id: Type.Unknown(),
      content: Type.Optional(Type.Unknown()),
      is_private: Type.Optional(Type.Unknown()),
      users_id: Type.Optional(Type.Unknown()),
      timeline_position: Type.Optional(Type.Unknown()),
      status: Type.Optional(Type.Unknown()),
      date_creation: Type.Optional(Type.Unknown()),
    }),
  );
  if (
    !Value.Check(items, payload) ||
    !payload.every(
      (row) => positiveId(row.items_id) === ticketId && positiveId(row.id),
    )
  )
    return undefined;
  return payload;
}

export function createGlpiClient(config: GlpiConfig, fetchGlpi = fetch) {
  type SessionResult =
    | { kind: "active"; session: Session }
    | { kind: "not_sent"; reason: RequestFailure };
  let active: Session | undefined;
  let opening: Promise<SessionResult> | undefined;
  const baseUrl = config.apiUrl.replace(/\/+$/, "") + "/";

  async function request(
    url: URL,
    authHeaders: Record<string, string>,
    input?: object,
    budget?: AbortSignal,
  ): Promise<HttpResult> {
    const multipart = input instanceof FormData;
    const requestTimeout = AbortSignal.timeout(multipart ? 16_000 : 3500);
    const signal = budget
      ? AbortSignal.any([requestTimeout, budget])
      : requestTimeout;
    let response: Response;
    try {
      response = await fetchGlpi(url, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...(multipart ? {} : { "content-type": "application/json" }),
          "app-token": config.appToken,
          ...authHeaders,
        },
        ...(input === undefined
          ? {}
          : { body: multipart ? input : JSON.stringify({ input }) }),
        redirect: "error",
        signal,
      });
    } catch {
      return {
        kind: "request_failed",
        reason: signal.aborted ? "timeout" : "transport",
      };
    }
    try {
      const body: unknown = await response.json();
      return { kind: "response", status: response.status, body };
    } catch {
      return {
        kind: "request_failed",
        reason: signal.aborted ? "timeout" : "invalid_response",
      };
    }
  }

  async function openSession(): Promise<SessionResult> {
    const result = await request(new URL("initSession", baseUrl), {
      authorization: "user_token " + config.userToken,
    });
    if (
      result.kind === "response" &&
      result.status === 200 &&
      Value.Check(tokenSchema, result.body)
    ) {
      active = { token: result.body.session_token };
      return { kind: "active", session: active };
    }
    return { kind: "not_sent", reason: responseFailure(result) };
  }

  function ensureSession(): Promise<SessionResult> {
    if (active) return Promise.resolve({ kind: "active", session: active });
    opening ??= openSession().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  async function run(
    operation: Operation,
    budget: AbortSignal,
  ): Promise<OperationResult> {
    const url = new URL(operation.path, baseUrl);
    if ("query" in operation) url.search = operation.query.toString();
    const attempts = "query" in operation ? 2 : 1;
    for (let attempt = 0; ; attempt++) {
      if (budget.aborted) return { kind: "not_sent", reason: "timeout" };
      const session = await ensureSession();
      if (session.kind === "not_sent") return session;
      if (budget.aborted) return { kind: "not_sent", reason: "timeout" };

      const reply = await request(
        url,
        { "session-token": session.session.token },
        "input" in operation ? operation.input : undefined,
        budget,
      );
      if (!sessionExpired(reply)) return reply;
      // A late response using an old session must not evict a newer one.
      if (active === session.session) active = undefined;
      if (attempt + 1 >= attempts) return reply;
    }
  }

  async function searchDirectory(
    query: (offset: number) => URLSearchParams,
    readPage: (
      payload: unknown,
      offset: number,
    ) =>
      | { total: number; candidates: { id: number; matches: boolean }[] }
      | undefined,
  ): Promise<DirectoryResult> {
    const budget = AbortSignal.timeout(8000);
    let offset = 0;
    let expectedTotal: number | undefined;
    let match: number | undefined;
    const seen = new Set<number>();
    for (let page = 0; page < pageLimit; page++) {
      const reply = await run(
        {
          path: "search/User",
          query: query(offset),
        },
        budget,
      );
      if (reply.kind === "not_sent")
        return { kind: "unavailable", reason: reply.reason };
      if (
        reply.kind !== "response" ||
        (reply.status !== 200 && reply.status !== 206)
      )
        return { kind: "unavailable", reason: responseFailure(reply) };
      const batch = readPage(reply.body, offset);
      if (
        !batch ||
        (expectedTotal !== undefined && expectedTotal !== batch.total)
      )
        return { kind: "unavailable", reason: "invalid_response" };
      expectedTotal = batch.total;

      for (const user of batch.candidates) {
        if (seen.has(user.id))
          return { kind: "unavailable", reason: "invalid_response" };
        seen.add(user.id);
        if (!user.matches) continue;
        if (match !== undefined) return { kind: "ambiguous" };
        match = user.id;
      }
      offset += batch.candidates.length;
      if (offset === batch.total)
        return match === undefined
          ? { kind: "not_found" }
          : { kind: "found", userId: match };
    }
    return { kind: "unavailable", reason: "directory_limit" };
  }

  return {
    async findActiveUserByEmail(input: string) {
      const email = normalizeEmail(input);
      if (!email) return { kind: "invalid_email" } as const;
      const result = await searchDirectory(
        (offset) => directoryQuery(email, offset, pageSize),
        (payload, offset) => {
          const batch = readDirectoryPage(payload, offset, pageSize);
          if (!batch) return undefined;
          return {
            total: batch.total,
            candidates: batch.candidates.map(({ id, active, emails }) => ({
              id,
              matches:
                active &&
                emails.some((candidate) => normalizeEmail(candidate) === email),
            })),
          };
        },
      );
      return result.kind === "found" ? { ...result, email } : result;
    },

    async isUniqueActiveUserPhone(
      this: void,
      phone: string,
      expectedUserId: number,
    ) {
      if (!isSupportedSenderPhone(phone)) return false;
      const result = await searchDirectory(
        (offset) => phoneDirectoryQuery(phone, offset, pageSize),
        (payload, offset) =>
          readPhoneDirectoryPage(payload, offset, pageSize, phone),
      );
      return result.kind === "found" && result.userId === expectedUserId;
    },

    async readOwnedTickets(
      this: void,
      requesterId: number,
      query: TicketQuery,
      signal: AbortSignal,
    ): Promise<TicketLookupResult> {
      const target = query.kind === "detail" ? query.ticketId : query.before;
      if (
        !positiveId(requesterId) ||
        (target !== undefined && !positiveId(target))
      )
        return { kind: "unavailable" };
      const budget = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const response = await run(
        { path: "search/Ticket", query: ticketSearch(requesterId, query) },
        budget,
      );
      if (
        response.kind !== "response" ||
        (response.status !== 200 && response.status !== 206)
      )
        return { kind: "unavailable" };
      const candidates = readTicketCandidates(response.body, query);
      if (!candidates) return { kind: "unavailable" };
      const ownership = await Promise.all(
        candidates.map(async ({ id }) => {
          const reply = await run(
            {
              path: `Ticket/${id}/Ticket_User`,
              query: new URLSearchParams({
                range: "0-4",
                get_hateoas: "false",
                "searchText[users_id]": "^" + requesterId + "$",
                "searchText[type]": "^1$",
              }),
            },
            budget,
          );
          if (reply.kind !== "response") return undefined;
          if (reply.status === 404) return false;
          if (reply.status !== 200 && reply.status !== 206) return undefined;
          return isTicketRequester(reply.body, id, requesterId);
        }),
      );
      if (ownership.includes(undefined)) return { kind: "unavailable" };
      if (ownership.includes(false))
        return query.kind === "detail"
          ? { kind: "ready", tickets: [] }
          : { kind: "unavailable" };
      const tickets = candidates.slice(0, ticketPageSize);
      return {
        kind: "ready",
        tickets,
        ...(candidates.length > ticketPageSize
          ? { nextBefore: tickets[ticketPageSize - 1].id }
          : {}),
      };
    },

    async readTicketActivity(
      this: void,
      ticketId: number,
      status: number,
      afterFollowupId: number,
      signal: AbortSignal,
    ): Promise<TicketActivity | undefined> {
      if (!positiveId(ticketId)) return undefined;
      const budget = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const base = `Ticket/${ticketId}` as const;
      const actors = await run(
        {
          path: `${base}/Ticket_User`,
          query: new URLSearchParams({ range: "0-199" }),
        },
        budget,
      );
      const actorList = Type.Array(
        Type.Object({
          tickets_id: Type.Unknown(),
          type: Type.Unknown(),
          users_id: Type.Unknown(),
        }),
      );
      if (
        actors.kind !== "response" ||
        actors.status !== 200 ||
        !Value.Check(actorList, actors.body)
      )
        return undefined;
      const technicianIds = new Set(
        actors.body.flatMap((actor) =>
          positiveId(actor?.tickets_id) === ticketId &&
          positiveId(actor?.type) === 2
            ? [positiveId(actor.users_id)]
            : [],
        ),
      );
      const followups: TicketActivity["followups"] = [];
      for (let page = 0; page < pageLimit; page++) {
        const offset = page * pageSize;
        const reply = await run(
          {
            path: `${base}/ITILFollowup`,
            query: new URLSearchParams({
              range: `${offset}-${offset + pageSize - 1}`,
              sort: "id",
              order: "ASC",
            }),
          },
          budget,
        );
        if (reply.kind !== "response" || ![200, 206].includes(reply.status))
          return undefined;
        const batch = children(reply.body, ticketId);
        if (!batch || (reply.status === 206 && batch.length !== pageSize))
          return undefined;
        for (const row of batch) {
          const id = positiveId(row.id)!;
          if (id <= afterFollowupId) continue;
          const author = positiveId(row.users_id);
          followups.push({
            id,
            text:
              author &&
              publicFlag(row.is_private) &&
              (technicianIds.has(author) ||
                positiveId(row.timeline_position) === 4)
                ? publicText(row.content)
                : undefined,
          });
        }
        if (reply.status === 200) break;
        if (page + 1 === pageLimit) return undefined;
      }
      followups.sort((left, right) => left.id - right.id);
      if (status !== 6) return { followups };
      const [ticket, solutions] = await Promise.all([
        run(
          { path: base, query: new URLSearchParams({ get_hateoas: "false" }) },
          budget,
        ),
        run(
          {
            path: `${base}/ITILSolution`,
            query: new URLSearchParams({
              range: "0-49",
              sort: "id",
              order: "DESC",
            }),
          },
          budget,
        ),
      ]);
      const ticketSchema = Type.Object({
        id: Type.Unknown(),
        status: Type.Unknown(),
        solvedate: Type.Optional(Type.Unknown()),
      });
      if (
        ticket.kind !== "response" ||
        ticket.status !== 200 ||
        !Value.Check(ticketSchema, ticket.body) ||
        positiveId(ticket.body.id) !== ticketId ||
        positiveId(ticket.body.status) !== 6 ||
        solutions.kind !== "response" ||
        ![200, 206].includes(solutions.status)
      )
        return undefined;
      const rows = children(solutions.body, ticketId);
      if (!rows) return undefined;
      const solvedAt = ticket.body.solvedate;
      const active = rows.find(
        (row) =>
          typeof solvedAt === "string" &&
          row.date_creation === solvedAt &&
          positiveId(row.status) === 3 &&
          publicFlag(row.is_private, true),
      );
      return { followups, solution: publicText(active?.content) };
    },

    async createTicket(
      ticket: Ticket,
      signal?: AbortSignal,
    ): Promise<CreateTicketResult> {
      const input = ticketInput(ticket);
      if (!input) return { kind: "not_sent", reason: "invalid_input" };
      const timeout = AbortSignal.timeout(8000);
      const result = mutationResult(
        await run(
          { path: "Ticket", input },
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        ),
      );
      return result.kind === "created"
        ? { kind: "created", ticketId: result.id }
        : result;
    },

    async attachDocument(
      ticketId: number,
      filename: string,
      file: Blob,
      signal: AbortSignal,
    ): Promise<UploadResult> {
      if (
        !positiveId(ticketId) ||
        !/^[a-z0-9-]{1,100}\.[a-z0-9]{2,5}$/.test(filename)
      )
        return { kind: "not_sent", reason: "invalid_input" };
      const upload = new FormData();
      upload.set(
        "uploadManifest",
        JSON.stringify({
          input: {
            name: filename,
            _filename: [filename],
            itemtype: "Ticket",
            items_id: ticketId,
          },
        }),
      );
      upload.set("filename[0]", file, filename);
      const budget = AbortSignal.any([signal, AbortSignal.timeout(22_000)]);
      const result = mutationResult(
        await run({ path: "Document", input: upload }, budget),
      );
      if (result.kind !== "created") return result;
      const reply = await run(
        {
          path: `Ticket/${ticketId}`,
          query: new URLSearchParams({
            with_documents: "true",
            get_hateoas: "false",
          }),
        },
        budget,
      );
      if (
        reply.kind === "response" &&
        reply.status === 200 &&
        Value.Check(documentListSchema, reply.body) &&
        positiveId(reply.body.id) === ticketId &&
        reply.body._documents.some(({ id }) => positiveId(id) === result.id)
      )
        return { kind: "attached" };
      return { kind: "uncertain", reason: "invalid_response" };
    },
  };
}
