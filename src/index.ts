import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { disconnectDatabase } from "./modules/database/index.js";
import { ensureUploadDir, cleanupTempUploads } from "./modules/runtime/tempCleanup.js";

async function main(): Promise<void> {
  await ensureUploadDir();
  void cleanupTempUploads();

  const app = createApp();
  const host = process.env.HOST?.trim() || "0.0.0.0";
  const server = app.listen(config.port, host, () => {
    logger.info(
      {
        host,
        port: config.port,
        env: config.nodeEnv,
        group: 8,
        auth: config.requireAuth,
        trustProxy: config.trustProxy,
        maxConcurrentDocuments: config.maxConcurrentDocuments,
        maxPdfPages: config.maxPdfPages,
        database: Boolean(config.databaseUrl),
      },
      "Bank Statement Extraction Service listening",
    );
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceTimer = setTimeout(() => {
      logger.error("forced shutdown after timeout");
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    server.close(() => {
      void (async () => {
        try {
          await cleanupTempUploads({ maxAgeMs: 0 });
          await disconnectDatabase();
        } catch (err) {
          logger.error({ err }, "shutdown cleanup failed");
        }
        process.exit(0);
      })();
    });
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
