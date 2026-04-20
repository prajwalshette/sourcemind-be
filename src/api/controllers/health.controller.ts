 
import { Request, Response } from "express";
import { checkDatabase } from "@/core/services/analytics/health.service";
import { redis } from "@/infrastructure/database/redis.client";
import { qdrantHealth } from "@/infrastructure/vectordb/qdrant.client";
import { embedDocuments } from "@/ai/providers/embedder.service";
import { config } from "@config/env";

export async function health(_req: Request, res: Response): Promise<void> {
  const checks = await Promise.allSettled([
    checkDatabase(),
    redis.ping().then(() => "ok" as const).catch(() => "fail" as const),
    qdrantHealth().then((ok) => (ok ? "ok" : "fail")),
    // Lightweight HF embedding check (single short text)
    embedDocuments(["health-check"])
      .then(() => "ok" as const)
      .catch(() => "fail" as const),
  ]);

  const [db, redisStatus, qdrant, hfEmbed] = checks.map((r) =>
    r.status === "fulfilled" ? r.value : "fail",
  );

  const allOk = [db, redisStatus, qdrant, hfEmbed].every((s) => s === "ok");

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: { database: db, redis: redisStatus, qdrant, hfEmbed },
    version: process.env.npm_package_version || "3.0.0",
    env: config.NODE_ENV,
    improvements: [
      "Hypothetical Question Generation",
      "Hybrid Retrieval (BM25 + dense + RRF)",
      "Rich Metadata Filters",
      "Hallucination Auditor",
    ],
  });
}
