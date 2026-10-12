/**
 * Atomic persistence for extraction results (Group 6).
 * Uses Prisma when DATABASE_URL is set; otherwise an in-memory store
 * so idempotency and integrity can be tested without MySQL.
 */

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  ExtractionResult,
  ReconciliationResult,
  Transaction,
} from "../../contracts/index.js";
import { getPrisma, isDatabaseConfigured } from "./client.js";
import { toDecimalString } from "../money/index.js";
import { maskAccountNumber } from "../api/sanitize.js";
import { logger } from "../../config/logger.js";
import { transactionFingerprint } from "../duplicates/index.js";

export const EXTRACTION_ENGINE_VERSION = "6.0.0";
export const PARSER_VERSION = "6.0.0";

export type ProcessingStatus =
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "REQUIRES_REVIEW";

export type PersistedExtraction = {
  statementId: string;
  runId: string;
  documentHash: string | null;
  processingStatus: ProcessingStatus;
  publicResult: Record<string, unknown> | null;
  createdAt: string;
};

export type PersistInput = {
  /** When set, update this queued statement instead of creating a new one. */
  statementId?: string | null;
  documentHash: string | null;
  sourceType: string;
  sourceUrl?: string | null;
  sourceFilename?: string | null;
  mimeType?: string | null;
  runId: string;
  extractionMethod?: string | null;
  ocrUsed?: boolean;
  pageCount?: number | null;
  processingTimeMs?: number | null;
  result: ExtractionResult;
  publicResult: Record<string, unknown>;
  /** Archive reference e.g. APT-A1B2C3D4 */
  referenceId?: string | null;
  ownerName?: string | null;
  analysisFrom?: string | null;
  analysisTo?: string | null;
  sourceLabel?: string | null;
};

type MemoryStatement = PersistedExtraction & {
  transactions: Transaction[];
  validation: unknown;
};

const memory = new Map<string, MemoryStatement>();
const memoryByHash = new Map<string, string>();

/** Test helper: clear in-memory persistence. */
export function resetMemoryPersistence(): void {
  memory.clear();
  memoryByHash.clear();
}

/** Force memory mode for unit tests even if DATABASE_URL is set. */
let forceMemory = false;
export function setForceMemoryPersistence(value: boolean): void {
  forceMemory = value;
}

function useMemory(): boolean {
  return forceMemory || !isDatabaseConfigured() || !getPrisma();
}

function decimalOrNull(value: number | null | undefined): Prisma.Decimal | null {
  const s = toDecimalString(value ?? null);
  if (s == null) return null;
  return new Prisma.Decimal(s);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function duplicateStatus(tx: Transaction): string | null {
  if (tx.duplicate_suspected) return tx.duplicate_group_id ?? "SUSPECTED";
  return "NONE";
}

export async function findByDocumentHash(
  documentHash: string | null | undefined,
): Promise<PersistedExtraction | null> {
  if (!documentHash) return null;

  if (useMemory()) {
    const id = memoryByHash.get(documentHash);
    if (!id) return null;
    const row = memory.get(id);
    return row
      ? {
          statementId: row.statementId,
          runId: row.runId,
          documentHash: row.documentHash,
          processingStatus: row.processingStatus,
          publicResult: row.publicResult,
          createdAt: row.createdAt,
        }
      : null;
  }

  const prisma = getPrisma()!;
  const statement = await prisma.statement.findFirst({
    where: {
      OR: [{ documentHash }, { contentHash: documentHash }],
      processingStatus: { in: ["COMPLETED", "REQUIRES_REVIEW"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      extractionRuns: {
        where: { success: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      analyses: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!statement) return null;
  const run = statement.extractionRuns[0];
  const analysis = statement.analyses[0];
  // Prefer analyses.publicResultJson — includes reference_id / owner_name for search/render.
  const publicResult =
    (analysis?.publicResultJson as Record<string, unknown> | null) ??
    (run?.resultJson as Record<string, unknown> | null) ??
    null;
  return {
    statementId: statement.id,
    runId: run?.runId ?? run?.id ?? statement.id,
    documentHash: statement.documentHash ?? statement.contentHash,
    processingStatus: statement.processingStatus as ProcessingStatus,
    publicResult,
    createdAt: statement.createdAt.toISOString(),
  };
}

export async function findPersistedByStatementId(
  statementId: string,
): Promise<PersistedExtraction | null> {
  if (useMemory()) {
    const row = memory.get(statementId);
    return row
      ? {
          statementId: row.statementId,
          runId: row.runId,
          documentHash: row.documentHash,
          processingStatus: row.processingStatus,
          publicResult: row.publicResult,
          createdAt: row.createdAt,
        }
      : null;
  }

  const prisma = getPrisma()!;
  const statement = await prisma.statement.findUnique({
    where: { id: statementId },
    include: {
      extractionRuns: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!statement) return null;
  const run = statement.extractionRuns[0];
  return {
    statementId: statement.id,
    runId: run?.runId ?? run?.id ?? statement.id,
    documentHash: statement.documentHash ?? statement.contentHash,
    processingStatus: statement.processingStatus as ProcessingStatus,
    publicResult: (run?.resultJson as Record<string, unknown> | null) ?? null,
    createdAt: statement.createdAt.toISOString(),
  };
}

/**
 * Persist statement + transactions + extraction run + validation atomically.
 * Rolls back entirely on failure.
 */
export async function persistExtractionAtomically(
  input: PersistInput,
): Promise<PersistedExtraction> {
  const reviewNeeded =
    (input.result.quality.transactions_requiring_review ?? 0) > 0 ||
    input.result.quality.confidence != null &&
      input.result.quality.confidence < 0.75;

  const processingStatus: ProcessingStatus = reviewNeeded
    ? "REQUIRES_REVIEW"
    : "COMPLETED";

  if (useMemory()) {
    return persistMemory(input, processingStatus);
  }
  return persistPrisma(input, processingStatus);
}

function persistMemory(
  input: PersistInput,
  processingStatus: ProcessingStatus,
): PersistedExtraction {
  // Fail injection for tests — must not mutate store
  if ((input.publicResult as { __fail_persist?: boolean }).__fail_persist) {
    throw new Error("Simulated database failure");
  }

  const statementId = input.statementId ?? randomUUID();
  const existing = memory.get(statementId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const row: MemoryStatement = {
    statementId,
    runId: input.runId,
    documentHash: input.documentHash,
    processingStatus,
    publicResult: input.publicResult,
    createdAt,
    transactions: [...input.result.transactions],
    validation: input.result.validation,
  };

  memory.set(statementId, row);
  if (input.documentHash) {
    memoryByHash.set(input.documentHash, statementId);
  }
  return {
    statementId,
    runId: input.runId,
    documentHash: input.documentHash,
    processingStatus,
    publicResult: input.publicResult,
    createdAt,
  };
}

async function persistPrisma(
  input: PersistInput,
  processingStatus: ProcessingStatus,
): Promise<PersistedExtraction> {
  const prisma = getPrisma()!;
  const account = input.result.statement.account ?? {};
  const masked = maskAccountNumber(account.account_number ?? null);
  const recon: ReconciliationResult | undefined = input.result.reconciliation;

  try {
    const analysisObj = (input.result.analysis ?? {}) as Record<string, unknown>;
    const decision = (analysisObj.decision_support ?? {}) as Record<string, unknown>;
    const analysisPeriod = (analysisObj.period ?? {}) as Record<string, unknown>;
    const ownerName =
      input.ownerName?.trim() ||
      (typeof account.account_name === "string" ? account.account_name : null) ||
      null;

    const statementData = {
      referenceId: input.referenceId ?? null,
      documentHash: input.documentHash,
      contentHash: input.documentHash,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      sourceFilename: input.sourceFilename ?? null,
      mimeType: input.mimeType ?? null,
      bankName: input.result.statement.bank_name ?? account.bank_name ?? null,
      accountName: account.account_name ?? null,
      ownerName,
      maskedAccountNumber: masked,
      accountNumber: masked,
      accountType: account.account_type ?? null,
      currency: input.result.statement.currency ?? account.currency ?? null,
      periodFrom: parseDate(input.result.statement.statement_period_start),
      periodTo: parseDate(input.result.statement.statement_period_end),
      analysisFrom: parseDate(input.analysisFrom),
      analysisTo: parseDate(input.analysisTo),
      statementPeriodStart: parseDate(input.result.statement.statement_period_start),
      statementPeriodEnd: parseDate(input.result.statement.statement_period_end),
      openingBalance: decimalOrNull(input.result.statement.opening_balance),
      closingBalance: decimalOrNull(input.result.statement.closing_balance),
      processingStatus,
      extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
      parserVersion: PARSER_VERSION,
    };

    // Prepare row payloads outside the interactive transaction to keep DB work short.
    const mappedTxRows = input.result.transactions.map((t) => ({
      transactionDate: parseDate(t.transaction_date),
      valueDate: parseDate(t.value_date),
      postingDate: parseDate(t.posting_date),
      description: t.description,
      reference: t.reference,
      debit: decimalOrNull(t.debit),
      credit: decimalOrNull(t.credit),
      amount: decimalOrNull(t.amount),
      balance: decimalOrNull(t.balance),
      currency: t.currency,
      transactionType: t.transaction_type,
      confidence: decimalOrNull(t.confidence),
      duplicateStatus: duplicateStatus(t),
      fingerprint: transactionFingerprint(t),
      rawJson: undefined as undefined,
    }));
    const TX_CHUNK = 500;
    // Large statements (2k+ rows + fat JSON) routinely exceed Prisma's 5s default.
    const TX_TIMEOUT_MS = 120_000;

    const persisted = await prisma.$transaction(
      async (tx) => {
        const statement = input.statementId
          ? await tx.statement.update({
              where: { id: input.statementId },
              data: statementData,
            })
          : await tx.statement.create({ data: statementData });

        // Replace transactions for updates (queued → completed)
        if (input.statementId) {
          await tx.transaction.deleteMany({ where: { statementId: statement.id } });
          await tx.analysis.deleteMany({ where: { statementId: statement.id } });
        }

        for (let i = 0; i < mappedTxRows.length; i += TX_CHUNK) {
          const slice = mappedTxRows.slice(i, i + TX_CHUNK).map((row) => ({
            ...row,
            statementId: statement.id,
          }));
          await tx.transaction.createMany({ data: slice });
        }

        const publicWithRef = {
          ...input.publicResult,
          reference_id: input.referenceId ?? null,
          owner_name: ownerName,
          statement_id: statement.id,
          analysis_period: {
            from: input.analysisFrom ?? null,
            to: input.analysisTo ?? null,
          },
        };

        const run = await tx.extractionRun.create({
          data: {
            statementId: statement.id,
            runId: input.runId,
            status: processingStatus,
            sourceType: input.sourceType,
            inputHash: input.documentHash,
            extractionMethod: input.extractionMethod ?? null,
            parser: PARSER_VERSION,
            ocrUsed: input.ocrUsed ?? false,
            processingTimeMs: input.processingTimeMs ?? null,
            pageCount: input.pageCount ?? null,
            success: true,
            confidence: decimalOrNull(input.result.quality.confidence),
            transactionCount: input.result.transactions.length,
            engineVersion: EXTRACTION_ENGINE_VERSION,
            finishedAt: new Date(),
            resultJson: publicWithRef as Prisma.InputJsonValue,
          },
        });

        await tx.validationResult.create({
          data: {
            statementId: statement.id,
            extractionRunId: run.id,
            reconciled: recon?.reconciled ?? recon?.is_reconciled ?? false,
            calculatedClosingBalance: decimalOrNull(
              recon?.calculated_closing_balance ?? recon?.computed_closing_balance,
            ),
            statementClosingBalance: decimalOrNull(
              recon?.statement_closing_balance ?? recon?.closing_balance,
            ),
            difference: decimalOrNull(recon?.difference),
            validationStatus: recon?.reconciliation_status ?? "NOT_DETERMINABLE",
            isValid: input.result.validation.is_valid,
            warningsJson: (input.result.quality.warnings ??
              []) as Prisma.InputJsonValue,
            issuesJson: (input.result.validation.issues ??
              []) as Prisma.InputJsonValue,
          },
        });

        if (input.referenceId) {
          await tx.analysis.create({
            data: {
              statementId: statement.id,
              referenceId: input.referenceId,
              ownerName,
              accountName: account.account_name ?? null,
              bankName: input.result.statement.bank_name ?? account.bank_name ?? null,
              accountNumber: masked,
              score: typeof analysisObj.score === "number" ? analysisObj.score : null,
              scoreBand:
                typeof analysisObj.score_band === "string" ? analysisObj.score_band : null,
              recommendation:
                typeof decision.recommendation === "string"
                  ? decision.recommendation
                  : null,
              periodFrom: parseDate(
                (typeof analysisPeriod.from === "string" && analysisPeriod.from) ||
                  input.result.statement.statement_period_start,
              ),
              periodTo: parseDate(
                (typeof analysisPeriod.to === "string" && analysisPeriod.to) ||
                  input.result.statement.statement_period_end,
              ),
              analysisFrom: parseDate(input.analysisFrom),
              analysisTo: parseDate(input.analysisTo),
              scopedTxCount:
                typeof analysisObj.scoped_transaction_count === "number"
                  ? analysisObj.scoped_transaction_count
                  : input.result.transactions.length,
              fullTxCount:
                typeof analysisObj.full_transaction_count === "number"
                  ? analysisObj.full_transaction_count
                  : input.result.transactions.length,
              source: input.sourceType === "url" ? "url" : "upload",
              filename: input.sourceFilename ?? null,
              runId: input.runId,
              analysisJson: analysisObj as Prisma.InputJsonValue,
              publicResultJson: publicWithRef as Prisma.InputJsonValue,
            },
          });
        }

        return {
          statementId: statement.id,
          runId: input.runId,
          documentHash: input.documentHash,
          processingStatus,
          publicResult: publicWithRef,
          createdAt: statement.createdAt.toISOString(),
        } satisfies PersistedExtraction;
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 20_000 },
    );

    return persisted;
  } catch (err) {
    logger.error({ err, runId: input.runId }, "atomic persistence failed");
    throw err;
  }
}

export async function createQueuedStatement(params: {
  documentHash?: string | null;
  sourceType: string;
  sourceFilename?: string | null;
  sourceUrl?: string | null;
  mimeType?: string | null;
}): Promise<{ statementId: string; status: ProcessingStatus }> {
  const statementId = randomUUID();
  if (useMemory()) {
    memory.set(statementId, {
      statementId,
      runId: statementId,
      documentHash: params.documentHash ?? null,
      processingStatus: "QUEUED",
      publicResult: null,
      createdAt: new Date().toISOString(),
      transactions: [],
      validation: null,
    });
    return { statementId, status: "QUEUED" };
  }

  const prisma = getPrisma()!;
  const row = await prisma.statement.create({
    data: {
      id: statementId,
      documentHash: params.documentHash ?? null,
      contentHash: params.documentHash ?? null,
      sourceType: params.sourceType,
      sourceFilename: params.sourceFilename ?? null,
      sourceUrl: params.sourceUrl ?? null,
      mimeType: params.mimeType ?? null,
      processingStatus: "QUEUED",
      extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
      parserVersion: PARSER_VERSION,
    },
  });
  return { statementId: row.id, status: "QUEUED" };
}

export async function updateStatementStatus(
  statementId: string,
  status: ProcessingStatus,
  publicResult?: Record<string, unknown> | null,
): Promise<void> {
  if (useMemory()) {
    const row = memory.get(statementId);
    if (!row) return;
    row.processingStatus = status;
    if (publicResult !== undefined) row.publicResult = publicResult;
    return;
  }
  const prisma = getPrisma()!;
  await prisma.statement.update({
    where: { id: statementId },
    data: { processingStatus: status },
  });
}
