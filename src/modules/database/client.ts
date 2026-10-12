/**
 * Prisma client bootstrap (optional when DATABASE_URL unset).
 */

import { PrismaClient } from "@prisma/client";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";

let prisma: PrismaClient | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(config.databaseUrl);
}

export function getPrisma(): PrismaClient | null {
  if (!isDatabaseConfigured()) {
    return null;
  }
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: {
        db: { url: config.databaseUrl! },
      },
      log: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    });
  }
  return prisma;
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function healthCheckDatabase(options?: {
  failIfUnreachable?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const client = getPrisma();
  if (!client) {
    return { ok: true, message: "database not configured (skipped)" };
  }
  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true, message: "database reachable" };
  } catch (err) {
    logger.warn({ err }, "database health check failed");
    if (options?.failIfUnreachable) {
      return { ok: false, message: "database unreachable" };
    }
    // Legacy health callers treat DB as optional unless failIfUnreachable is set.
    return { ok: true, message: "database unreachable (optional)" };
  }
}
