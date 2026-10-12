/**
 * Statement access tokens — mitigates IDOR when auth is multi-tenant or open.
 * Tokens are opaque random values returned at creation time.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export type StatementAccessRecord = {
  statementId: string;
  accessToken: string;
  ownerKeyHash: string | null;
  createdAt: number;
};

const registry = new Map<string, StatementAccessRecord>();

export function createStatementAccess(
  statementId: string,
  ownerKeyHash: string | null = null,
): StatementAccessRecord {
  const record: StatementAccessRecord = {
    statementId,
    accessToken: randomBytes(24).toString("base64url"),
    ownerKeyHash,
    createdAt: Date.now(),
  };
  registry.set(statementId, record);
  return record;
}

export function getStatementAccess(statementId: string): StatementAccessRecord | undefined {
  return registry.get(statementId);
}

export function registerStatementAccess(record: StatementAccessRecord): void {
  registry.set(record.statementId, record);
}

export function verifyStatementAccess(params: {
  statementId: string;
  accessToken?: string | null;
  callerKeyHash?: string | null;
}): { ok: true } | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" } {
  const record = registry.get(params.statementId);
  if (!record) {
    // Unknown id — do not leak existence vs forbidden differently for unscoped ids
    return { ok: false, code: "NOT_FOUND" };
  }

  if (record.ownerKeyHash && params.callerKeyHash) {
    const a = Buffer.from(record.ownerKeyHash);
    const b = Buffer.from(params.callerKeyHash);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { ok: true };
    }
    return { ok: false, code: "FORBIDDEN" };
  }

  const token = params.accessToken ?? "";
  if (!token) return { ok: false, code: "FORBIDDEN" };
  const a = Buffer.from(token);
  const b = Buffer.from(record.accessToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "FORBIDDEN" };
  }
  return { ok: true };
}

export function resetStatementAccess(): void {
  registry.clear();
}
