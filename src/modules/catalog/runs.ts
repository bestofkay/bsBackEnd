/**
 * Searchable analysis archive by reference ID / owner name.
 * Primary store: MySQL (Prisma `analyses` + `statements` + `transactions`).
 * Fallback: uploads/catalog/*.json when DATABASE_URL is not configured.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getPrisma, isDatabaseConfigured } from "../database/client.js";

export type CatalogEntry = {
  reference_id: string;
  owner_name: string | null;
  account_name: string | null;
  bank_name: string | null;
  account_number: string | null;
  score: number | null;
  score_band: string | null;
  recommendation: string | null;
  period_from: string | null;
  period_to: string | null;
  analysis_from: string | null;
  analysis_to: string | null;
  created_at: string;
  statement_id: string | null;
  run_id: string | null;
  tx_count: number;
  analysis_tx_count: number | null;
  filename: string | null;
  source: "upload" | "url" | "sample" | "other";
};

type CatalogIndex = {
  version: 1;
  entries: CatalogEntry[];
};

const MAX_ENTRIES = 500;

function catalogDir(): string {
  return path.resolve(config.uploadDir, "catalog");
}

function indexPath(): string {
  return path.join(catalogDir(), "index.json");
}

function payloadPath(referenceId: string): string {
  return path.join(catalogDir(), `${referenceId}.json`);
}

function ensureDir(): void {
  fs.mkdirSync(catalogDir(), { recursive: true });
}

function readIndex(): CatalogIndex {
  try {
    ensureDir();
    if (!fs.existsSync(indexPath())) return { version: 1, entries: [] };
    const raw = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as CatalogIndex;
    if (!raw || !Array.isArray(raw.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: raw.entries };
  } catch (err) {
    logger.warn({ err }, "catalog index read failed");
    return { version: 1, entries: [] };
  }
}

function writeIndex(index: CatalogIndex): void {
  ensureDir();
  const tmp = `${indexPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmp, indexPath());
}

function dateIso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function useDb(): boolean {
  return isDatabaseConfigured() && !!getPrisma();
}

/** Allocate a human-friendly reference like APT-A1B2C3D4 */
export function allocateReferenceId(): string {
  return `APT-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function entryFromDbRow(row: {
  referenceId: string;
  ownerName: string | null;
  accountName: string | null;
  bankName: string | null;
  accountNumber: string | null;
  score: number | null;
  scoreBand: string | null;
  recommendation: string | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  analysisFrom: Date | null;
  analysisTo: Date | null;
  createdAt: Date;
  statementId: string;
  runId: string | null;
  scopedTxCount: number | null;
  fullTxCount: number | null;
  filename: string | null;
  source: string | null;
}): CatalogEntry {
  return {
    reference_id: row.referenceId,
    owner_name: row.ownerName,
    account_name: row.accountName,
    bank_name: row.bankName,
    account_number: row.accountNumber,
    score: row.score,
    score_band: row.scoreBand,
    recommendation: row.recommendation,
    period_from: dateIso(row.periodFrom),
    period_to: dateIso(row.periodTo),
    analysis_from: dateIso(row.analysisFrom),
    analysis_to: dateIso(row.analysisTo),
    created_at: row.createdAt.toISOString(),
    statement_id: row.statementId,
    run_id: row.runId,
    tx_count: row.fullTxCount ?? row.scopedTxCount ?? 0,
    analysis_tx_count: row.scopedTxCount,
    filename: row.filename,
    source: (row.source as CatalogEntry["source"]) || "other",
  };
}

/** Mirror to disk when DB is off; when DB is on, Analysis row is already written by persistence. */
export function saveCatalogRun(params: {
  entry: CatalogEntry;
  publicResult: Record<string, unknown>;
}): CatalogEntry {
  if (useDb()) {
    // Ensure public payload stays in sync if persistence already wrote a row.
    void syncDbPublicPayload(params.entry.reference_id, params.publicResult).catch((err) => {
      logger.warn({ err }, "db catalog payload sync failed");
    });
    return params.entry;
  }

  ensureDir();
  const payload = {
    ...params.publicResult,
    reference_id: params.entry.reference_id,
  };
  const tmp = `${payloadPath(params.entry.reference_id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
  fs.renameSync(tmp, payloadPath(params.entry.reference_id));

  const index = readIndex();
  index.entries = [
    params.entry,
    ...index.entries.filter((e) => e.reference_id !== params.entry.reference_id),
  ].slice(0, MAX_ENTRIES);
  writeIndex(index);
  return params.entry;
}

async function syncDbPublicPayload(
  referenceId: string,
  publicResult: Record<string, unknown>,
): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) return;
  await prisma.analysis.updateMany({
    where: { referenceId },
    data: { publicResultJson: publicResult as Prisma.InputJsonValue },
  });
}

/** Persist a catalog entry + payload into MySQL (used for sample import / backfill). */
export async function upsertAnalysisInDb(params: {
  entry: CatalogEntry;
  publicResult: Record<string, unknown>;
  analysisJson?: Record<string, unknown>;
}): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) {
    saveCatalogRun(params);
    return;
  }

  const analysisJson =
    params.analysisJson ??
    ((params.publicResult.analysis as Record<string, unknown>) || {});

  const statementId = params.entry.statement_id || `stmt_${params.entry.reference_id}`;

  await prisma.$transaction(
    async (tx) => {
    await tx.statement.upsert({
      where: { id: statementId },
      create: {
        id: statementId,
        referenceId: params.entry.reference_id,
        sourceType: params.entry.source || "other",
        sourceFilename: params.entry.filename,
        bankName: params.entry.bank_name,
        accountName: params.entry.account_name,
        ownerName: params.entry.owner_name,
        maskedAccountNumber: params.entry.account_number,
        accountNumber: params.entry.account_number,
        processingStatus: "COMPLETED",
        periodFrom: params.entry.period_from
          ? new Date(`${params.entry.period_from}T00:00:00.000Z`)
          : null,
        periodTo: params.entry.period_to
          ? new Date(`${params.entry.period_to}T00:00:00.000Z`)
          : null,
        analysisFrom: params.entry.analysis_from
          ? new Date(`${params.entry.analysis_from}T00:00:00.000Z`)
          : null,
        analysisTo: params.entry.analysis_to
          ? new Date(`${params.entry.analysis_to}T00:00:00.000Z`)
          : null,
      },
      update: {
        referenceId: params.entry.reference_id,
        ownerName: params.entry.owner_name,
        accountName: params.entry.account_name,
        bankName: params.entry.bank_name,
      },
    });

    await tx.analysis.upsert({
      where: { referenceId: params.entry.reference_id },
      create: {
        statementId,
        referenceId: params.entry.reference_id,
        ownerName: params.entry.owner_name,
        accountName: params.entry.account_name,
        bankName: params.entry.bank_name,
        accountNumber: params.entry.account_number,
        score: params.entry.score,
        scoreBand: params.entry.score_band,
        recommendation: params.entry.recommendation,
        periodFrom: params.entry.period_from
          ? new Date(`${params.entry.period_from}T00:00:00.000Z`)
          : null,
        periodTo: params.entry.period_to
          ? new Date(`${params.entry.period_to}T00:00:00.000Z`)
          : null,
        analysisFrom: params.entry.analysis_from
          ? new Date(`${params.entry.analysis_from}T00:00:00.000Z`)
          : null,
        analysisTo: params.entry.analysis_to
          ? new Date(`${params.entry.analysis_to}T00:00:00.000Z`)
          : null,
        scopedTxCount: params.entry.analysis_tx_count,
        fullTxCount: params.entry.tx_count,
        source: params.entry.source,
        filename: params.entry.filename,
        runId: params.entry.run_id,
        analysisJson: analysisJson as Prisma.InputJsonValue,
        publicResultJson: params.publicResult as Prisma.InputJsonValue,
      },
      update: {
        ownerName: params.entry.owner_name,
        accountName: params.entry.account_name,
        bankName: params.entry.bank_name,
        score: params.entry.score,
        scoreBand: params.entry.score_band,
        recommendation: params.entry.recommendation,
        analysisJson: analysisJson as Prisma.InputJsonValue,
        publicResultJson: params.publicResult as Prisma.InputJsonValue,
        fullTxCount: params.entry.tx_count,
        scopedTxCount: params.entry.analysis_tx_count,
      },
    });

    // Persist ledger rows so transactions table is queryable (sample / backfill).
    const txs = Array.isArray(params.publicResult.transactions)
      ? (params.publicResult.transactions as Array<Record<string, unknown>>)
      : [];
    if (txs.length > 0) {
      await tx.transaction.deleteMany({ where: { statementId } });
      const chunkSize = 500;
      for (let i = 0; i < txs.length; i += chunkSize) {
        const slice = txs.slice(i, i + chunkSize);
        await tx.transaction.createMany({
          data: slice.map((t) => ({
            statementId,
            transactionDate: parseLooseDate(t.transaction_date ?? t.value_date),
            valueDate: parseLooseDate(t.value_date),
            postingDate: parseLooseDate(t.posting_date),
            description: typeof t.description === "string" ? t.description : null,
            reference: typeof t.reference === "string" ? t.reference : null,
            debit: decimalLoose(t.debit),
            credit: decimalLoose(t.credit),
            amount: decimalLoose(t.amount),
            balance: decimalLoose(t.balance),
            currency: typeof t.currency === "string" ? t.currency : null,
            transactionType:
              typeof t.transaction_type === "string" ? t.transaction_type : null,
            confidence: decimalLoose(t.confidence),
          })),
        });
      }
    }
  },
    { timeout: 120_000, maxWait: 20_000 },
  );
}

function parseLooseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function decimalLoose(value: unknown): Prisma.Decimal | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Prisma.Decimal(n.toFixed(4));
}

export function getCatalogEntry(referenceId: string): CatalogEntry | null {
  // sync wrapper — prefer async API in routes; kept for compatibility
  const id = referenceId.trim().toUpperCase();
  if (!useDb()) {
    return readIndex().entries.find((e) => e.reference_id.toUpperCase() === id) ?? null;
  }
  return null;
}

export async function getCatalogEntryAsync(
  referenceId: string,
): Promise<CatalogEntry | null> {
  const id = referenceId.trim().toUpperCase();
  if (useDb()) {
    const prisma = getPrisma()!;
    const row = await prisma.analysis.findFirst({
      where: {
        OR: [
          { referenceId: id },
          { referenceId: { equals: referenceId.trim() } },
        ],
      },
    });
    return row ? entryFromDbRow(row) : null;
  }
  return readIndex().entries.find((e) => e.reference_id.toUpperCase() === id) ?? null;
}

export function getCatalogPayload(referenceId: string): Record<string, unknown> | null {
  const id = referenceId.trim().toUpperCase();
  const candidates = [
    payloadPath(id),
    payloadPath(id.startsWith("APT-") ? id : `APT-${id}`),
    path.join(catalogDir(), `${referenceId.trim()}.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function getCatalogPayloadAsync(
  referenceId: string,
): Promise<Record<string, unknown> | null> {
  const id = referenceId.trim().toUpperCase();
  if (useDb()) {
    const prisma = getPrisma()!;
    const row = await prisma.analysis.findFirst({
      where: {
        OR: [{ referenceId: id }, { referenceId: referenceId.trim() }],
      },
      select: { publicResultJson: true },
    });
    if (row?.publicResultJson && typeof row.publicResultJson === "object") {
      return row.publicResultJson as Record<string, unknown>;
    }
  }
  return getCatalogPayload(referenceId);
}

export async function searchCatalog(params: {
  q?: string | null;
  owner?: string | null;
  referenceId?: string | null;
  limit?: number;
}): Promise<{ total: number; results: CatalogEntry[] }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  if (useDb()) {
    const prisma = getPrisma()!;
    const and: Prisma.AnalysisWhereInput[] = [];

    const ref = params.referenceId?.trim();
    if (ref) {
      and.push({
        OR: [
          { referenceId: { equals: ref.toUpperCase() } },
          { referenceId: { contains: ref } },
        ],
      });
    }

    const owner = params.owner?.trim();
    if (owner) {
      and.push({
        OR: [
          { ownerName: { contains: owner } },
          { accountName: { contains: owner } },
        ],
      });
    }

    const q = params.q?.trim();
    if (q) {
      and.push({
        OR: [
          { referenceId: { contains: q } },
          { ownerName: { contains: q } },
          { accountName: { contains: q } },
          { bankName: { contains: q } },
          { filename: { contains: q } },
          { runId: { contains: q } },
          { statementId: { contains: q } },
        ],
      });
    }

    const where: Prisma.AnalysisWhereInput = and.length ? { AND: and } : {};
    const [total, rows] = await Promise.all([
      prisma.analysis.count({ where }),
      prisma.analysis.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
    ]);
    return { total, results: rows.map(entryFromDbRow) };
  }

  // File fallback
  let entries = readIndex().entries;
  const ref = params.referenceId?.trim();
  if (ref) {
    const needle = ref.toUpperCase();
    entries = entries.filter(
      (e) =>
        e.reference_id.toUpperCase() === needle ||
        e.reference_id.toUpperCase().includes(needle),
    );
  }
  const owner = params.owner?.trim().toLowerCase();
  if (owner) {
    entries = entries.filter((e) => {
      const hay = `${e.owner_name || ""} ${e.account_name || ""}`.toLowerCase();
      return hay.includes(owner);
    });
  }
  const q = params.q?.trim().toLowerCase();
  if (q) {
    entries = entries.filter((e) => {
      const hay = [
        e.reference_id,
        e.owner_name,
        e.account_name,
        e.bank_name,
        e.filename,
        e.statement_id,
        e.run_id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  return { total: entries.length, results: entries.slice(0, limit) };
}

export function buildCatalogEntryFromPublic(params: {
  referenceId: string;
  publicResult: Record<string, unknown>;
  ownerName?: string | null;
  analysisFrom?: string | null;
  analysisTo?: string | null;
  filename?: string | null;
  source?: CatalogEntry["source"];
}): CatalogEntry {
  const body = params.publicResult;
  const statement = (body.statement ?? {}) as Record<string, unknown>;
  const analysis = (body.analysis ?? {}) as Record<string, unknown>;
  const decision = (analysis.decision_support ?? {}) as Record<string, unknown>;
  const period = (analysis.period ?? {}) as Record<string, unknown>;
  const stmtPeriod = (statement.statement_period ?? {}) as Record<string, unknown>;
  const summary = (body.summary ?? {}) as Record<string, unknown>;

  const accountName =
    (typeof statement.account_name === "string" && statement.account_name) ||
    params.ownerName ||
    null;

  return {
    reference_id: params.referenceId,
    owner_name: params.ownerName?.trim() || accountName,
    account_name: typeof statement.account_name === "string" ? statement.account_name : null,
    bank_name: typeof statement.bank_name === "string" ? statement.bank_name : null,
    account_number:
      typeof statement.account_number === "string" ? statement.account_number : null,
    score: typeof analysis.score === "number" ? analysis.score : null,
    score_band: typeof analysis.score_band === "string" ? analysis.score_band : null,
    recommendation:
      typeof decision.recommendation === "string" ? decision.recommendation : null,
    period_from:
      (typeof period.from === "string" && period.from) ||
      (typeof stmtPeriod.from === "string" ? stmtPeriod.from : null),
    period_to:
      (typeof period.to === "string" && period.to) ||
      (typeof stmtPeriod.to === "string" ? stmtPeriod.to : null),
    analysis_from: params.analysisFrom ?? null,
    analysis_to: params.analysisTo ?? null,
    created_at: new Date().toISOString(),
    statement_id: typeof body.statement_id === "string" ? body.statement_id : null,
    run_id: typeof body.run_id === "string" ? body.run_id : null,
    tx_count: typeof summary.transaction_count === "number" ? summary.transaction_count : 0,
    analysis_tx_count:
      typeof (analysis as { scoped_transaction_count?: number }).scoped_transaction_count ===
      "number"
        ? (analysis as { scoped_transaction_count: number }).scoped_transaction_count
        : null,
    filename: params.filename ?? null,
    source: params.source ?? "other",
  };
}
