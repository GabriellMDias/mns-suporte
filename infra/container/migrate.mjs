import { spawnSync } from "node:child_process";
import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "./database.mjs";

try {
  const connectionString = databaseUrl("mns_migration");
  const migration = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, ORION_MIGRATION_DATABASE_URL: connectionString },
      stdio: "ignore",
      timeout: 120_000,
    },
  );
  if (migration.status !== 0) throw new Error("Database migration failed");
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  await client.connect();
  try {
    const directory = new URL("../prisma/runtime-grants/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const grants = await Promise.all(
      files.map((name) => readFile(new URL(name, directory), "utf8")),
    );
    const maintenance = await readFile(
      new URL("maintenance.sql", import.meta.url),
      "utf8",
    );
    await client.query(
      ["BEGIN;", ...grants, maintenance, "COMMIT;"].join("\n"),
    );
  } finally {
    await client.end();
  }
  console.log(
    JSON.stringify({ level: "info", event: "database_deployment_ready" }),
  );
} catch {
  console.error(
    JSON.stringify({ level: "error", event: "database_deployment_failed" }),
  );
  process.exitCode = 1;
}
