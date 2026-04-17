// src/server.ts
import app from "@/app";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { connectDatabase, disconnectDatabase } from "@utils/prisma";
import { connectRedis, redis, redisBullMQ } from "@utils/redis";
import { ensureCollection } from "@services/qdrant.service";
import { startIngestionWorker, startFileIngestionWorker } from "@jobs/ingestion.queue";
import { initLangSmith } from "@/tracing/langsmith";
import { Worker } from "bullmq";

let ingestionWorker: Worker | null = null;
let fileIngestionWorker: Worker | null = null;

async function startServer(): Promise<void> {
  try {
    logger.info("🚀 Starting URL RAG server...");

    // ── Init LangSmith tracing (must be before any LangChain calls) ──────────
    initLangSmith();

    // ── Connect services ────────────────────────────────────────────────────
    await connectDatabase();
    await connectRedis();

    // ── Ensure Qdrant collection exists ─────────────────────────────────────
    await ensureCollection();
    logger.info("✅ Qdrant collection ready");

    // ── Start job workers ───────────────────────────────────────────────────────
    ingestionWorker     = startIngestionWorker();
    fileIngestionWorker = startFileIngestionWorker();

    // ── Start HTTP server ────────────────────────────────────────────────────
    const server = app.listen(config.PORT, () => {
      logger.info(
        `✅ Server running on port ${config.PORT} [${config.NODE_ENV}]`,
      );
      logger.info(`   API: ${config.APP_URL}/api/v1`);
      logger.info(`   Health: ${config.APP_URL}/api/v1/health`);
      if (config.LANGCHAIN_TRACING_V2 === "true") {
        logger.info(
          `   LangSmith: https://smith.langchain.com/projects → ${config.LANGCHAIN_PROJECT}`,
        );
      }
    });

    // ── Graceful shutdown ────────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received — shutting down gracefully...`);

      server.close(async () => {
        if (ingestionWorker) {
          await ingestionWorker.close();
        }
        if (fileIngestionWorker) {
          await fileIngestionWorker.close();
        }
        logger.info("Workers closed");
        await disconnectDatabase();
        await redis.quit();
        await redisBullMQ.quit();
        logger.info("✅ Graceful shutdown complete");
        process.exit(0);
      });

      // Force exit after 30s
      setTimeout(() => {
        logger.error("Forced shutdown after timeout");
        process.exit(1);
      }, 30_000);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    process.on("unhandledRejection", (reason) => {
      logger.error({ reason }, "Unhandled rejection:");
    });

    process.on("uncaughtException", (err) => {
      logger.error(
        { error: err.message, stack: err.stack },
        "Uncaught exception:",
      );
      process.exit(1);
    });
  } catch (err) {
    logger.error({ error: (err as Error).message }, "Failed to start server:");
    process.exit(1);
  }
}

void startServer();
