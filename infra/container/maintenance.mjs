import console from "node:console";
import { setTimeout as wait } from "node:timers/promises";
import pg from "pg";
import { databaseUrl } from "./database.mjs";

const shutdown = new globalThis.AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());
const once = process.argv.includes("--once");
const environment = ["development", "test", "production"].includes(
  process.env.ORION_ENV,
)
  ? process.env.ORION_ENV
  : "unknown";
const release = /^[A-Za-z0-9._-]{1,128}$/u.test(
  process.env.ORION_RELEASE_ID ?? "",
)
  ? process.env.ORION_RELEASE_ID
  : "unknown";
const enabled = environment === "production" || once;

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, environment, release, ...fields }));
}

async function apiReady() {
  try {
    const response = await fetch("http://api:3000/health/ready", {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function run(pool) {
  const active = new Set();
  let nextPrune = 0;
  let readinessMisses = 0;
  log("maintenance_started");
  do {
    const now = Date.now();
    const signals = new Map();
    readinessMisses = (await apiReady()) ? 0 : readinessMisses + 1;
    signals.set("api_readiness", readinessMisses >= 2);
    try {
      if (enabled && now >= nextPrune) {
        const { rows } = await pool.query("SELECT mns_ops.prune() AS report");
        log("retention_completed", { counts: rows[0].report });
        nextPrune = now + 60 * 60_000;
      }
      const { rows } = await pool.query("SELECT mns_ops.signals() AS signals");
      for (const [condition, value] of Object.entries(rows[0].signals))
        signals.set(condition, value);
      signals.set("maintenance_database", false);
    } catch {
      signals.set("maintenance_database", true);
      if (once) process.exitCode = 1;
    }
    if (enabled) {
      for (const [condition, value] of signals) {
        if (value === active.has(condition)) continue;
        if (value) active.add(condition);
        else active.delete(condition);
        log("operational_alert", {
          condition,
          state: value ? "firing" : "resolved",
        });
      }
    }
    if (!once && !shutdown.signal.aborted)
      await wait(60_000, undefined, { signal: shutdown.signal });
  } while (!once && !shutdown.signal.aborted);
}

let pool;
try {
  pool = new pg.Pool({
    connectionString: databaseUrl("mns_maintenance"),
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    statement_timeout: 20000,
  });
  pool.on("error", () => log("maintenance_connection_lost"));
  await run(pool);
} catch {
  if (!shutdown.signal.aborted) {
    log("maintenance_failed");
    process.exitCode = 1;
  }
} finally {
  await pool?.end();
}
