/**
 * Intermediate extraction representation (Group 3).
 * Consumed by Group 4 transaction reconstruction — not final ledger output.
 */

import { z } from "zod";

export const CanonicalFieldSchema = z.enum([
  "transaction_date",
  "value_date",
  "posting_date",
  "description",
  "reference",
  "debit",
  "credit",
  "amount",
  "balance",
  "unknown",
]);

export type CanonicalField = z.infer<typeof CanonicalFieldSchema>;

export const BoundingBoxSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});

export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const ExtractionMethodSchema = z.enum([
  "pdf_text",
  "pdf_ocr",
  "pdf_mixed",
  "ocr_image",
  "csv",
  "xlsx",
  "xls",
]);

export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

export const PdfKindSchema = z.enum(["native", "scanned", "mixed"]);
export type PdfKind = z.infer<typeof PdfKindSchema>;

export const CellRoleSchema = z.enum([
  "header",
  "data",
  "footer",
  "summary",
  "empty",
  "unknown",
]);

export const IntermediateCellSchema = z.object({
  id: z.string(),
  page: z.number().int().positive().nullable(),
  row: z.number().int().nonnegative().nullable(),
  column: z.number().int().nonnegative().nullable(),
  raw_text: z.string(),
  bbox: BoundingBoxSchema.nullable(),
  extraction_method: ExtractionMethodSchema,
  ocr_confidence: z.number().min(0).max(1).nullable(),
  role: CellRoleSchema.default("unknown"),
  mapped_field: CanonicalFieldSchema.nullable().default(null),
  sheet: z.string().nullable().optional().default(null),
});

export type IntermediateCell = z.infer<typeof IntermediateCellSchema>;

export const IntermediateRowSchema = z.object({
  id: z.string(),
  page: z.number().int().positive().nullable(),
  row_index: z.number().int().nonnegative(),
  role: CellRoleSchema.default("unknown"),
  cells: z.array(IntermediateCellSchema),
  is_continuation: z.boolean().default(false),
  sheet: z.string().nullable().optional().default(null),
});

export type IntermediateRow = z.infer<typeof IntermediateRowSchema>;

export const IntermediateTableSchema = z.object({
  id: z.string(),
  page_start: z.number().int().positive().nullable(),
  page_end: z.number().int().positive().nullable(),
  sheet: z.string().nullable().optional().default(null),
  headers: z.array(
    z.object({
      column: z.number().int().nonnegative(),
      raw_text: z.string(),
      mapped_field: CanonicalFieldSchema,
    }),
  ),
  rows: z.array(IntermediateRowSchema),
  repeated_header_pages: z.array(z.number().int().positive()).default([]),
});

export type IntermediateTable = z.infer<typeof IntermediateTableSchema>;

export const IntermediatePageSchema = z.object({
  page: z.number().int().positive(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  kind: z.enum(["text", "image", "mixed"]).default("text"),
  text_items: z.array(
    z.object({
      text: z.string(),
      bbox: BoundingBoxSchema.nullable(),
      ocr_confidence: z.number().min(0).max(1).nullable().default(null),
    }),
  ),
  raw_text: z.string(),
});

export type IntermediatePage = z.infer<typeof IntermediatePageSchema>;

export const IntermediateExtractionSchema = z.object({
  document_id: z.string(),
  source_extension: z.string().nullable(),
  mime_type: z.string().nullable(),
  extraction_method: ExtractionMethodSchema,
  pdf_kind: PdfKindSchema.nullable().default(null),
  page_count: z.number().int().nonnegative(),
  sheet_names: z.array(z.string()).default([]),
  pages: z.array(IntermediatePageSchema).default([]),
  tables: z.array(IntermediateTableSchema).default([]),
  cells: z.array(IntermediateCellSchema).default([]),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      page: z.number().nullable().optional().default(null),
    }),
  ).default([]),
  extracted_at: z.string().datetime(),
});

export type IntermediateExtraction = z.infer<typeof IntermediateExtractionSchema>;

export const DocumentExtractionResponseSchema = z.object({
  success: z.literal(true),
  stage: z.literal("document_extraction"),
  run_id: z.string(),
  document_id: z.string(),
  intermediate: IntermediateExtractionSchema,
  warnings: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        path: z.string().nullable().optional().default(null),
        details: z.record(z.unknown()).optional().default({}),
      }),
    )
    .default([]),
});

export type DocumentExtractionResponse = z.infer<typeof DocumentExtractionResponseSchema>;
