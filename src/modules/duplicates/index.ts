/**
 * Multi-level duplicate detection (Group 5).
 * Flags suspicious similarity — never deletes or mutates financial fields.
 *
 * Level 1: exact reference + date + amount (+ account when available)
 * Level 2: strong hashed fingerprint of key fields
 * Level 3: conservative similarity when reference is missing
 */

import { createHash } from "node:crypto";
import type { Transaction } from "../../contracts/index.js";

export type DuplicateCandidate = {
  left_index: number;
  right_index: number;
  fingerprint: string;
  level: 1 | 2 | 3;
  group_id: string;
  reason: string;
};

export type DuplicateDetectionResult = {
  candidates: DuplicateCandidate[];
  /** Per-transaction flags; original tx objects are not mutated here. */
  flags: Array<{
    index: number;
    duplicate_suspected: boolean;
    duplicate_group_id: string | null;
  }>;
};

function normalizeDescription(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function amountKey(tx: Transaction): string {
  if (tx.amount != null) return String(tx.amount);
  if (tx.debit != null) return `D:${tx.debit}`;
  if (tx.credit != null) return `C:${tx.credit}`;
  return "";
}

function accountKey(_tx: Transaction, accountId?: string | null): string {
  return (accountId ?? "").trim();
}

function dateKey(tx: Transaction): string {
  return tx.transaction_date ?? tx.value_date ?? tx.posting_date ?? "";
}

function hashFingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/** Legacy exact fingerprint retained for compatibility. */
export function transactionFingerprint(tx: Transaction): string {
  const parts = [
    tx.transaction_date ?? "",
    tx.value_date ?? "",
    normalizeDescription(tx.description),
    tx.reference ?? "",
    tx.debit == null ? "" : String(tx.debit),
    tx.credit == null ? "" : String(tx.credit),
    tx.amount == null ? "" : String(tx.amount),
    tx.balance == null ? "" : String(tx.balance),
  ];
  return parts.join("|");
}

function level1Key(tx: Transaction, accountId?: string | null): string | null {
  const ref = (tx.reference ?? "").trim();
  const date = dateKey(tx);
  const amount = amountKey(tx);
  if (!ref || !date || !amount) return null;
  return ["L1", accountKey(tx, accountId), date, amount, ref].join("|");
}

function level2Key(tx: Transaction, accountId?: string | null): string | null {
  const date = dateKey(tx);
  const amount = amountKey(tx);
  if (!date || !amount) return null;
  const fp = hashFingerprint([
    accountKey(tx, accountId),
    date,
    amount,
    (tx.currency ?? "").toUpperCase(),
    (tx.reference ?? "").trim().toUpperCase(),
    normalizeDescription(tx.description),
  ]);
  return `L2:${fp}`;
}

function descriptionsSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Conservative: one contains the other and shared length is meaningful
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 8) return false;
  return longer.includes(shorter);
}

function level3Match(a: Transaction, b: Transaction): boolean {
  // Never match on description alone or amount alone.
  const dateA = dateKey(a);
  const dateB = dateKey(b);
  if (!dateA || dateA !== dateB) return false;

  const amtA = amountKey(a);
  const amtB = amountKey(b);
  if (!amtA || amtA !== amtB) return false;

  const curA = (a.currency ?? "").toUpperCase();
  const curB = (b.currency ?? "").toUpperCase();
  if (curA && curB && curA !== curB) return false;

  const refA = (a.reference ?? "").trim();
  const refB = (b.reference ?? "").trim();
  // If both have references and they differ → not a duplicate (legitimate repeats)
  if (refA && refB && refA !== refB) return false;

  const descA = normalizeDescription(a.description);
  const descB = normalizeDescription(b.description);
  if (!descriptionsSimilar(descA, descB)) return false;

  // Strengthen with balance when both present
  if (a.balance != null && b.balance != null && a.balance !== b.balance) {
    // Same date/amount/desc but different running balances → likely distinct
    // unless page-overlap duplicate where one balance was misread; still require
    // balance equality for level-3 without reference.
    return false;
  }

  // Require either matching non-empty reference OR strong desc + balance agreement
  if (refA && refB && refA === refB) return true;
  if (!refA && !refB && descA.length >= 12 && a.balance != null && a.balance === b.balance) {
    return true;
  }
  // Page-overlap style: identical date+amount+normalized description, no refs
  if (!refA && !refB && descA.length >= 12 && descA === descB) {
    return true;
  }
  return false;
}

function nextGroupId(n: number): string {
  return `dup_${String(n).padStart(5, "0")}`;
}

/**
 * Detect potential duplicates. Does not delete or alter transaction payloads.
 */
export function detectDuplicates(
  transactions: Transaction[],
  options: { accountId?: string | null } = {},
): DuplicateDetectionResult {
  const accountId = options.accountId ?? null;
  const candidates: DuplicateCandidate[] = [];
  const indexToGroup = new Map<number, string>();
  let groupCounter = 1;

  const assignGroup = (i: number, j: number, existing?: string): string => {
    const gid =
      existing ??
      indexToGroup.get(i) ??
      indexToGroup.get(j) ??
      nextGroupId(groupCounter++);
    indexToGroup.set(i, gid);
    indexToGroup.set(j, gid);
    return gid;
  };

  // Level 1 — exact reference match
  const l1 = new Map<string, number>();
  transactions.forEach((tx, index) => {
    const key = level1Key(tx, accountId);
    if (!key) return;
    const prior = l1.get(key);
    if (prior != null) {
      const group_id = assignGroup(prior, index);
      candidates.push({
        left_index: prior,
        right_index: index,
        fingerprint: key,
        level: 1,
        group_id,
        reason: "exact_reference_date_amount",
      });
    } else {
      l1.set(key, index);
    }
  });

  // Level 2 — strong fingerprint (includes reference when present)
  const l2 = new Map<string, number>();
  transactions.forEach((tx, index) => {
    const key = level2Key(tx, accountId);
    if (!key) return;
    // Skip if already grouped via L1 with same partner set — still OK to flag again
    const prior = l2.get(key);
    if (prior != null) {
      // Avoid double-reporting identical pair already found at L1
      const already = candidates.some(
        (c) =>
          (c.left_index === prior && c.right_index === index) ||
          (c.left_index === index && c.right_index === prior),
      );
      if (!already) {
        const group_id = assignGroup(prior, index, indexToGroup.get(prior));
        candidates.push({
          left_index: prior,
          right_index: index,
          fingerprint: key,
          level: 2,
          group_id,
          reason: "strong_fingerprint",
        });
      }
    } else {
      l2.set(key, index);
    }
  });

  // Level 3 — conservative pairwise when reference missing on at least one side
  for (let i = 0; i < transactions.length; i++) {
    for (let j = i + 1; j < transactions.length; j++) {
      const a = transactions[i];
      const b = transactions[j];
      const refA = (a.reference ?? "").trim();
      const refB = (b.reference ?? "").trim();
      // Level 3 is for weak-reference cases; if both refs exist and differ, skip
      if (refA && refB && refA !== refB) continue;
      // If both refs exist and equal, L1 should have caught same date+amount
      if (refA && refB) continue;

      if (!level3Match(a, b)) continue;

      const already = candidates.some(
        (c) =>
          (c.left_index === i && c.right_index === j) ||
          (c.left_index === j && c.right_index === i),
      );
      if (already) continue;

      const group_id = assignGroup(i, j, indexToGroup.get(i) ?? indexToGroup.get(j));
      candidates.push({
        left_index: i,
        right_index: j,
        fingerprint: hashFingerprint([
          dateKey(a),
          amountKey(a),
          normalizeDescription(a.description),
          String(a.balance ?? ""),
        ]),
        level: 3,
        group_id,
        reason: "conservative_similarity",
      });
    }
  }

  const flags = transactions.map((_, index) => ({
    index,
    duplicate_suspected: indexToGroup.has(index),
    duplicate_group_id: indexToGroup.get(index) ?? null,
  }));

  return { candidates, flags };
}

/** Backward-compatible wrapper used by earlier pipeline code. */
export function findDuplicateCandidates(transactions: Transaction[]): DuplicateCandidate[] {
  return detectDuplicates(transactions).candidates;
}

/**
 * Apply duplicate flags onto transaction copies (financial fields unchanged).
 */
export function applyDuplicateFlags(
  transactions: Transaction[],
  result: DuplicateDetectionResult,
): Transaction[] {
  return transactions.map((tx, index) => {
    const flag = result.flags[index];
    return {
      ...tx,
      duplicate_suspected: flag?.duplicate_suspected ?? false,
      duplicate_group_id: flag?.duplicate_group_id ?? null,
    };
  });
}
