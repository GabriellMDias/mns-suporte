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
const activeUser = {
  "2": nonnegativeInteger,
  "8": Type.Union([
    Type.Boolean(),
    Type.Literal(1),
    Type.Literal(0),
    Type.Literal("1"),
    Type.Literal("0"),
  ]),
};
const emailRow = Type.Object({
  ...activeUser,
  "5": Type.Union([Type.String(), Type.Array(Type.String())]),
});
const phoneOptionIds = ["6", "10", "11"] as const;
const phoneValue = Type.Union([Type.String(), Type.Null()]);
const phoneRow = Type.Object({
  ...activeUser,
  "6": phoneValue,
  "10": phoneValue,
  "11": phoneValue,
});

const whatsAppBrazilianPhone = /^55[1-9][0-9][2-9][0-9]{7,8}$/;
// Keep the final four digits contiguous so the GLPI candidate search is complete
// for every accepted representation. Extensions and multiple numbers are excluded.
const directoryBrazilianPhone =
  /^(?:(?:\+55|0055|55)[ .-]*)?(?:\([1-9][0-9]\)|[1-9][0-9])[ .-]*[2-9][0-9]{3,4}[ .-]*[0-9]{4}$/;

export function positiveId(value: unknown): number | undefined {
  if (!Value.Check(nonnegativeInteger, value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
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

export function phoneDirectoryQuery(
  phone: string,
  start: number,
  size: number,
) {
  const query = new URLSearchParams({
    "criteria[1][link]": "AND",
    "criteria[1][field]": "8",
    "criteria[1][searchtype]": "equals",
    "criteria[1][value]": "1",
    "forcedisplay[0]": "2",
    "forcedisplay[1]": "8",
    is_deleted: "false",
    sort: "2",
    order: "ASC",
    range: start + "-" + (start + size - 1),
  });
  for (const [index, field] of phoneOptionIds.entries()) {
    const criterion = "criteria[0][criteria][" + index + "]";
    if (index > 0) query.set(criterion + "[link]", "OR");
    query.set(criterion + "[field]", field);
    query.set(criterion + "[searchtype]", "contains");
    query.set(criterion + "[value]", phone.slice(-4));
    query.set("forcedisplay[" + (index + 2) + "]", field);
  }
  return query;
}

export function isSupportedSenderPhone(phone: string): boolean {
  return whatsAppBrazilianPhone.test(phone);
}

function matchesBrazilianPhone(value: string, sender: string): boolean {
  const candidate = value.trim();
  if (!directoryBrazilianPhone.test(candidate)) return false;
  const digits = candidate.replace(/\D/g, "");
  const canonical =
    digits.length <= 11 ? "55" + digits : digits.replace(/^00/, "");
  return canonical === sender;
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
  const page = readSearchPage(payload, start, pageSize);
  if (!page) return undefined;
  const candidates: { id: number; active: boolean; emails: string[] }[] = [];
  for (const row of page.rows) {
    if (!Value.Check(emailRow, row)) return undefined;
    const id = positiveId(row["2"]);
    if (!id) return undefined;
    const active = row["8"] === true || row["8"] === 1 || row["8"] === "1";
    const emails = Array.isArray(row["5"]) ? row["5"] : [row["5"]];
    candidates.push({ id, active, emails });
  }
  return { total: page.total, candidates };
}

export function readPhoneDirectoryPage(
  payload: unknown,
  start: number,
  pageSize: number,
  sender: string,
) {
  const page = readSearchPage(payload, start, pageSize);
  if (!page) return undefined;
  const candidates: { id: number; matches: boolean }[] = [];
  for (const row of page.rows) {
    if (!Value.Check(phoneRow, row)) return undefined;
    const id = positiveId(row["2"]);
    if (!id) return undefined;
    const active = row["8"] === true || row["8"] === 1 || row["8"] === "1";
    const matches =
      active &&
      phoneOptionIds.some((field) => {
        const value = row[field];
        return value !== null && matchesBrazilianPhone(value, sender);
      });
    candidates.push({ id, matches });
  }
  return { total: page.total, candidates };
}

export function readSearchPage(
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

  return { total, rows };
}
