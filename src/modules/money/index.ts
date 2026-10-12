/**
 * Money helpers — avoid binary float drift for persistence boundaries.
 * API JSON still uses numbers; persistence uses decimal strings.
 */

const MONEY_SCALE = 4;

export function roundMoney(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** MONEY_SCALE;
  return Math.round(value * factor) / factor;
}

/** Exact decimal string for Prisma Decimal / NUMERIC columns. */
export function toDecimalString(value: number | null | undefined): string | null {
  const rounded = roundMoney(value);
  if (rounded == null) return null;
  return rounded.toFixed(MONEY_SCALE);
}

export function moneyOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return roundMoney(value);
}
