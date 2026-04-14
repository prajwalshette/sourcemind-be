import type { Request, Response } from "express";
import app from "@/app";
import { logger } from "@utils/logger";
import { connectDatabase } from "@utils/prisma";
import { connectRedis } from "@utils/redis";
import { ensureCollection } from "@services/qdrant.service";
import { initLangSmith } from "@/tracing/langsmith";

let initPromise: Promise<void> | null = null;

async function initOnce(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      initLangSmith();
      await connectDatabase();

      // In serverless, don't default to localhost services unless explicitly configured.
      if (process.env.REDIS_URL) {
        await connectRedis();
      } else {
        logger.warn("REDIS_URL not set; skipping Redis init");
      }

      if (process.env.QDRANT_URL) {
        await ensureCollection();
      } else {
        logger.warn("QDRANT_URL not set; skipping Qdrant init");
      }

      logger.info("✅ Serverless init complete");
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export default async function handler(req: Request, res: Response) {
  try {
    await initOnce();
    return app(req as any, res as any);
  } catch (err) {
    logger.error({ err }, "Serverless handler failed");
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

