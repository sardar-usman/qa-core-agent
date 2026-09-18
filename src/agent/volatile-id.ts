/**
 * The shapes a generated identifier takes: a uuid, a long hex run (mongo id),
 * a long alphanumeric run with digits (ulid, nanoid, catalogue keys). Shared
 * by discovery (a page whose PATH carries one is volatile: it rots when the
 * site reseeds) and by the gate (RULE 6: a SELECTOR that embeds one rots the
 * same way, so the Explorer is steered to a role, label, testid or table path).
 */
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX_SEGMENT_RE = /^[0-9a-f]{16,}$/i;
const LONG_ID_SEGMENT_RE = /^[a-z0-9_-]{20,}$/i;
const LONG_ALNUM_TOKEN_RE = /^[a-z0-9]{20,}$/i;

/** True when any path segment looks like a generated id. */
export function isVolatilePath(pathname: string): boolean {
  return pathname.split('/').some((seg) => {
    if (!seg) return false;
    if (UUID_SEGMENT_RE.test(seg)) return true;
    if (HEX_SEGMENT_RE.test(seg) && /\d/.test(seg)) return true;
    return LONG_ID_SEGMENT_RE.test(seg) && /\d/.test(seg);
  });
}

/**
 * The generated-id fragment embedded in a selector or locator argument, or
 * null. Tokens are split on every non-alphanumeric character, so a testid such
 * as "category-01M2K06AWQJ6XZEYHJEKD7E8JV" yields the ulid and a plain
 * "inventory-item-name" yields nothing. A uuid is matched whole first, since
 * its hyphens would otherwise split it.
 */
export function generatedIdFragment(text: string): string | null {
  const uuid = text.match(UUID_ANYWHERE_RE);
  if (uuid) return uuid[0];
  for (const token of text.split(/[^A-Za-z0-9]+/)) {
    if (!token) continue;
    if (HEX_SEGMENT_RE.test(token) && /\d/.test(token)) return token;
    if (LONG_ALNUM_TOKEN_RE.test(token) && /\d/.test(token)) return token;
  }
  return null;
}
