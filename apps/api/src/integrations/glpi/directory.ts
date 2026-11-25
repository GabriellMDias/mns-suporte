import { Type } from "typebox";
import { Value } from "typebox/value";

const nonnegativeInteger = Type.Union([
  Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  Type.String({ pattern: "^[0-9]{1,16}$" }),
]);
const pageMetadata = Type.Object({
  totalcount: nonnegativeInteger,
  count: nonnegativeInteger,
  data: Type.Optional(Type.Unknown()),
});
const rowSchema = Type.Object({
  "2": nonnegativeInteger,
  "5": Type.Union([Type.String(), Type.Array(Type.String())]),
  "8": Type.Union([
    Type.Boolean(),
    Type.Literal(1),
    Type.Literal(0),
    Type.Literal("1"),
    Type.Literal("0"),
  ]),
});

export function positiveId(value: unknown): number | undefined {
  if (!Value.Check(nonnegativeInteger, value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function normalizeEmail(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const [local] = normalized.split("@");
  return normalized.length <= 254 &&
    local.length <= 64 &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      normalized,
    )
    ? normalized
    : undefined;
}

export function directoryQuery(
  email: string,
  start: number,
  pageSize: number,
): URLSearchParams {
  // GLPI v1 email searches use contains semantics. Check candidate addresses
  // independently because the server can return aliases and similar addresses.
  return new URLSearchParams({
    "criteria[0][field]": "5",
    "criteria[0][searchtype]": "contains",
    "criteria[0][value]": email,
    "criteria[1][link]": "AND",
    "criteria[1][field]": "8",
    "criteria[1][searchtype]": "equals",
    "criteria[1][value]": "1",
    "forcedisplay[0]": "2",
    "forcedisplay[1]": "5",
    "forcedisplay[2]": "8",
    sort: "2",
    order: "ASC",
    range: start + "-" + (start + pageSize - 1),
  });
}

function pageRows(data: unknown): unknown[] | undefined {
  if (data === undefined) return [];
  if (Array.isArray(data)) return data as unknown[];
  if (
    data &&
    typeof data === "object" &&
    Object.keys(data).every((key) => /^[0-9]+$/.test(key))
  )
    return Object.values(data as Record<string, unknown>);
  return undefined;
}

export function readDirectoryPage(
  payload: unknown,
  start: number,
  pageSize: number,
) {
  if (!Value.Check(pageMetadata, payload)) return undefined;
  const rows = pageRows(payload.data);
  const total = Number(payload.totalcount);
  if (
    !rows ||
    rows.length !== Number(payload.count) ||
    rows.length > pageSize ||
    !Number.isSafeInteger(total) ||
    start + rows.length > total ||
    (rows.length === 0 && start < total)
  )
    return undefined;

  const candidates: { id: number; active: boolean; emails: string[] }[] = [];
  for (const row of rows) {
    if (!Value.Check(rowSchema, row)) return undefined;
    const id = positiveId(row["2"]);
    if (!id) return undefined;
    const active = row["8"] === true || row["8"] === 1 || row["8"] === "1";
    const emails = Array.isArray(row["5"]) ? row["5"] : [row["5"]];
    candidates.push({ id, active, emails });
  }
  return { total, candidates };
}
