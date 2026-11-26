import { spawn } from "node:child_process";
import console from "node:console";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dirname, "..");
const loopback = "127.0.0.1";
const webhookPath = "/webhooks/whatsapp";
const [expectedPhoneId] = process.argv.slice(2);
const children = [];
let proxy;
let stopping = false;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children.reverse()) child.kill();
  proxy?.close();
  proxy?.closeAllConnections();
}

function launch(command, args, options) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...options,
  });
  children.push(child);
  child.on("exit", () => stop(1));
  child.on("error", () => stop(1));
  return child;
}

function findLine(stream, child, matches, description) {
  return new Promise((ready, reject) => {
    const input = createInterface({ input: stream });
    const timeout = setTimeout(() => finish(), 45_000);
    const exited = () => finish();
    const line = (value) => {
      const result = matches(value);
      if (result) finish(result);
    };
    function finish(value) {
      clearTimeout(timeout);
      input.close();
      stream.resume();
      child.off("exit", exited);
      child.off("error", exited);
      if (value) ready(value);
      else reject(new Error(description + " did not become available"));
    }
    input.on("line", line);
    child.once("exit", exited);
    child.once("error", exited);
  });
}

function proxyWebhook(port) {
  return createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (incoming, outgoing) => {
      const path = incoming.url;
      if (path?.split("?", 1)[0] !== webhookPath) {
        outgoing.writeHead(404).end();
        return;
      }
      if (incoming.method !== "GET" && incoming.method !== "POST") {
        outgoing.writeHead(405, { Allow: "GET, POST" }).end();
        return;
      }
      const headers = {};
      for (const name of [
        "content-type",
        "content-length",
        "x-hub-signature-256",
      ]) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const upstream = request(
        { host: loopback, port, path, method: incoming.method, headers },
        (response) => {
          const type = response.headers["content-type"];
          const status = response.statusCode ?? 502;
          outgoing.writeHead(
            status,
            typeof type === "string" ? { "content-type": type } : {},
          );
          if (status === 200)
            console.log("webhook_accepted " + incoming.method);
          response.pipe(outgoing);
          response.on("error", () => outgoing.destroy());
        },
      );
      upstream.setTimeout(8000, () => upstream.destroy());
      upstream.on("error", () => {
        if (outgoing.headersSent) outgoing.destroy();
        else outgoing.writeHead(502).end();
      });
      outgoing.on("close", () => upstream.destroy());
      incoming.on("error", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

try {
  const local = parseEnv(readFileSync(resolve(root, ".env.local"), "utf8"));
  const database = new URL(local.ORION_DATABASE_URL);
  if (
    database.protocol !== "postgresql:" ||
    database.hostname !== loopback ||
    database.port !== "55432" ||
    database.pathname !== "/mns_suporte" ||
    database.username !== "orion_runtime" ||
    !database.password
  )
    throw new Error("The isolated local pilot database is required");
  if (
    !/^\d{5,30}$/u.test(expectedPhoneId ?? "") ||
    local.WHATSAPP_PHONE_NUMBER_ID !== expectedPhoneId ||
    !local.WHATSAPP_APP_SECRET ||
    !local.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  )
    throw new Error(
      "The authorized pilot phone ID and webhook settings are required",
    );

  // The receiver starts without provider credentials that could send messages or open tickets.
  const runtime = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:ORION_|WHATSAPP_|GLPI_|IDENTITY_)/iu.test(key),
    ),
  );
  const api = launch(process.execPath, ["dist/main.js"], {
    cwd: resolve(root, "apps/api"),
    env: {
      ...runtime,
      ORION_ENV: "test",
      ORION_API_HOST: loopback,
      ORION_API_PORT: "0",
      ORION_DATABASE_URL: local.ORION_DATABASE_URL,
      WHATSAPP_APP_SECRET: local.WHATSAPP_APP_SECRET,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: local.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: local.WHATSAPP_PHONE_NUMBER_ID,
    },
  });
  api.stderr.resume();
  const port = await findLine(
    api.stdout,
    api,
    (line) => {
      try {
        const entry = JSON.parse(line);
        return entry.msg === "api_ready" && entry.address?.port;
      } catch {
        return undefined;
      }
    },
    "The local API",
  );
  const readiness = await fetch(
    "http://" + loopback + ":" + port + "/health/ready",
    {
      signal: AbortSignal.timeout(5000),
    },
  );
  if (readiness.status !== 200) throw new Error("Local API readiness failed");
  await readiness.arrayBuffer();
  console.log("local_api_ready " + port);

  proxy = proxyWebhook(port);
  proxy.listen(0, loopback);
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("Webhook proxy address unavailable");
  const proxyOrigin = "http://" + loopback + ":" + address.port;
  const denied = await fetch(proxyOrigin + "/health/ready", {
    signal: AbortSignal.timeout(3000),
  });
  if (denied.status !== 404)
    throw new Error("The proxy exposed a private API route");
  await denied.arrayBuffer();
  const tunnel = launch(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", proxyOrigin],
    { cwd: root },
  );
  tunnel.stdout.resume();
  const origin = await findLine(
    tunnel.stderr,
    tunnel,
    (line) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/u.exec(line)?.[0],
    "The Cloudflare Quick Tunnel",
  );
  console.log("pilot_callback " + origin + webhookPath);
} catch (error) {
  // Never print endpoint credentials from file, child logs, or HTTP requests.
  console.error(
    error instanceof TypeError
      ? "Invalid local pilot configuration"
      : error.message,
  );
  stop(1);
}
