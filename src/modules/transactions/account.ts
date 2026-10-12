/**
 * Account / statement metadata extraction from intermediate text.
 * Never invents missing fields.
 */

import type { Account, Statement } from "../../contracts/index.js";
import { AccountSchema, StatementSchema } from "../../contracts/index.js";
import type { IntermediateExtraction } from "../extraction/types.js";
import { normalizeDate } from "../normalization/dates.js";
import { parseAmount } from "../normalization/amounts.js";

function collectText(intermediate: IntermediateExtraction): string {
  const chunks: string[] = [];
  for (const page of intermediate.pages) {
    if (page.raw_text) chunks.push(page.raw_text);
  }
  for (const table of intermediate.tables) {
    for (const row of table.rows.slice(0, 15)) {
      chunks.push(row.cells.map((c) => c.raw_text).join(" "));
    }
  }
  return chunks.join("\n");
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m?.[1]) {
      const v = m[1].trim();
      if (v) return v;
    }
  }
  return null;
}

export function extractAccountInfo(intermediate: IntermediateExtraction): Account {
  const text = collectText(intermediate);

  const account_number = firstMatch(text, [
    /\bAccount\s*(?:No\.?|Number|#)\s*[:.-]?\s*([0-9]{6,20})\b/i,
    /\bA\/C\s*(?:No\.?)?\s*[:.-]?\s*([0-9]{6,20})\b/i,
    /\bAcc(?:ount)?\s*[:.-]?\s*([0-9]{10,20})\b/i,
  ]);

  const account_name = firstMatch(text, [
    /\bAccount\s*Name\s*[:.-]?\s*([A-Za-z][A-Za-z0-9 ,.'&-]{2,80}?)(?=\s+(?:Branch|Account\s*Class|Account\s*Number|Customer|Currency|Address|Statement|Summary|Customer's)\b|$)/i,
    /\bCustomer\s*Name\s*[:.-]?\s*([A-Za-z][A-Za-z0-9 ,.'&-]{2,80}?)(?=\s+(?:Branch|Account|Address|Currency)\b|$)/i,
  ]);

  const bank_name = firstMatch(text, [
    /\b(Access Bank(?:\s+Plc)?)\b/i,
    /\bBank\s*Name\s*[:.-]?\s*([A-Za-z0-9 ,.'&-]{3,80})/i,
    /\b([A-Z][A-Za-z0-9 &.'-]{1,30}\s+Bank(?:\s+Plc)?)\b/,
  ]);

  const account_type = firstMatch(text, [
    /\bAccount\s*(?:Class|Type)\s*[:.-]?\s*([A-Za-z0-9_-]{3,40})/i,
    /\b(Current|Savings|Cheque|Checking|Domiciary)\s+Account\b/i,
  ]);

  const currency = firstMatch(text, [
    /\bCurrency\s*[:.-]?\s*([A-Z]{3})\b/i,
    /\b(?:in|currency)\s+(NGN|USD|EUR|GBP|ZAR|GHS|KES)\b/i,
  ]);

  const branch = firstMatch(text, [
    /\bBranch\s*[:.-]?\s*([A-Za-z0-9 ,.'&-]{2,60})/i,
  ]);

  return AccountSchema.parse({
    account_name,
    account_number,
    bank_name,
    account_type,
    currency: currency?.toUpperCase() ?? null,
    branch,
  });
}

export function extractStatementMeta(
  intermediate: IntermediateExtraction,
  account: Account,
): Statement {
  const text = collectText(intermediate);

  const period = text.match(
    /\bStatement\s+Period\s*[:.-]?\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,4}[/-]\d{1,2}[/-]\d{1,4}|\d{4}-\d{2}-\d{2})\s*(?:to|-|–)\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,4}[/-]\d{1,2}[/-]\d{1,4}|\d{4}-\d{2}-\d{2})/i,
  );

  const opening = text.match(/\bOpening\s+Balance\s*[:.-]?\s*([^\n]+)/i);
  const closing = text.match(/\bClosing\s+Balance\s*[:.-]?\s*([^\n]+)/i);

  const openingAmount = opening
    ? parseAmount(opening[1].match(/-?[\d,]+\.\d{2}/)?.[0] ?? opening[1])?.signed ?? null
    : null;
  const closingAmount = closing
    ? parseAmount(closing[1].match(/-?[\d,]+\.\d{2}/)?.[0] ?? closing[1])?.signed ?? null
    : null;

  return StatementSchema.parse({
    id: intermediate.document_id,
    account,
    bank_name: account.bank_name,
    currency: account.currency,
    statement_period_start: period ? normalizeDate(period[1]) : null,
    statement_period_end: period ? normalizeDate(period[2]) : null,
    opening_balance: openingAmount,
    closing_balance: closingAmount,
    page_count: intermediate.page_count || null,
    extracted_at: intermediate.extracted_at,
  });
}
