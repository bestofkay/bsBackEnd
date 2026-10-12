/**
 * SSRF-oriented URL safety checks.
 * Validates scheme, hostname, DNS-resolved IPs, and blocklists
 * before any network connection is established.
 */

import net from "node:net";
import dns from "node:dns/promises";
import { createErrorResponse } from "../output/index.js";
import type { ErrorResponse } from "../../contracts/index.js";

export type UrlSafetyOk = {
  ok: true;
  url: URL;
  hostname: string;
  resolvedAddresses: string[];
};

export type UrlSafetyFail = {
  ok: false;
  error: ErrorResponse;
};

export type UrlSafetyResult = UrlSafetyOk | UrlSafetyFail;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const METADATA_IPV4 = new Set(["169.254.169.254", "169.254.170.2"]);

/** Cloud / internal DNS suffixes that must never be fetched. */
const BLOCKED_SUFFIXES = [
  ".local",
  ".internal",
  ".intranet",
  ".corp",
  ".home",
  ".lan",
  ".localhost",
];

function fail(code: string, message: string, details?: Record<string, unknown>): UrlSafetyFail {
  return { ok: false, error: createErrorResponse(code, message, details) };
}

export function sanitizeUrlForLogs(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}

let defaultAllowLoopbackForTests = false;

/** Configure process-wide default (tests may also pass per-call overrides). */
export function setAllowLoopbackForTests(enabled: boolean): void {
  defaultAllowLoopbackForTests = enabled;
}

export function isLoopbackAllowedForTests(): boolean {
  return defaultAllowLoopbackForTests;
}

function isLoopbackHostOrIp(value: string): boolean {
  const v = value.toLowerCase();
  return (
    v === "localhost" ||
    v === "127.0.0.1" ||
    v === "::1" ||
    v.startsWith("127.") ||
    v === "0.0.0.0"
  );
}

export function isBlockedHostname(hostname: string, allowLoopback = false): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if ((allowLoopback || defaultAllowLoopbackForTests) && isLoopbackHostOrIp(host)) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Returns true when the IP must not be contacted (SSRF).
 */
export function isBlockedIpAddress(ip: string, allowLoopback = false): boolean {
  const normalized = ip.toLowerCase().trim();
  if (!net.isIP(normalized)) return true;

  if ((allowLoopback || defaultAllowLoopbackForTests) && isLoopbackHostOrIp(normalized)) {
    return false;
  }

  if (METADATA_IPV4.has(normalized)) return true;

  if (net.isIPv4(normalized)) {
    return isBlockedIpv4(normalized);
  }
  return isBlockedIpv6(normalized);
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (+ metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 docs/test
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 51 || b === 18)) return true;
  if (a === 203 && b === 0) return true;
  // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  if (a >= 224) return true;

  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;

  // IPv4-mapped IPv6 ::ffff:x.x.x.x
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  // Unique local fc00::/7, link-local fe80::/10
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }

  // Expand first hextet roughly for documentation / multicast ranges
  const first = normalized.split(":")[0] ?? "";
  const firstNum = Number.parseInt(first || "0", 16);
  // ff00::/8 multicast
  if (firstNum >= 0xff00) return true;

  return false;
}

export function assertHttpUrl(raw: string, allowLoopback = false): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("INVALID_URL", "The supplied URL is malformed.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail(
      "UNSUPPORTED_URL_PROTOCOL",
      "Only http and https URLs are supported.",
    );
  }

  // Reject credentials embedded in the URL (often signed / sensitive).
  if (parsed.username || parsed.password) {
    return fail(
      "URL_CREDENTIALS_REJECTED",
      "URLs containing embedded credentials are not allowed.",
    );
  }

  let hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  // Some parsers retain brackets for IPv6 literals.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (!hostname) {
    return fail("INVALID_URL", "The supplied URL is missing a hostname.");
  }

  if (isBlockedHostname(hostname, allowLoopback)) {
    return fail("URL_HOST_BLOCKED", "The supplied URL host is not allowed.");
  }

  // Literal IP in the hostname — validate immediately.
  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname, allowLoopback)) {
      return fail("URL_HOST_BLOCKED", "The supplied URL host is not allowed.");
    }
    return {
      ok: true,
      url: parsed,
      hostname,
      resolvedAddresses: [hostname],
    };
  }

  return {
    ok: true,
    url: parsed,
    hostname,
    resolvedAddresses: [],
  };
}

export async function resolveAndValidateHost(
  hostname: string,
  allowLoopback = false,
): Promise<UrlSafetyResult> {
  let normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  if (net.isIP(normalized)) {
    if (isBlockedIpAddress(normalized, allowLoopback)) {
      return fail("URL_HOST_BLOCKED", "The supplied URL host is not allowed.");
    }
    return {
      ok: true,
      url: new URL(`https://${normalized}/`),
      hostname: normalized,
      resolvedAddresses: [normalized],
    };
  }

  if (isBlockedHostname(normalized, allowLoopback)) {
    return fail("URL_HOST_BLOCKED", "The supplied URL host is not allowed.");
  }

  let addresses: string[];
  try {
    const results = await dns.lookup(normalized, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    return fail(
      "REMOTE_FILE_UNAVAILABLE",
      "The statement could not be downloaded from the supplied URL.",
    );
  }

  if (addresses.length === 0) {
    return fail(
      "REMOTE_FILE_UNAVAILABLE",
      "The statement could not be downloaded from the supplied URL.",
    );
  }

  for (const address of addresses) {
    if (isBlockedIpAddress(address, allowLoopback)) {
      return fail("URL_HOST_BLOCKED", "The supplied URL host is not allowed.");
    }
  }

  return {
    ok: true,
    url: new URL(`https://${normalized}/`),
    hostname: normalized,
    resolvedAddresses: addresses,
  };
}

/**
 * Full pre-connect validation: scheme + host + DNS + IP blocklists.
 * Optional allowlist further restricts hosts when configured.
 */
export async function validateUrlForFetch(
  raw: string,
  allowedHosts: string[] = [],
  allowLoopback = false,
): Promise<UrlSafetyResult> {
  const basic = assertHttpUrl(raw, allowLoopback);
  if (!basic.ok) return basic;

  if (allowedHosts.length > 0) {
    const host = basic.hostname;
    const allowed = allowedHosts.some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );
    if (!allowed) {
      return fail("URL_HOST_NOT_ALLOWED", "The supplied URL host is not allowed.");
    }
  }

  const resolved = await resolveAndValidateHost(basic.hostname, allowLoopback);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    url: basic.url,
    hostname: basic.hostname,
    resolvedAddresses: resolved.resolvedAddresses,
  };
}
