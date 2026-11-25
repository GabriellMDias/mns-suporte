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
