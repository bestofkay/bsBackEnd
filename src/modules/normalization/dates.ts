/**
 * Date normalization → YYYY-MM-DD.
 * Ambiguous DMY/MDY dates are handled conservatively.
 */

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export type ParsedDate = {
  iso: string;
  ambiguous: boolean;
  raw: string;
};

function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function expandYear(y: number): number {
  if (y >= 100) return y;
  // 00–79 → 2000–2079; 80–99 → 1980–1999
  return y >= 80 ? 1900 + y : 2000 + y;
}

/**
 * Detect whether text looks like a standalone date token / cell.
 */
export function looksLikeDate(raw: string): boolean {
  return parseDate(raw) != null;
}

/**
 * Parse a date string into YYYY-MM-DD.
 * Returns null when unrecognized or too ambiguous to resolve safely.
 */
export function parseDate(raw: string | null | undefined): ParsedDate | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text) return null;

  // ISO already
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (!isValidYmd(y, m, d)) return null;
    return { iso: toIso(y, m, d), ambiguous: false, raw: text };
  }

  // DD MMM YYYY / DD-MMM-YYYY / DD/MMM/YYYY
  const named = /^(\d{1,2})[/-\s]+([A-Za-z]{3,9})[/-\s]+(\d{2,4})$/.exec(text);
  if (named) {
    const d = Number(named[1]);
    const m = MONTHS[named[2].toLowerCase()];
    const y = expandYear(Number(named[3]));
    if (!m || !isValidYmd(y, m, d)) return null;
    return { iso: toIso(y, m, d), ambiguous: false, raw: text };
  }

  // MMM DD, YYYY
  const namedUs = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(text);
  if (namedUs) {
    const m = MONTHS[namedUs[1].toLowerCase()];
    const d = Number(namedUs[2]);
    const y = expandYear(Number(namedUs[3]));
    if (!m || !isValidYmd(y, m, d)) return null;
    return { iso: toIso(y, m, d), ambiguous: false, raw: text };
  }

  // Numeric with separators: 12/09/2026, 12-09-26, 2026/09/12
  const num = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/.exec(text);
  if (!num) return null;

  const a = Number(num[1]);
  const b = Number(num[2]);
  const c = Number(num[3]);

  // YYYY-M-D style when first is 4-digit year
  if (String(num[1]).length === 4) {
    const y = a;
    const m = b;
    const d = c;
    if (!isValidYmd(y, m, d)) return null;
    return { iso: toIso(y, m, d), ambiguous: false, raw: text };
  }

  const year = expandYear(c);
  // Day/month disambiguation
  if (a > 12 && b >= 1 && b <= 12) {
    // Must be D/M/Y
    if (!isValidYmd(year, b, a)) return null;
    return { iso: toIso(year, b, a), ambiguous: false, raw: text };
  }
  if (b > 12 && a >= 1 && a <= 12) {
    // Must be M/D/Y
    if (!isValidYmd(year, a, b)) return null;
    return { iso: toIso(year, a, b), ambiguous: false, raw: text };
  }

  // Both <= 12 → ambiguous. Prefer day-first (common for bank statements outside US).
  // Mark ambiguous so callers can choose to reject if needed.
  if (a >= 1 && a <= 12 && b >= 1 && b <= 12) {
    if (!isValidYmd(year, b, a)) return null;
    return { iso: toIso(year, b, a), ambiguous: true, raw: text };
  }

  return null;
}

/**
 * Normalize to YYYY-MM-DD or null. Ambiguous dates are still accepted as day-first
 * ISO values (conservative preference for statement locales), never invented.
 */
export function normalizeDate(raw: string | null | undefined): string | null {
  const parsed = parseDate(raw);
  return parsed?.iso ?? null;
}

/**
 * Extract the first date-like token from a free-text line.
 */
export function extractDateFromText(raw: string): ParsedDate | null {
  const tokens = raw
    .split(/[\s,|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const parsed = parseDate(token);
    if (parsed) return parsed;
  }
  // Try sliding windows for "12 Sep 2026"
  const named = raw.match(/\b\d{1,2}[/-\s]+[A-Za-z]{3,9}[/-\s]+\d{2,4}\b/);
  if (named) return parseDate(named[0]);
  const iso = raw.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return parseDate(iso[0]);
  const slash = raw.match(/\b\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}\b/);
  if (slash) return parseDate(slash[0]);
  return null;
}
