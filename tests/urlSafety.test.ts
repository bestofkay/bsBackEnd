import {
  assertHttpUrl,
  isBlockedIpAddress,
  isBlockedHostname,
  sanitizeUrlForLogs,
} from "../src/modules/security/urlSafety.js";

describe("URL SSRF safety", () => {
  it("rejects non-http schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/a.pdf",
      "gopher://example.com/1",
      "data:text/plain,hi",
      "javascript:alert(1)",
    ]) {
      const result = assertHttpUrl(url, false);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects localhost and loopback literals", () => {
    expect(assertHttpUrl("http://localhost/statement.pdf", false).ok).toBe(false);
    expect(assertHttpUrl("http://127.0.0.1/statement.pdf", false).ok).toBe(false);
    expect(assertHttpUrl("http://0.0.0.0/statement.pdf", false).ok).toBe(false);
    expect(assertHttpUrl("http://[::1]/statement.pdf", false).ok).toBe(false);
  });

  it("rejects private and metadata IPs", () => {
    for (const ip of [
      "10.0.0.1",
      "192.168.1.1",
      "172.16.5.5",
      "169.254.169.254",
      "100.64.1.1",
    ]) {
      expect(isBlockedIpAddress(ip, false)).toBe(true);
      expect(assertHttpUrl(`http://${ip}/x.pdf`, false).ok).toBe(false);
    }
  });

  it("rejects internal DNS hostnames", () => {
    expect(isBlockedHostname("metadata.google.internal", false)).toBe(true);
    expect(isBlockedHostname("files.local", false)).toBe(true);
    expect(isBlockedHostname("db.internal", false)).toBe(true);
    expect(assertHttpUrl("http://metadata.google.internal/latest", false).ok).toBe(false);
  });

  it("accepts public https URLs at the scheme/host layer", () => {
    const result = assertHttpUrl("https://example.com/bank-statement.pdf", false);
    expect(result.ok).toBe(true);
  });

  it("sanitizes credentials and query strings from logs", () => {
    const sanitized = sanitizeUrlForLogs(
      "https://user:token@files.example.com/stmt.pdf?X-Amz-Signature=secret&foo=1",
    );
    expect(sanitized).toBe("https://files.example.com/stmt.pdf");
    expect(sanitized).not.toContain("token");
    expect(sanitized).not.toContain("Signature");
  });

  it("rejects embedded URL credentials", () => {
    const result = assertHttpUrl("https://user:pass@example.com/a.pdf", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("URL_CREDENTIALS_REJECTED");
    }
  });
});
