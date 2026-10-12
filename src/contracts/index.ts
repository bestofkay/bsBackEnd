/**
 * Shared domain contracts for the Bank Statement Extraction Service.
 * These Zod schemas are the single source of truth for TypeScript types
 * and runtime validation. Missing financial values must remain null —
 * never fabricate amounts, dates, or balances.
 */

import { z } from "zod";

/** Supported ingestion formats (Group 1 contracts only). */
export const SupportedMimeTypeSchema = z.enum([
  "application/pdf",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
]);

export const SupportedExtensionSchema = z.enum([
  "pdf",
  "csv",
  "xls",
  "xlsx",
  "jpg",
  "jpeg",
  "png",
]);

export const SourceTypeSchema = z.enum(["upload", "url"]);

export const TransactionTypeSchema = z.enum([
  "TRANSFER",
  "CASH_WITHDRAWAL",
  "CASH_DEPOSIT",
  "POS",
  "ATM",
  "CARD_PAYMENT",
  "BANK_CHARGE",
  "INTEREST",
  "SALARY",
  "DIRECT_DEBIT",
  "DIRECT_CREDIT",
  "REFUND",
  "REVERSAL",
  "CHEQUE",
  "MOBILE_PAYMENT",
  "ONLINE_PAYMENT",
  "OTHER",
  "UNKNOWN",
]);

/**
 * Nullable money string/number helpers.
 * Prefer number | null for amounts; never invent zeros for missing values.
 */
export const NullableNumberSchema = z.number().finite().nullable();
export const NullableStringSchema = z.string().nullable();

export const DocumentInputSchema = z
  .object({
    /** Internal document id, e.g. stmt_01HXYZ... */
    document_id: z.string().min(1),
    source_type: SourceTypeSchema,
    /** Present when source_type === "url" (sanitized for logs elsewhere) */
    source_url: z.string().url().nullable().optional(),
    /** @deprecated Prefer source_url; retained for Group 1 compatibility */
    url: z.string().url().nullable().optional(),
    /** Original client/remote filename when available */
    original_filename: z.string().nullable().optional(),
    /** @deprecated Prefer original_filename */
    filename: z.string().nullable().optional(),
    mime_type: SupportedMimeTypeSchema.nullable().optional(),
    extension: SupportedExtensionSchema.nullable().optional(),
    /** Validated local path after secure ingestion */
    local_path: z.string().nullable().optional(),
    /** Content hash (sha256) for integrity / duplicate checks */
    content_hash: z.string().nullable().optional(),
    /** File size in bytes after validation */
    file_size: z.number().int().nonnegative().nullable().optional(),
    /** @deprecated Prefer file_size */
    size_bytes: z.number().int().nonnegative().nullable().optional(),
    /** Optional PDF / archive password */
    password: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional().default({}),
  })
  .superRefine((value, ctx) => {
    const remote = value.source_url ?? value.url;
    if (value.source_type === "url" && !remote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_url is required when source_type is 'url'",
        path: ["source_url"],
      });
    }
  });

export const AccountSchema = z.object({
  account_name: NullableStringSchema.optional().default(null),
  account_number: NullableStringSchema.optional().default(null),
  bank_name: NullableStringSchema.optional().default(null),
  bank_code: NullableStringSchema.optional().default(null),
  currency: NullableStringSchema.optional().default(null),
  account_type: NullableStringSchema.optional().default(null),
  branch: NullableStringSchema.optional().default(null),
  iban: NullableStringSchema.optional().default(null),
  sort_code: NullableStringSchema.optional().default(null),
});

/**
 * Canonical transaction. Optional financial fields are nullable.
 * Never fabricate missing debit/credit/amount/balance/dates.
 */
export const TransactionSchema = z
  .object({
    transaction_date: NullableStringSchema,
    value_date: NullableStringSchema,
    posting_date: NullableStringSchema,
    description: NullableStringSchema,
    reference: NullableStringSchema,
    debit: NullableNumberSchema,
    credit: NullableNumberSchema,
    amount: NullableNumberSchema,
    balance: NullableNumberSchema,
    currency: NullableStringSchema,
    transaction_type: TransactionTypeSchema.nullable(),
    /** Stable id assigned during reconstruction (not a bank reference) */
    id: z.string().nullable().optional().default(null),
    /** Group 5 quality flags — never alter financial values */
    duplicate_suspected: z.boolean().optional().default(false),
    duplicate_group_id: z.string().nullable().optional().default(null),
    confidence: z.number().min(0).max(1).nullable().optional().default(null),
    confidence_factors: z.record(z.number()).optional().default({}),
    raw: z.record(z.unknown()).optional().default({}),
  })
  .strict();

export const StatementSchema = z.object({
  id: z.string().nullable().optional().default(null),
  source: z
    .object({
      document_id: z.string().optional(),
      source_type: SourceTypeSchema.optional(),
      source_url: z.string().nullable().optional(),
      original_filename: z.string().nullable().optional(),
      mime_type: SupportedMimeTypeSchema.nullable().optional(),
      extension: SupportedExtensionSchema.nullable().optional(),
      file_size: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
  account: AccountSchema.optional().default({}),
  statement_period_start: NullableStringSchema.optional().default(null),
  statement_period_end: NullableStringSchema.optional().default(null),
  opening_balance: NullableNumberSchema.optional().default(null),
  closing_balance: NullableNumberSchema.optional().default(null),
  currency: NullableStringSchema.optional().default(null),
  bank_name: NullableStringSchema.optional().default(null),
  statement_number: NullableStringSchema.optional().default(null),
  page_count: z.number().int().nonnegative().nullable().optional().default(null),
  extracted_at: z.string().datetime().nullable().optional().default(null),
});

export const ExtractionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().nullable().optional().default(null),
  details: z.record(z.unknown()).optional().default({}),
});

export const ExtractionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().nullable().optional().default(null),
  details: z.record(z.unknown()).optional().default({}),
  retryable: z.boolean().optional().default(false),
});

export const ValidationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  transaction_index: z.number().int().nullable().optional().default(null),
  field: z.string().nullable().optional().default(null),
});

export const ValidationResultSchema = z.object({
  is_valid: z.boolean(),
  issues: z.array(ValidationIssueSchema).default([]),
  checked_at: z.string().datetime().nullable().optional().default(null),
});

export const ReconciliationResultSchema = z.object({
  is_reconciled: z.boolean(),
  reconciled: z.boolean().optional(),
  reconciliation_status: z
    .enum(["RECONCILED", "MISMATCH", "NOT_DETERMINABLE"])
    .optional()
    .default("NOT_DETERMINABLE"),
  opening_balance: NullableNumberSchema.optional().default(null),
  closing_balance: NullableNumberSchema.optional().default(null),
  statement_closing_balance: NullableNumberSchema.optional().default(null),
  computed_closing_balance: NullableNumberSchema.optional().default(null),
  calculated_closing_balance: NullableNumberSchema.optional().default(null),
  difference: NullableNumberSchema.optional().default(null),
  method: z.string().nullable().optional().default(null),
  notes: z.array(z.string()).optional().default([]),
});

export const QualityWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  transaction_index: z.number().int().nullable().optional().default(null),
  details: z.record(z.unknown()).optional().default({}),
});

export const QualitySummarySchema = z.object({
  /** Primary quality indicator (0–1). Not a correctness guarantee. */
  confidence: z.number().min(0).max(1).nullable().optional().default(null),
  overall_confidence: z.number().min(0).max(1).nullable(),
  field_confidence: z.record(z.number().min(0).max(1)).optional().default({}),
  transactions_requiring_review: z.number().int().nonnegative().optional().default(0),
  warnings_count: z.number().int().nonnegative().default(0),
  errors_count: z.number().int().nonnegative().default(0),
  duplicate_candidates: z.number().int().nonnegative().default(0),
  warnings: z.array(QualityWarningSchema).optional().default([]),
});

export const ExtractionSummarySchema = z.object({
  transaction_count: z.number().int().nonnegative(),
  debit_total: NullableNumberSchema,
  credit_total: NullableNumberSchema,
  currency: NullableStringSchema,
  period_start: NullableStringSchema,
  period_end: NullableStringSchema,
});

export const ExtractionResultSchema = z.object({
  success: z.literal(true),
  statement: StatementSchema,
  transactions: z.array(TransactionSchema),
  summary: ExtractionSummarySchema,
  validation: ValidationResultSchema,
  quality: QualitySummarySchema,
  reconciliation: ReconciliationResultSchema.optional(),
  /** Post-extraction analytics (Node port of legacy Analyses.php). */
  analysis: z.record(z.unknown()).nullable().optional().default(null),
  warnings: z.array(ExtractionWarningSchema).optional().default([]),
  run_id: z.string().nullable().optional().default(null),
});

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export const ApiResponseSchema = z.union([ExtractionResultSchema, ErrorResponseSchema]);

export type SupportedMimeType = z.infer<typeof SupportedMimeTypeSchema>;
export type SupportedExtension = z.infer<typeof SupportedExtensionSchema>;
export type SourceType = z.infer<typeof SourceTypeSchema>;
export type TransactionType = z.infer<typeof TransactionTypeSchema>;
export type DocumentInput = z.infer<typeof DocumentInputSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type Statement = z.infer<typeof StatementSchema>;
export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;
export type ExtractionError = z.infer<typeof ExtractionErrorSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;
export type QualitySummary = z.infer<typeof QualitySummarySchema>;
export type ExtractionSummary = z.infer<typeof ExtractionSummarySchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type ApiResponse = z.infer<typeof ApiResponseSchema>;
