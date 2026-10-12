/**
 * Lightweight signed web sessions for the analysis UI.
 * In-memory store — fine for single-node demo / small deployments.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type WebUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
};

export type SessionRecord = {
  token: string;
  userId: string;
  email: string;
  name: string;
  createdAt: number;
  expiresAt: number;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const sessions = new Map<string, SessionRecord>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPassword(password: string, salt = "bsapp-web-v1"): string {
  return sha256(`${salt}:${password}`);
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const a = Buffer.from(hashPassword(password));
  const b = Buffer.from(passwordHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createSession(user: WebUser): SessionRecord {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const record: SessionRecord = {
    token,
    userId: user.id,
    email: user.email,
    name: user.name,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, record);
  return record;
}

export function getSession(token: string | null | undefined): SessionRecord | null {
  if (!token) return null;
  const record = sessions.get(token);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return record;
}

export function destroySession(token: string | null | undefined): void {
  if (token) sessions.delete(token);
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("=") || "");
  }
  return null;
}

export const SESSION_COOKIE = "sa_session";
