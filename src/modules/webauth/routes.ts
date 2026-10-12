import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { publicErrorResponse } from "../api/errors.js";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSession,
  parseCookie,
  verifyPassword,
} from "./sessions.js";
import {
  createWebUser,
  findWebUserByEmail,
  listWebUsers,
  reloadWebUsersFromDisk,
} from "./users.js";
import {
  buildCatalogEntryFromPublic,
  upsertAnalysisInDb,
} from "../catalog/runs.js";
import { isDatabaseConfigured } from "../database/client.js";
import { rebuildAnalysisFromPayload } from "../analysis/refresh.js";
import { config } from "../../config/env.js";

const sampleResultPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../uploads/extraction-result.json",
);
const SAMPLE_REFERENCE_ID = "APT-SAMPLE01";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4).max(200),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4).max(200),
  name: z.string().trim().min(1).max(120).optional(),
});

export function reloadWebUsers(): void {
  reloadWebUsersFromDisk();
}

function cookieOptions(maxAgeMs: number): string {
  const sameSite = config.cookieSameSite;
  // SameSite=None requires Secure; also force Secure in production.
  const secure =
    sameSite === "none" || config.nodeEnv === "production" ? "; Secure" : "";
  const sameSiteAttr =
    sameSite === "none" ? "None" : sameSite === "strict" ? "Strict" : "Lax";
  return `Path=/; HttpOnly; SameSite=${sameSiteAttr}; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

function clearCookieHeader(): string {
  const sameSite = config.cookieSameSite;
  const secure =
    sameSite === "none" || config.nodeEnv === "production" ? "; Secure" : "";
  const sameSiteAttr =
    sameSite === "none" ? "None" : sameSite === "strict" ? "Strict" : "Lax";
  return `Path=/; HttpOnly; SameSite=${sameSiteAttr}; Max-Age=0${secure}`;
}

function requireSession(req: { headers: { cookie?: string } }, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): ReturnType<typeof getSession> {
  const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
  const session = getSession(token);
  if (!session) {
    res.status(401).json(publicErrorResponse("UNAUTHORIZED", "Not signed in"));
    return null;
  }
  return session;
}

export const webAuthRouter = Router();

webAuthRouter.post("/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(publicErrorResponse("INVALID_INPUT", "Email and password required"));
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const user = findWebUserByEmail(email);
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json(publicErrorResponse("UNAUTHORIZED", "Invalid email or password"));
    return;
  }
  const session = createSession(user);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; ${cookieOptions(session.expiresAt - Date.now())}`,
  );
  res.status(200).json({
    success: true,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

webAuthRouter.post("/logout", (req, res) => {
  const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
  destroySession(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${clearCookieHeader()}`);
  res.status(200).json({ success: true });
});

webAuthRouter.get("/me", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.status(200).json({
    success: true,
    user: { id: session.userId, email: session.email, name: session.name },
  });
});

webAuthRouter.get("/users", (req, res) => {
  if (!requireSession(req, res)) return;
  res.status(200).json({
    success: true,
    users: listWebUsers(),
  });
});

webAuthRouter.post("/users", (req, res) => {
  if (!requireSession(req, res)) return;
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(
      publicErrorResponse("INVALID_INPUT", "Email and password (min 4 chars) required"),
    );
    return;
  }
  const created = createWebUser(parsed.data);
  if (!created.ok) {
    const code = created.error.includes("already exists") ? "CONFLICT" : "INVALID_INPUT";
    res.status(code === "CONFLICT" ? 409 : 400).json(publicErrorResponse(code, created.error));
    return;
  }
  res.status(201).json({ success: true, user: created.user });
});

/** Demo helper — always re-analyse sample ledger so flags (e.g. gambler) stay current. */
webAuthRouter.get("/sample-report", async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    if (!fs.existsSync(sampleResultPath)) {
      res
        .status(404)
        .json(publicErrorResponse("NOT_FOUND", "No sample extraction-result.json in uploads/"));
      return;
    }
    const raw = fs.readFileSync(sampleResultPath, "utf8");
    const body = JSON.parse(raw) as Record<string, unknown>;
    const statementPub = (body.statement ?? {}) as Record<string, unknown>;
    body.statement_id = "stmt_APT-SAMPLE01";
    const analysis = rebuildAnalysisFromPayload(body);
    if (!analysis) {
      res
        .status(422)
        .json(publicErrorResponse("INVALID_INPUT", "Sample ledger has no transactions"));
      return;
    }
    body.analysis = analysis as unknown as Record<string, unknown>;
    fs.writeFileSync(sampleResultPath, JSON.stringify(body));

    const enriched = {
      ...body,
      reference_id: SAMPLE_REFERENCE_ID,
      owner_name:
        (typeof statementPub.account_name === "string" && statementPub.account_name) || null,
      analysis_period: { from: null, to: null },
      statement_id: "stmt_APT-SAMPLE01",
      analysis,
    };
    const entry = buildCatalogEntryFromPublic({
      referenceId: SAMPLE_REFERENCE_ID,
      publicResult: enriched,
      ownerName: enriched.owner_name as string | null,
      filename: "extraction-result.json",
      source: "sample",
    });
    entry.statement_id = "stmt_APT-SAMPLE01";
    await upsertAnalysisInDb({
      entry,
      publicResult: enriched,
      analysisJson: analysis as unknown as Record<string, unknown>,
    });
    res.status(200).json({
      ...enriched,
      storage: isDatabaseConfigured() ? "mysql" : "file",
    });
  } catch (err) {
    console.error("sample-report failed", err);
    res.status(500).json(publicErrorResponse("INTERNAL_ERROR", "Failed to read sample report"));
  }
});
