/**
 * File-backed web users for the Statement Analysis UI.
 * Seeded from WEB_USERS env (or a demo account) on first run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { hashPassword, type WebUser } from "./sessions.js";

function resolveUsersFilePath(): string {
  // Prefer DATA_DIR (Railway volume) so seeded users survive redeploys.
  const dataDir = (process.env.DATA_DIR || "").trim();
  if (dataDir) return path.resolve(dataDir, "web-users.json");
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../data/web-users.json",
  );
}

const usersFilePath = resolveUsersFilePath();

type StoredUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
};

let cache: StoredUser[] | null = null;

function ensureDir(): void {
  const dir = path.dirname(usersFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seedUsers(): StoredUser[] {
  const now = new Date().toISOString();
  const raw = process.env.WEB_USERS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<{
        email: string;
        password: string;
        name?: string;
      }>;
      return parsed.map((u, i) => ({
        id: `user_${i + 1}`,
        email: u.email.toLowerCase(),
        name: u.name ?? u.email.split("@")[0] ?? "User",
        passwordHash: hashPassword(u.password),
        createdAt: now,
      }));
    } catch {
      // fall through
    }
  }
  return [
    {
      id: "user_demo",
      email: "demo@statement.local",
      name: "Demo Analyst",
      passwordHash: hashPassword("demo1234"),
      createdAt: now,
    },
  ];
}

function readFile(): StoredUser[] {
  if (!fs.existsSync(usersFilePath)) {
    const seeded = seedUsers();
    ensureDir();
    fs.writeFileSync(usersFilePath, JSON.stringify(seeded, null, 2), "utf8");
    return seeded;
  }
  try {
    const raw = fs.readFileSync(usersFilePath, "utf8");
    const parsed = JSON.parse(raw) as StoredUser[];
    if (!Array.isArray(parsed)) return seedUsers();
    return parsed;
  } catch {
    return seedUsers();
  }
}

function writeFile(users: StoredUser[]): void {
  ensureDir();
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), "utf8");
  cache = users;
}

function getAll(): StoredUser[] {
  if (!cache) cache = readFile();
  return cache;
}

export function listWebUsers(): Array<{
  id: string;
  email: string;
  name: string;
  createdAt: string;
}> {
  return getAll().map(({ id, email, name, createdAt }) => ({
    id,
    email,
    name,
    createdAt,
  }));
}

export function findWebUserByEmail(email: string): WebUser | null {
  const normalized = email.toLowerCase();
  const user = getAll().find((u) => u.email === normalized);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
  };
}

export function createWebUser(input: {
  email: string;
  password: string;
  name?: string;
}): { ok: true; user: { id: string; email: string; name: string; createdAt: string } } | { ok: false; error: string } {
  const email = input.email.trim().toLowerCase();
  const name = (input.name?.trim() || email.split("@")[0] || "User").slice(0, 120);
  const password = input.password;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Valid email is required" };
  }
  if (!password || password.length < 4 || password.length > 200) {
    return { ok: false, error: "Password must be 4–200 characters" };
  }

  const users = getAll();
  if (users.some((u) => u.email === email)) {
    return { ok: false, error: "A user with this email already exists" };
  }

  const createdAt = new Date().toISOString();
  const user: StoredUser = {
    id: `user_${randomBytes(6).toString("hex")}`,
    email,
    name,
    passwordHash: hashPassword(password),
    createdAt,
  };
  writeFile([...users, user]);
  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, createdAt },
  };
}

export function reloadWebUsersFromDisk(): void {
  cache = null;
  getAll();
}

/** @deprecated Prefer listWebUsers / findWebUserByEmail */
export function loadWebUsers(_raw?: string): WebUser[] {
  return getAll().map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    passwordHash: u.passwordHash,
  }));
}
