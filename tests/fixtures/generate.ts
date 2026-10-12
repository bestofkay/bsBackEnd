/**
 * Synthetic bank-statement fixtures (no real customer data).
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import sharp from "sharp";

export const FIXTURES_DIR = path.resolve("tests/fixtures");

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Build a minimal multi-line text PDF. */
export function buildTextPdf(lines: string[], pageSize: [number, number] = [612, 792]): Buffer {
  const [width, height] = pageSize;
  const contentLines = ["BT", "/F1 10 Tf", "50 740 Td", "14 TL"];
  lines.forEach((line, idx) => {
    if (idx === 0) contentLines.push(`(${pdfEscape(line)}) Tj`);
    else contentLines.push(`T* (${pdfEscape(line)}) Tj`);
  });
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n`,
    `4 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

/** Multi-page PDF with repeated headers and wrapped description simulation. */
export function buildMultiPageStatementPdf(): Buffer {
  // Two separate page content streams
  const page1Lines = [
    "Demo Bank Statement",
    "Date          Description                 Debit      Credit     Balance",
    "2024-01-02    POS PURCHASE COFFEE         4.50                  995.50",
    "2024-01-03    SALARY PAYMENT                         2500.00    3495.50",
    "2024-01-04    ONLINE TRANSFER TO",
    "              JOHN DOE REF 998877         150.00                3345.50",
  ];
  const page2Lines = [
    "Date          Description                 Debit      Credit     Balance",
    "2024-01-05    ATM WITHDRAWAL              200.00                3145.50",
    "2024-01-06    UTILITY BILL PAYMENT        75.25                 3070.25",
    "End of statement",
  ];

  // For simplicity generate two single-page PDFs concatenated is invalid;
  // build a proper 2-page PDF.
  const mkStream = (lines: string[]) => {
    const parts = ["BT", "/F1 10 Tf", "40 750 Td", "14 TL"];
    lines.forEach((line, idx) => {
      if (idx === 0) parts.push(`(${pdfEscape(line)}) Tj`);
      else parts.push(`T* (${pdfEscape(line)}) Tj`);
    });
    parts.push("ET");
    return parts.join("\n");
  };

  const s1 = mkStream(page1Lines);
  const s2 = mkStream(page2Lines);

  const objs: string[] = [];
  objs[1] = "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n";
  objs[2] = "2 0 obj<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>endobj\n";
  objs[3] =
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>endobj\n";
  objs[4] =
    "4 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>endobj\n";
  objs[5] = `5 0 obj<< /Length ${Buffer.byteLength(s1, "utf8")} >>stream\n${s1}\nendstream\nendobj\n`;
  objs[6] = `6 0 obj<< /Length ${Buffer.byteLength(s2, "utf8")} >>stream\n${s2}\nendstream\nendobj\n`;
  objs[7] = "7 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 7; i++) {
    offsets[i] = Buffer.byteLength(pdf, "utf8");
    pdf += objs[i];
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 8\n0000000000 65535 f \n`;
  for (let i = 1; i <= 7; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

/** Image-only PDF (no extractable text) — treated as scanned. */
export function buildScannedLikePdf(): Buffer {
  // Truly empty content stream (no text operators) so pdf.js won't touch fonts.
  const stream = "";
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>endobj\n",
    `4 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export const SAMPLE_CSV = `Date,Description,Debit,Credit,Balance
2024-01-02,POS PURCHASE COFFEE,4.50,,995.50
2024-01-03,SALARY PAYMENT,,2500.00,3495.50
2024-01-04,ONLINE TRANSFER TO JOHN DOE,150.00,,3345.50
,,,
Totals,Summary Row,154.50,2500.00,
`;

export function buildSampleXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const txns = XLSX.utils.aoa_to_sheet([
    ["Transaction Date", "Narration", "Withdrawal", "Deposit", "Running Balance"],
    ["2024-01-02", "POS PURCHASE COFFEE", 4.5, "", 995.5],
    ["2024-01-03", "SALARY PAYMENT", "", 2500, 3495.5],
    ["2024-01-04", "ONLINE TRANSFER TO JOHN DOE REF 998877", 150, "", 3345.5],
  ]);
  const junk = XLSX.utils.aoa_to_sheet([
    ["Notes"],
    ["This sheet has no transactions"],
  ]);
  XLSX.utils.book_append_sheet(wb, junk, "Notes");
  XLSX.utils.book_append_sheet(wb, txns, "Transactions");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Synthetic statement image for OCR (SVG → PNG). */
export async function buildStatementPng(): Promise<Buffer> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400" viewBox="0 0 1000 400">
  <rect width="1000" height="400" fill="white"/>
  <text x="40" y="50" font-family="Arial" font-size="20" fill="black">Demo Bank Statement</text>
  <text x="40" y="100" font-family="Arial" font-size="16" fill="black">Date          Description                 Debit      Credit     Balance</text>
  <text x="40" y="140" font-family="Arial" font-size="16" fill="black">2024-01-02    POS PURCHASE COFFEE         4.50                  995.50</text>
  <text x="40" y="180" font-family="Arial" font-size="16" fill="black">2024-01-03    SALARY PAYMENT                         2500.00    3495.50</text>
  <text x="40" y="220" font-family="Arial" font-size="16" fill="black">2024-01-04    ONLINE TRANSFER             150.00                3345.50</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function writeFixtures(): Promise<{
  simplePdf: string;
  multiPdf: string;
  wrappedPdf: string;
  scannedPdf: string;
  csv: string;
  xlsx: string;
  png: string;
}> {
  await fs.mkdir(FIXTURES_DIR, { recursive: true });

  const simplePdf = path.join(FIXTURES_DIR, "simple-statement.pdf");
  const multiPdf = path.join(FIXTURES_DIR, "multipage-statement.pdf");
  const wrappedPdf = path.join(FIXTURES_DIR, "wrapped-description.pdf");
  const scannedPdf = path.join(FIXTURES_DIR, "scanned-like.pdf");
  const csv = path.join(FIXTURES_DIR, "statement.csv");
  const xlsx = path.join(FIXTURES_DIR, "statement.xlsx");
  const png = path.join(FIXTURES_DIR, "statement.png");

  await fs.writeFile(
    simplePdf,
    buildTextPdf([
      "Demo Bank Statement",
      "Date Description Debit Credit Balance",
      "2024-01-02 POS PURCHASE 4.50  995.50",
      "2024-01-03 SALARY  2500.00 3495.50",
    ]),
  );
  await fs.writeFile(multiPdf, buildMultiPageStatementPdf());
  await fs.writeFile(
    wrappedPdf,
    buildTextPdf([
      "Date          Description                 Amount     Balance",
      "2024-01-04    ONLINE TRANSFER TO",
      "              JOHN DOE REF 998877         -150.00    3345.50",
      "2024-01-05    ATM WITHDRAWAL              -200.00    3145.50",
    ]),
  );
  await fs.writeFile(scannedPdf, buildScannedLikePdf());
  await fs.writeFile(csv, SAMPLE_CSV, "utf8");
  await fs.writeFile(xlsx, buildSampleXlsx());
  await fs.writeFile(png, await buildStatementPng());

  return { simplePdf, multiPdf, wrappedPdf, scannedPdf, csv, xlsx, png };
}
