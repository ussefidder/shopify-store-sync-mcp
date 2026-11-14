/** Drop undefined/null keys so absent and null compare equal. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as T;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function sortValidations(v: { name: string; value: string | null }[] | undefined) {
  return (v ?? [])
    .filter((x) => x.value !== null && x.value !== undefined)
    .map((x) => ({ name: x.name, value: String(x.value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Namespaces/types owned by apps or Shopify can't be recreated by another app. */
export function reservedPrefix(s: string): string | undefined {
  if (s.startsWith("app--") || s.startsWith("$app")) return "app-owned";
  if (s.startsWith("shopify--") || s === "shopify") return "Shopify-reserved";
  return undefined;
}

export const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
