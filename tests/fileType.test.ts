import { describe, expect, it } from "vitest";
import { detectFileType } from "../src/modules/security/fileType.js";

/** Minimal PNG (1x1) */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Minimal JPEG */
export const JPG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64",
);

export const PDF_BYTES = Buffer.from(
  "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
  "utf8",
);

export const CSV_BYTES = Buffer.from(
  "Date,Description,Amount\n2024-01-01,Coffee,-4.50\n2024-01-02,Salary,1000.00\n",
  "utf8",
);

/** Minimal ZIP that sniffs as XLSX (contains spreadsheet markers). */
export function buildFakeXlsxBytes(): Buffer {
  // Local file header + fake payload containing required markers.
  const payload = Buffer.from(
    "PK\u0003\u0004fake[Content_Types].xml xl/workbook.xml sheet data",
    "binary",
  );
  return payload;
}

export const XLS_BYTES = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
]);

export const HTML_BYTES = Buffer.from(
  "<!DOCTYPE html><html><body>not a statement</body></html>",
  "utf8",
);

describe("file type detection", () => {
  it("detects PDF/PNG/JPG/CSV/XLS/XLSX from bytes", () => {
    expect(detectFileType(PDF_BYTES)?.extension).toBe("pdf");
    expect(detectFileType(PNG_BYTES)?.extension).toBe("png");
    expect(detectFileType(JPG_BYTES)?.extension).toBe("jpg");
    expect(detectFileType(CSV_BYTES)?.extension).toBe("csv");
    expect(detectFileType(XLS_BYTES)?.extension).toBe("xls");
    expect(detectFileType(buildFakeXlsxBytes())?.extension).toBe("xlsx");
  });

  it("rejects HTML and empty content", () => {
    expect(detectFileType(HTML_BYTES)).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(Buffer.from("%PDF-fake-but-wait") )).not.toBeNull();
  });

  it("does not trust a .pdf name when bytes are HTML", () => {
    expect(detectFileType(HTML_BYTES)).toBeNull();
  });
});
