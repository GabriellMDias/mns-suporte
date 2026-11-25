import { Type } from "typebox";
import { Value } from "typebox/value";
import type { GlpiConfig } from "../../config.js";
import {
  directoryQuery,
  normalizeEmail,
  positiveId,
  readDirectoryPage,
} from "./directory.js";

type IoFailure = "timeout" | "transport" | "invalid_response";
type RequestFailure = IoFailure | "permission";
type HttpResult =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "request_failed"; reason: IoFailure };
type Session = { token: string };
type OperationResult =
  HttpResult | { kind: "not_sent"; reason: RequestFailure };
type DirectoryResult =
  | { kind: "found"; userId: number; email: string }
  | { kind: "not_found" | "ambiguous" | "invalid_email" }
  | { kind: "unavailable"; reason: RequestFailure | "directory_limit" };
type CreateTicketResult =
  | { kind: "created"; ticketId: number }
  | { kind: "not_sent"; reason: RequestFailure | "invalid_input" }
  | { kind: "rejected"; reason: "session" | "permission" | "invalid_input" }
  | { kind: "uncertain"; reason: IoFailure };

type Ticket = Readonly<{
  requesterId: number;
  title: string;
  description: string;
}>;
type Operation =
  | { path: "search/User"; query: URLSearchParams }
  | { path: "Ticket"; input: object };
const tokenSchema = Type.Object({
  session_token: Type.String({ pattern: "^[A-Za-z0-9._~+/=-]{1,256}$" }),
});
const createdTicketSchema = Type.Object({ id: Type.Unknown() });
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
    const requestTimeout = AbortSignal.timeout(3500);
    const signal = budget
      ? AbortSignal.any([requestTimeout, budget])
      : requestTimeout;
    let response: Response;
    try {
      response = await fetchGlpi(url, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "app-token": config.appToken,
          ...authHeaders,
        },
        ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
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
    if (operation.path === "search/User")
      url.search = operation.query.toString();
    const attempts = operation.path === "search/User" ? 2 : 1;
    for (let attempt = 0; ; attempt++) {
      if (budget.aborted) return { kind: "not_sent", reason: "timeout" };
      const session = await ensureSession();
      if (session.kind === "not_sent") return session;
      if (budget.aborted) return { kind: "not_sent", reason: "timeout" };

      const reply = await request(
        url,
        { "session-token": session.session.token },
        operation.path === "Ticket" ? operation.input : undefined,
        budget,
      );
      if (!sessionExpired(reply)) return reply;
      // A late response using an old session must not evict a newer one.
      if (active === session.session) active = undefined;
      if (attempt + 1 >= attempts) return reply;
    }
  }

  return {
    async findActiveUserByEmail(input: string): Promise<DirectoryResult> {
      const email = normalizeEmail(input);
      if (!email) return { kind: "invalid_email" };
      const budget = AbortSignal.timeout(8000);
      let offset = 0;
      let expectedTotal: number | undefined;
      let match: number | undefined;
      const seen = new Set<number>();
      for (let page = 0; page < pageLimit; page++) {
        const reply = await run(
          {
            path: "search/User",
            query: directoryQuery(email, offset, pageSize),
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
        const batch = readDirectoryPage(reply.body, offset, pageSize);
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
          if (
            !user.active ||
            !user.emails.some(
              (candidate) => normalizeEmail(candidate) === email,
            )
          )
            continue;
          if (match !== undefined) return { kind: "ambiguous" };
          match = user.id;
        }
        offset += batch.candidates.length;
        if (offset === batch.total)
          return match === undefined
            ? { kind: "not_found" }
            : { kind: "found", userId: match, email };
      }
      return { kind: "unavailable", reason: "directory_limit" };
    },

    async createTicket(ticket: Ticket): Promise<CreateTicketResult> {
      const input = ticketInput(ticket);
      if (!input) return { kind: "not_sent", reason: "invalid_input" };
      const reply = await run(
        { path: "Ticket", input },
        AbortSignal.timeout(8000),
      );
      if (reply.kind === "not_sent") return reply;
      if (reply.kind === "request_failed")
        return { kind: "uncertain", reason: reply.reason };
      if (
        reply.status === 201 &&
        Value.Check(createdTicketSchema, reply.body)
      ) {
        const ticketId = positiveId(reply.body.id);
        if (ticketId) return { kind: "created", ticketId };
      }
      const code = protocolCode(reply);
      if (sessionExpired(reply)) return { kind: "rejected", reason: "session" };
      if (code && permissionErrors.has(code))
        return { kind: "rejected", reason: "permission" };
      if (reply.status === 400 && code === "ERROR_BAD_ARRAY")
        return { kind: "rejected", reason: "invalid_input" };
      // A gateway or GLPI extension can fail after the database writes.
      return {
        kind: "uncertain",
        reason: reply.status >= 500 ? "transport" : "invalid_response",
      };
    },
  };
}
