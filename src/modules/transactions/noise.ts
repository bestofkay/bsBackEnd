/**
 * Non-transaction content filters (headers, footers, notices, ads, legalese).
 */

const NOISE_PATTERNS: RegExp[] = [
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /\bpage\s+\d+\s+of\s+\d+\b/i,
  /\bcontinued\b/i,
  /\bend of statement\b/i,
  /\bstatement of account\b/i,
  /\baccount statement\b/i,
  /\bopening balance\b/i,
  /\bclosing balance\b/i,
  /\bbrought forward\b/i,
  /\bcarried forward\b/i,
  /\bbalance b\/f\b/i,
  /\bbalance c\/f\b/i,
  /\btotal[s]?\b/i,
  /\bconfidential\b/i,
  /\bfor enquiry\b/i,
  /\bcustomer service\b/i,
  /\bwww\./i,
  /\bterms and conditions\b/i,
  /\blegal\b/i,
  /\badvertisement\b/i,
  /\bpromo(tion)?\b/i,
  /\bplease note\b/i,
  /\bimportant notice\b/i,
  /\bdisclaimer\b/i,
  /\ball rights reserved\b/i,
];

const HEADER_LIKE =
  /^(date|txn date|transaction date|value date|posting date|description|narration|details|debit|credit|withdrawal|deposit|amount|balance|running balance|reference|ref\.?)$/i;

export function isNoiseLine(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (HEADER_LIKE.test(t)) return true;

  // Single-spaced header rows: "Date Description Debit Credit Balance"
  const tokens = t.split(/\s+/).map((p) => p.toLowerCase());
  const headerWords = new Set([
    "date",
    "description",
    "narration",
    "details",
    "debit",
    "credit",
    "amount",
    "balance",
    "reference",
    "ref",
    "withdrawal",
    "deposit",
    "transaction",
    "value",
    "posting",
    "running",
  ]);
  const headerHits = tokens.filter((p) => headerWords.has(p)).length;
  if (tokens.length >= 3 && headerHits >= 3 && headerHits / tokens.length >= 0.6) {
    return true;
  }

  // Multi-column header row with wide gaps
  const parts = t.split(/\s{2,}|\t/).map((p) => p.trim().toLowerCase());
  if (parts.length >= 3) {
    const hits = parts.filter((p) =>
      /^(date|description|narration|debit|credit|amount|balance|ref|reference|withdrawal|deposit)$/.test(
        p,
      ),
    ).length;
    if (hits >= 3) return true;
  }
  return NOISE_PATTERNS.some((p) => p.test(t));
}

export function isSummaryLabel(text: string): boolean {
  return /\b(opening balance|closing balance|available balance|total[s]?|brought forward|carried forward)\b/i.test(
    text,
  );
}

export function isReferenceToken(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(ref(?:erence)?[:.\s#-]*)/i.test(t)) return true;
  if (/^REF[\s#:.-]*[A-Z0-9_/-]+$/i.test(t)) return true;
  // Long alphanumeric ids often used as refs
  if (/^[A-Z0-9][A-Z0-9_/-]{5,}$/i.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t)) return true;
  return false;
}

export function extractReference(text: string): string | null {
  // Require REF/REFERENCE marker with separator, and an id that includes a digit.
  const explicit = text.match(/\bREF(?:ERENCE)?\s*[:.#-]\s*([A-Z0-9][A-Z0-9_/-]*\d[A-Z0-9_/-]*)/i);
  if (explicit?.[1]) return explicit[1];
  const spaced = text.match(/\bREF(?:ERENCE)?\s+([A-Z0-9][A-Z0-9_/-]*\d[A-Z0-9_/-]*)/i);
  if (spaced?.[1]) return spaced[1];
  const txnId = text.match(
    /\b(?:TXN|TRANS(?:ACTION)?)\s*(?:ID|NO\.?)?\s*[:.#-]?\s*([A-Z0-9][A-Z0-9_/-]*\d[A-Z0-9_/-]*)/i,
  );
  if (txnId?.[1]) return txnId[1];
  return null;
}
