/**
 * Core transaction reconstruction from Group 3 intermediate IR.
 */

import type { CanonicalField, IntermediateExtraction, IntermediateRow, IntermediateTable } from "../extraction/types.js";
import { normalizeDate, extractDateFromText, looksLikeDate } from "../normalization/dates.js";
import {
  looksLikeAmount,
  normalizeDebitCreditAmount,
  parseAmount,
} from "../normalization/amounts.js";
import { classifyTransactionType } from "../normalization/types.js";
import { normalizeDescription, normalizeCurrency } from "../normalization/index.js";
import {
  extractReference,
  isNoiseLine,
  isReferenceToken,
  isSummaryLabel,
} from "./noise.js";
import { buildCanonicalTransaction, type RawTransactionDraft } from "./canonical.js";
import type { Transaction } from "../../contracts/index.js";
import { roundMoney } from "../money/index.js";

type FieldMap = Partial<Record<CanonicalField, number>>;

function headerMap(table: IntermediateTable): FieldMap {
  const map: FieldMap = {};
  for (const h of table.headers) {
    if (h.mapped_field !== "unknown") {
      map[h.mapped_field] = h.column;
    }
  }
  return map;
}

function cellAt(row: IntermediateRow, col: number | undefined): string {
  if (col == null) return "";
  return row.cells.find((c) => c.column === col)?.raw_text?.trim() ?? "";
}

function rowText(row: IntermediateRow): string {
  return row.cells
    .map((c) => c.raw_text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTransactionStartRow(row: IntermediateRow, fields: FieldMap): boolean {
  if (row.role === "header" || row.role === "footer" || row.role === "empty") return false;
  const text = rowText(row);
  if (!text || isNoiseLine(text) || isSummaryLabel(text)) return false;

  const dateCol = fields.transaction_date ?? fields.value_date ?? fields.posting_date;
  const dateRaw = cellAt(row, dateCol);
  if (dateRaw && looksLikeDate(dateRaw)) return true;

  // Free-form: first cell/date token
  if (extractDateFromText(text)) {
    // Prefer rows that also look monetary or descriptive
    const hasMoney =
      looksLikeAmount(cellAt(row, fields.debit)) ||
      looksLikeAmount(cellAt(row, fields.credit)) ||
      looksLikeAmount(cellAt(row, fields.amount)) ||
      looksLikeAmount(cellAt(row, fields.balance)) ||
      [...row.cells].some((c) => looksLikeAmount(c.raw_text));
    const hasDesc = Boolean(cellAt(row, fields.description)) || row.cells.length >= 1;
    return hasMoney || hasDesc;
  }
  return false;
}

function isContinuationRow(row: IntermediateRow, fields: FieldMap): boolean {
  if (row.role === "header" || row.role === "footer" || row.role === "empty") return false;
  if (row.is_continuation) return true;
  const text = rowText(row);
  if (!text || isNoiseLine(text) || isSummaryLabel(text)) return false;

  const dateCol = fields.transaction_date ?? fields.value_date ?? fields.posting_date;
  const dateRaw = cellAt(row, dateCol);
  if (dateRaw && looksLikeDate(dateRaw)) return false;
  if (extractDateFromText(text) && looksLikeAmount(text.split(/\s+/).pop() ?? "")) {
    // New txn-like line
    return false;
  }
  if (extractDateFromText(text)) return false;

  // Continuation if description-like / ref-like / bank name without a leading date
  return true;
}

type MutableTxn = {
  draft: RawTransactionDraft;
  descriptionParts: string[];
};

function applyRowToTxn(txn: MutableTxn, row: IntermediateRow, fields: FieldMap, isStart: boolean): void {
  const text = rowText(row);

  if (isStart) {
    const dateCol = fields.transaction_date;
    const valueCol = fields.value_date;
    const postCol = fields.posting_date;

    const txDate = normalizeDate(cellAt(row, dateCol)) ?? extractDateFromText(cellAt(row, dateCol) || text)?.iso ?? null;
    const valueDate = normalizeDate(cellAt(row, valueCol));
    const postDate = normalizeDate(cellAt(row, postCol));

    if (txDate) txn.draft.transaction_date = txDate;
    if (valueDate) txn.draft.value_date = valueDate;
    if (postDate) txn.draft.posting_date = postDate;
    if (!txn.draft.transaction_date && valueDate) txn.draft.transaction_date = valueDate;
    if (!txn.draft.transaction_date && postDate) txn.draft.transaction_date = postDate;
  }

  const desc = cellAt(row, fields.description);
  if (desc) txn.descriptionParts.push(desc);
  else if (!isStart) {
    // Free-form continuation lines become description
    const cleaned = text
      .replace(/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\s*/g, "")
      .trim();
    if (cleaned && !looksLikeAmount(cleaned) && !isReferenceToken(cleaned)) {
      txn.descriptionParts.push(cleaned);
    } else if (cleaned && isReferenceToken(cleaned) && !txn.draft.reference) {
      txn.draft.reference = extractReference(cleaned) ?? cleaned.replace(/^REF(?:ERENCE)?[:.\s#-]*/i, "").trim();
    } else if (cleaned && looksLikeAmount(cleaned)) {
      // Amounts on continuation: first money → amount/debit/credit, second → balance heuristic
      attachAmountToken(txn, cleaned);
    }
  } else if (isStart && !desc) {
    // Description may be mixed into other cells
    for (const cell of row.cells) {
      const field = [...Object.entries(fields)].find(([, col]) => col === cell.column)?.[0] as
        | CanonicalField
        | undefined;
      if (field && field !== "unknown") continue;
      const raw = cell.raw_text.trim();
      if (!raw || looksLikeDate(raw) || looksLikeAmount(raw)) continue;
      if (isReferenceToken(raw)) {
        if (!txn.draft.reference) {
          txn.draft.reference = extractReference(raw) ?? raw.replace(/^REF(?:ERENCE)?[:.\s#-]*/i, "").trim();
        }
        continue;
      }
      txn.descriptionParts.push(raw);
    }
  }

  const refCell = cellAt(row, fields.reference);
  if (refCell && !txn.draft.reference) {
    txn.draft.reference = extractReference(refCell) ?? refCell;
  } else {
    const fromText = extractReference(text);
    if (fromText && !txn.draft.reference) txn.draft.reference = fromText;
  }

  const money = normalizeDebitCreditAmount({
    debit: cellAt(row, fields.debit) || null,
    credit: cellAt(row, fields.credit) || null,
    amount: cellAt(row, fields.amount) || null,
  });
  if (money.debit != null) txn.draft.debit = money.debit;
  if (money.credit != null) txn.draft.credit = money.credit;
  if (money.amount != null) txn.draft.amount = money.amount;

  const bal = parseAmount(cellAt(row, fields.balance));
  if (bal) txn.draft.balance = bal.signed;

  // If structured amount columns empty, try other numeric cells
  if (txn.draft.debit == null && txn.draft.credit == null && txn.draft.amount == null) {
    const amountCells = row.cells
      .filter((c) => {
        const field = [...Object.entries(fields)].find(([, col]) => col === c.column)?.[0];
        return !field || field === "unknown" || field === "amount";
      })
      .map((c) => c.raw_text)
      .filter((t) => looksLikeAmount(t));
    if (amountCells.length >= 1) attachAmountToken(txn, amountCells[0]);
    if (amountCells.length >= 2 && txn.draft.balance == null) {
      const maybeBal = parseAmount(amountCells[amountCells.length - 1]);
      if (maybeBal) txn.draft.balance = maybeBal.signed;
    }
  }
}

function attachAmountToken(txn: MutableTxn, token: string): void {
  const parsed = parseAmount(token);
  if (!parsed) return;
  if (txn.draft.amount == null && txn.draft.debit == null && txn.draft.credit == null) {
    const money = normalizeDebitCreditAmount({ amount: token });
    txn.draft.debit = money.debit;
    txn.draft.credit = money.credit;
    txn.draft.amount = money.amount;
    return;
  }
  // Subsequent amount on continuation often running balance
  if (txn.draft.balance == null) {
    txn.draft.balance = parsed.signed;
  }
}

function finalizeTxn(txn: MutableTxn, currency: string | null): Transaction {
  const description = normalizeDescription(txn.descriptionParts.join(" ").trim()) ?? null;
  const reference = normalizeDescription(txn.draft.reference ?? null);
  const transaction_type = classifyTransactionType(description);

  return buildCanonicalTransaction({
    ...txn.draft,
    description,
    reference,
    currency: normalizeCurrency(txn.draft.currency ?? currency),
    transaction_type,
    raw: {
      ...(txn.draft.raw ?? {}),
      description_parts: txn.descriptionParts,
    },
  });
}

export function reconstructFromTable(
  table: IntermediateTable,
  currency: string | null = null,
): Transaction[] {
  const fields = headerMap(table);
  const transactions: Transaction[] = [];
  let current: MutableTxn | null = null;

  const rows = table.rows.filter((r) => r.role !== "header");

  for (const row of rows) {
    const text = rowText(row);
    if (!text) continue;
    if (isNoiseLine(text) || (isSummaryLabel(text) && !extractDateFromText(text))) {
      continue;
    }

    if (isTransactionStartRow(row, fields)) {
      if (current) transactions.push(finalizeTxn(current, currency));
      current = { draft: {}, descriptionParts: [] };
      applyRowToTxn(current, row, fields, true);
      continue;
    }

    if (current && isContinuationRow(row, fields)) {
      applyRowToTxn(current, row, fields, false);
      continue;
    }

    // Orphan data row with amounts but no date — skip rather than invent
  }

  if (current) transactions.push(finalizeTxn(current, currency));
  return transactions.filter(
    (t) =>
      t.transaction_date != null ||
      t.debit != null ||
      t.credit != null ||
      t.amount != null ||
      (t.description != null && t.description.length > 0),
  );
}

/**
 * Reconstruct multi-line free-form blocks (e.g. OCR lines):
 * 12/09/2026
 * TRANSFER TO JOHN DOE
 * ACCESS BANK
 * REF 839292
 * 50,000.00
 * 1,200,000.00
 */
export function reconstructFromLines(
  lines: string[],
  currency: string | null = null,
): Transaction[] {
  const cleaned = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const transactions: Transaction[] = [];
  let current: MutableTxn | null = null;
  let pendingAmounts: string[] = [];

  const flush = () => {
    if (!current) return;
    if (pendingAmounts.length >= 1) {
      attachAmountToken(current, pendingAmounts[0]);
    }
    if (pendingAmounts.length >= 2) {
      const bal = parseAmount(pendingAmounts[pendingAmounts.length - 1]);
      if (bal) current.draft.balance = bal.signed;
    }
    pendingAmounts = [];
    transactions.push(finalizeTxn(current, currency));
    current = null;
  };

  for (const line of cleaned) {
    if (isNoiseLine(line) || isSummaryLabel(line)) continue;

    const date = extractDateFromText(line);
    const trimmed = line.trim();
    const startsWithDate = Boolean(date && trimmed.startsWith(date.raw));
    const lineIsMostlyDate = Boolean(date && trimmed.replace(date.raw, "").trim().length < 3);

    if (date && (lineIsMostlyDate || looksLikeDate(trimmed) || startsWithDate)) {
      flush();
      current = {
        draft: { transaction_date: date.iso },
        descriptionParts: [],
      };
      let rest = trimmed.slice(date.raw.length).trim();

      // Optional value date immediately after posted date (Access Bank style)
      const valueDate = extractDateFromText(rest);
      if (valueDate && rest.startsWith(valueDate.raw)) {
        current.draft.value_date = valueDate.iso;
        rest = rest.slice(valueDate.raw.length).trim();
      }

      // One-line ledger row: Description Debit Credit Balance
      // Debit/Credit may be "-" when empty, or signed (e.g. -9,000.00 reversals).
      // Trailing page footer text after balance is ignored.
      const moneyTail =
        /(-?[\d,]+\.\d{1,2}|-)\s+(-?[\d,]+\.\d{1,2}|-)\s+(-?[\d,]+\.\d{1,2})(?:\s+\S.*)?\s*$/.exec(
          rest,
        );
      if (moneyTail && moneyTail.index != null) {
        const desc = rest.slice(0, moneyTail.index).trim();
        if (desc && !/^opening balance$/i.test(desc)) {
          current.descriptionParts.push(desc);
        } else if (/^opening balance$/i.test(desc)) {
          // Statement opening marker — keep balance only for meta, skip as txn
          current = null;
          pendingAmounts = [];
          continue;
        }

        const debitTok = moneyTail[1];
        const creditTok = moneyTail[2];
        const balTok = moneyTail[3];

        const money = normalizeDebitCreditAmount({
          debit: debitTok === "-" ? null : debitTok,
          credit: creditTok === "-" ? null : creditTok,
        });
        current.draft.debit = roundMoney(money.debit);
        current.draft.credit = roundMoney(money.credit);
        current.draft.amount = roundMoney(money.amount);

        const bal = parseAmount(balTok);
        if (bal) current.draft.balance = roundMoney(bal.signed);

        flush();
        continue;
      }

      if (rest && !looksLikeAmount(rest)) current.descriptionParts.push(rest);
      continue;
    }

    if (!current) {
      // Skip until a date start
      continue;
    }

    if (looksLikeAmount(line) && !/[A-Za-z]{3,}/.test(line.replace(/\b(NGN|USD|DR|CR)\b/gi, ""))) {
      pendingAmounts.push(line);
      continue;
    }

    const ref = extractReference(line);
    if (isReferenceToken(line) || ref) {
      if (ref && !current.draft.reference) {
        current.draft.reference = ref;
      } else if (!current.draft.reference) {
        current.draft.reference = line.replace(/^REF(?:ERENCE)?[:.\s#-]*/i, "").trim();
      }
      // Pure reference lines are not narration; mixed narration+REF must keep description.
      if (isReferenceToken(line) || /^\s*REF(?:ERENCE)?\b/i.test(line)) {
        continue;
      }
      current.descriptionParts.push(line);
      continue;
    }

    current.descriptionParts.push(line);
  }

  flush();
  return transactions;
}

export function reconstructTransactions(
  intermediate: IntermediateExtraction,
  currency: string | null = null,
): Transaction[] {
  const fromTables: Transaction[] = [];
  for (const table of intermediate.tables) {
    fromTables.push(...reconstructFromTable(table, currency));
  }

  // Prefer dense raw_text streams when present: PDF content-stream order keeps
  // description+amounts together. Geometric text_items clustering often splits
  // Access-Bank-style rows across nearby Y positions and drops/mispairs amounts.
  const rawPageStreams: string[][] = [];
  const geoLines: string[] = [];
  for (const page of intermediate.pages) {
    if (page.raw_text) {
      rawPageStreams.push(expandDenseTransactionStreams([page.raw_text]));
    }
    if (page.text_items && page.text_items.length > 0) {
      geoLines.push(...linesFromTextItems(page.text_items));
    } else if (page.raw_text) {
      geoLines.push(...page.raw_text.split(/\r?\n/));
    }
  }

  const rawExpanded = stitchPagesDroppingOverlap(rawPageStreams);
  const geoExpanded = expandDenseTransactionStreams(geoLines);
  const ledgerScore = (lines: string[]) =>
    lines.filter((l) =>
      /^\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}\s+\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}/.test(l) ||
      /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(l),
    ).length;
  const lines =
    ledgerScore(rawExpanded) >= ledgerScore(geoExpanded) ? rawExpanded : geoExpanded;

  const fromLines = dedupeExactLedgerTransactions(reconstructFromLines(lines, currency));
  if (fromTables.length === 0) return fromLines;
  // If table path found rows, keep them; otherwise fall back to lines.
  const chosen =
    fromTables.length >= Math.max(1, Math.floor(fromLines.length * 0.5))
      ? fromTables
      : fromLines.length > fromTables.length
        ? fromLines
        : fromTables;
  return dedupeExactLedgerTransactions(chosen);
}

function isLedgerLine(line: string): boolean {
  return (
    /^\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}\s+\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}/.test(line) ||
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(line)
  );
}

/**
 * When page N+1 repeats the tail of page N (PDF pagination overlap), skip the
 * overlapping prefix of page N+1. Only drops a prefix that is an exact match
 * to a suffix of the previous page — safe for transfer/reversal/transfer cycles.
 */
export function stitchPagesDroppingOverlap(pageLineStreams: string[][]): string[] {
  const out: string[] = [];
  for (const pageLines of pageLineStreams) {
    const ledger = pageLines.filter((l) => l && (isLedgerLine(l) || l.trim()));
    if (out.length === 0) {
      out.push(...ledger);
      continue;
    }
    const prevLedger = out.filter(isLedgerLine);
    const nextLedger = ledger.filter(isLedgerLine);
    let skipLedger = 0;
    const maxCheck = Math.min(12, prevLedger.length, nextLedger.length);
    for (let n = maxCheck; n >= 1; n--) {
      const suffix = prevLedger.slice(-n);
      const prefix = nextLedger.slice(0, n);
      if (suffix.every((l, i) => l === prefix[i])) {
        skipLedger = n;
        break;
      }
    }
    if (skipLedger === 0) {
      out.push(...ledger);
      continue;
    }
    // Drop only the overlapping ledger lines from the new page; keep non-ledger headers.
    let dropped = 0;
    for (const line of ledger) {
      if (dropped < skipLedger && isLedgerLine(line) && line === nextLedger[dropped]) {
        dropped++;
        continue;
      }
      out.push(line);
    }
  }
  return out;
}

function ledgerFingerprint(t: Transaction): string {
  return [
    t.transaction_date ?? "",
    t.value_date ?? "",
    t.description ?? "",
    t.debit ?? "",
    t.credit ?? "",
    t.balance ?? "",
  ].join("|");
}

/**
 * Drop only immediately consecutive exact duplicate rows.
 * Do not globally dedupe — transfer → reverse → transfer again can share fingerprints.
 */
export function dedupeExactLedgerTransactions(transactions: Transaction[]): Transaction[] {
  const out: Transaction[] = [];
  let prevFp: string | null = null;
  for (const t of transactions) {
    const fp = ledgerFingerprint(t);
    if (prevFp != null && fp === prevFp) continue;
    out.push(t);
    prevFp = fp;
  }
  return out;
}

function linesFromTextItems(
  items: Array<{ text: string; bbox?: { y0?: number; x0?: number } | null }>,
): string[] {
  const sorted = [...items].sort(
    (a, b) => (a.bbox?.y0 ?? 0) - (b.bbox?.y0 ?? 0) || (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0),
  );
  const lines: string[] = [];
  let currentY = Number.NaN;
  let buf: string[] = [];
  for (const item of sorted) {
    const y = Math.round((item.bbox?.y0 ?? 0) / 4) * 4;
    if (!Number.isNaN(currentY) && Math.abs(y - currentY) > 5) {
      const line = buf.join(" ").replace(/\s+/g, " ").trim();
      if (line) lines.push(line);
      buf = [];
    }
    currentY = y;
    if (item.text?.trim()) buf.push(item.text.trim());
  }
  const last = buf.join(" ").replace(/\s+/g, " ").trim();
  if (last) lines.push(last);
  return lines;
}

/**
 * Access Bank / similar statements often flatten many txn rows into one visual stream.
 * Split on repeating posted+value date pairs: 28-APR-26 28-APR-26 ...
 */
function expandDenseTransactionStreams(lines: string[]): string[] {
  const out: string[] = [];
  const datePair =
    /(\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\s+(\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/g;

  for (const line of lines) {
    const matches = [...line.matchAll(datePair)];
    if (matches.length <= 1) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? line.length) : line.length;
      const slice = line.slice(start, end).trim();
      if (slice) out.push(slice);
    }
  }
  return out;
}
