import { readFileSync } from "node:fs";
import { URL } from "node:url";

export function databaseUrl(role) {
  const password = readFileSync(
    "/run/secrets/database_password",
    "utf8",
  ).replace(/\r?\n$/, "");
  if (
    !password ||
    ["\r", "\n", "\u0000"].some((character) => password.includes(character))
  )
    throw new Error("Invalid database credential");
  const url = new URL("postgresql://db:5432/mns_suporte");
  url.username = role;
  url.password = encodeURIComponent(password);
  return url.href;
}
