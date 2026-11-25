import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  clientConfigFrom,
  glpiConfigFrom,
  parseServerConfig,
} from "../../src/config.js";
import { createGlpiClient } from "../../src/integrations/glpi/client.js";

const env = {
  ORION_ENV: "test",
  GLPI_API_URL: "https://glpi.example.test/itsm/apirest.php",
  GLPI_APP_TOKEN: "synthetic-glpi-client-token",
  GLPI_USER_TOKEN: "synthetic-glpi-service-token",
};
const config = glpiConfigFrom(parseServerConfig(env))!;
const userEmail = "employee@example.test";
const ticket = {
  requesterId: 37,
  title: "Impressora",
  description: "Linha 1\nLinha <2> & teste",
};
const row = (
  id: number | string,
  email: string | string[],
  active: number | string | boolean = 1,
) => ({ "2": id, "5": email, "8": active });

function page(totalcount: number, data: object[], status = 200) {
  return Response.json({ totalcount, count: data.length, data }, { status });
}

function glpiError(code: string, status: number) {
  return Response.json([code, "synthetic provider detail"], { status });
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (!(input instanceof URL)) throw new Error("Expected an absolute URL");
  return input;
}

it("requires complete server-only credentials and protects the configured target", () => {
  expect(
    glpiConfigFrom(parseServerConfig({ ORION_ENV: "test" })),
  ).toBeUndefined();
  expect(config).toEqual({
    apiUrl: env.GLPI_API_URL,
    appToken: env.GLPI_APP_TOKEN,
    userToken: env.GLPI_USER_TOKEN,
  });
  expect(clientConfigFrom(parseServerConfig(env))).toEqual({});
  for (const missing of ["GLPI_API_URL", "GLPI_APP_TOKEN", "GLPI_USER_TOKEN"])
    expect(() => parseServerConfig({ ...env, [missing]: undefined })).toThrow(
      "incomplete GLPI integration",
    );
  for (const url of [
    "file:///tmp/glpi",
    "http://glpi.example.test/apirest.php",
    "https://user:password@glpi.example.test/apirest.php",
    "https://glpi.example.test/apirest.php?token=synthetic",
    "https://glpi.example.test/apirest.php#fragment",
  ])
    expect(() => parseServerConfig({ ...env, GLPI_API_URL: url })).toThrow(
      "GLPI URL",
    );
  const loopback = {
    ...env,
    GLPI_API_URL: "http://127.0.0.1:18000/apirest.php",
  };
  expect(glpiConfigFrom(parseServerConfig(loopback))?.apiUrl).toBe(
    loopback.GLPI_API_URL,
  );
  expect(() =>
    parseServerConfig({ ...loopback, ORION_ENV: "production" }),
  ).toThrow("GLPI URL");
});

it("checks every page for one exact active email and ignores similar addresses", async () => {
  const fetchGlpi = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ session_token: "session-one" }))
    .mockResolvedValueOnce(
      page(
        3,
        [row(1, "employee@example.test.invalid"), row(2, userEmail, "0")],
        206,
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        totalcount: "3",
        count: "1",
        data: {
          "37": row(
            "37",
            ["alias@example.test", "Employee@EXAMPLE.TEST"],
            true,
          ),
        },
      }),
    );
  const client = createGlpiClient(config, fetchGlpi);
  expect(await client.findActiveUserByEmail(" EMPLOYEE@Example.Test ")).toEqual(
    {
      kind: "found",
      userId: 37,
      email: userEmail,
    },
  );
  expect(fetchGlpi.mock.calls).toHaveLength(3);

  const [loginUrl, login] = fetchGlpi.mock.calls[0];
  expect(requestUrl(loginUrl).pathname).toBe("/itsm/apirest.php/initSession");
  expect(new Headers(login?.headers).get("authorization")).toBe(
    "user_token " + config.userToken,
  );
  expect(new Headers(login?.headers).get("session-token")).toBeNull();
  for (const [input, options] of fetchGlpi.mock.calls.slice(1)) {
    const lookup = requestUrl(input);
    expect(lookup.pathname).toBe("/itsm/apirest.php/search/User");
    expect(lookup.searchParams.get("criteria[0][value]")).toBe(userEmail);
    expect(lookup.searchParams.get("criteria[1][field]")).toBe("8");
    expect(lookup.searchParams.getAll("forcedisplay[1]")).toEqual(["5"]);
    const headers = new Headers(options?.headers);
    expect(headers.get("app-token")).toBe(config.appToken);
    expect(headers.get("session-token")).toBe("session-one");
    expect(headers.get("authorization")).toBeNull();
    expect(options?.redirect).toBe("error");
  }
  expect(requestUrl(fetchGlpi.mock.calls[1][0]).searchParams.get("range")).toBe(
    "0-49",
  );
  expect(requestUrl(fetchGlpi.mock.calls[2][0]).searchParams.get("range")).toBe(
    "2-51",
  );
});

it("leaves ambiguous, absent, malformed or incomplete directory results unlinked", async () => {
  const fetchGlpi = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ session_token: "session-one" }))
    .mockResolvedValueOnce(page(2, [row(1, userEmail)], 206))
    .mockResolvedValueOnce(page(2, [row(2, userEmail)]))
    .mockResolvedValueOnce(Response.json({ totalcount: 0, count: 0 }))
    .mockResolvedValueOnce(page(2, [row(1, userEmail)], 206))
    .mockResolvedValueOnce(page(2, [row(1, userEmail)]))
    .mockResolvedValueOnce(page(1, [{ "2": 37, "5": userEmail }]))
    .mockResolvedValueOnce(glpiError("ERROR_RIGHT_MISSING", 403));
  const client = createGlpiClient(config, fetchGlpi);
  expect(await client.findActiveUserByEmail("invalid address")).toEqual({
    kind: "invalid_email",
  });
  expect(fetchGlpi).not.toHaveBeenCalled();
  expect(await client.findActiveUserByEmail(userEmail)).toEqual({
    kind: "ambiguous",
  });
  expect(await client.findActiveUserByEmail(userEmail)).toEqual({
    kind: "not_found",
  });
  for (let invalid = 0; invalid < 2; invalid++)
    expect(await client.findActiveUserByEmail(userEmail)).toEqual({
      kind: "unavailable",
      reason: "invalid_response",
    });
  expect(await client.findActiveUserByEmail(userEmail)).toEqual({
    kind: "unavailable",
    reason: "permission",
  });
});

it("shares session creation and does not let a late expired-session response reset a new session", async () => {
  let logins = 0;
  let expired = false;
  const releaseLate = Promise.withResolvers<void>();
  const fetchGlpi = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, options) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/initSession"))
        return Response.json({ session_token: "session-" + ++logins });
      const token = new Headers(options?.headers).get("session-token");
      const email = url.searchParams.get("criteria[0][value]") ?? "";
      if (expired && token === "session-1") {
        if (email.startsWith("late@")) await releaseLate.promise;
        return glpiError("ERROR_SESSION_TOKEN_INVALID", 401);
      }
      if (token === "session-2") releaseLate.resolve();
      return page(1, [row(37, email)]);
    });
  const client = createGlpiClient(config, fetchGlpi);
  expect(
    (
      await Promise.all([
        client.findActiveUserByEmail(userEmail),
        client.findActiveUserByEmail("late@example.test"),
      ])
    ).map(({ kind }) => kind),
  ).toEqual(["found", "found"]);
  expect(logins).toBe(1);

  expired = true;
  expect(
    (
      await Promise.all([
        client.findActiveUserByEmail(userEmail),
        client.findActiveUserByEmail("late@example.test"),
      ])
    ).map(({ kind }) => kind),
  ).toEqual(["found", "found"]);
  expect(logins).toBe(2);
  const attempts = fetchGlpi.mock.calls.filter(([input]) =>
    requestUrl(input).pathname.endsWith("/search/User"),
  );
  expect(attempts).toHaveLength(6);
});

it("keeps write acceptance, rejection and unknown outcomes distinct without resending", async () => {
  const fetchGlpi = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(glpiError("ERROR_GLPI_LOGIN_USER_TOKEN", 401))
    .mockResolvedValueOnce(Response.json({ session_token: "session-one" }))
    .mockResolvedValueOnce(glpiError("ERROR_SESSION_TOKEN_INVALID", 401))
    .mockResolvedValueOnce(Response.json({ session_token: "session-two" }))
    .mockResolvedValueOnce(Response.json({ id: "409" }, { status: 201 }))
    .mockResolvedValueOnce(glpiError("ERROR_RIGHT_MISSING", 403))
    .mockResolvedValueOnce(glpiError("ERROR_GLPI_ADD", 400))
    .mockResolvedValueOnce(
      Response.json({ unexpected: "success without ID" }, { status: 201 }),
    )
    .mockRejectedValueOnce(new Error("synthetic socket lost after write"));
  const client = createGlpiClient(config, fetchGlpi);
  expect(await client.createTicket({ ...ticket, requesterId: 0 })).toEqual({
    kind: "not_sent",
    reason: "invalid_input",
  });
  expect(fetchGlpi).not.toHaveBeenCalled();
  expect(await client.createTicket(ticket)).toEqual({
    kind: "not_sent",
    reason: "permission",
  });
  expect(await client.createTicket(ticket)).toEqual({
    kind: "rejected",
    reason: "session",
  });
  expect(fetchGlpi.mock.calls).toHaveLength(3);
  expect(await client.createTicket(ticket)).toEqual({
    kind: "created",
    ticketId: 409,
  });
  expect(await client.createTicket(ticket)).toEqual({
    kind: "rejected",
    reason: "permission",
  });
  expect(await client.createTicket(ticket)).toEqual({
    kind: "uncertain",
    reason: "invalid_response",
  });
  expect(await client.createTicket(ticket)).toEqual({
    kind: "uncertain",
    reason: "invalid_response",
  });
  expect(await client.createTicket(ticket)).toEqual({
    kind: "uncertain",
    reason: "transport",
  });
  expect(fetchGlpi.mock.calls).toHaveLength(9);

  const [input, options] = fetchGlpi.mock.calls[4];
  expect(requestUrl(input).pathname).toBe("/itsm/apirest.php/Ticket");
  expect(options?.method).toBe("POST");
  expect(options?.body).toBe(
    JSON.stringify({
      input: {
        name: "Impressora",
        content: "Linha 1<br>Linha &lt;2&gt; &amp; teste",
        _users_id_requester: 37,
      },
    }),
  );
  expect(new Headers(options?.headers).get("authorization")).toBeNull();
});

it("bounds a dispatched write and leaves a timeout uncertain", async () => {
  const fetchGlpi = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ session_token: "session-one" }))
    .mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("synthetic time limit")),
            { once: true },
          );
        }),
    );
  const startedAt = Date.now();
  expect(
    await createGlpiClient(config, fetchGlpi).createTicket(ticket),
  ).toEqual({
    kind: "uncertain",
    reason: "timeout",
  });
  expect(Date.now() - startedAt).toBeLessThan(6000);
  expect(fetchGlpi.mock.calls).toHaveLength(2);
}, 8000);

it("does not follow a provider redirect on the real HTTP transport", async () => {
  let redirected = false;
  const server = createServer((request, response) => {
    if (request.url === "/glpi/apirest.php/initSession") {
      response.writeHead(302, { location: "/unexpected" }).end();
    } else {
      redirected = true;
      response.writeHead(200).end('{"session_token":"unrelated"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local fixture port");
    const loopback = glpiConfigFrom(
      parseServerConfig({
        ...env,
        GLPI_API_URL: "http://127.0.0.1:" + address.port + "/glpi/apirest.php",
      }),
    )!;
    expect(
      await createGlpiClient(loopback).findActiveUserByEmail(userEmail),
    ).toEqual({
      kind: "unavailable",
      reason: "transport",
    });
    expect(redirected).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
