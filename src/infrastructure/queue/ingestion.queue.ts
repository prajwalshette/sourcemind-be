import { Queue, Worker, Job } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { redisBullMQ } from "@/infrastructure/database/redis.client";
import { ingestUrl } from "@/core/services/pipelines/ingestion.pipeline";
import { crawlSite } from "@/core/services/ingestion/site-crawler.service";
import { ingestFile } from "@/core/services/ingestion/file-ingestion.service";
import { prisma } from "@/infrastructure/database/prisma.client";
import { normalizeUrl } from "@utils/sanitize";
import { logger } from "@utils/logger";
import { DocumentStatus } from "@generated/prisma";

import { IngestJobData, FileIngestJobData } from "@/core/types/ingestion.interface";

// ─── QUEUE ───────────────────────────────────────────────────────────────────
export const ingestionQueue = new Queue<IngestJobData>("ingestion", {
  connection: redisBullMQ as ConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000, // 5s, 10s, 20s
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

// ─── WORKER ──────────────────────────────────────────────────────────────────
export function startIngestionWorker(): Worker {
  const worker = new Worker<IngestJobData>(
    "ingestion",
    async (job: Job<IngestJobData>) => {
      const { url, documentId, webhookUrl, crawlAllPages, maxPages, uploadedBy } = job.data;

      logger.info(
        `Processing ingestion job ${job.id}: ${url} (crawlAllPages=${crawlAllPages})`,
      );

      try {
        if (crawlAllPages) {
          const siteCrawlResult = await crawlSite(
            url,
            {
              maxPages: maxPages ?? 50,
              concurrency: 5,
              sameDomainOnly: true,
            },
            (pageUrl: string) =>
              ingestUrl(pageUrl, { crawlAllPages: false, siteKey: url, uploadedBy }),
          );

          if (webhookUrl) {
            await notifyWebhook(webhookUrl, {
              event: "site.crawled",
              ...siteCrawlResult,
            }).catch((err) => logger.warn(`Webhook failed: ${err.message}`));
          }

          logger.info(
            {
              url,
              success: siteCrawlResult.successCount,
              failed: siteCrawlResult.failedCount,
            },
            "Site crawl job complete",
          );

          // ── Update tracking document status ──────────────────────────────────
          if (documentId) {
            await prisma.document.update({
              where: { id: documentId },
              data: {
                status: DocumentStatus.INDEXED,
                chunkCount: siteCrawlResult.totalChunks,
                tokenCount: siteCrawlResult.totalTokens,
                indexedAt: new Date(),
                url: normalizeUrl(url), // ensure tracking doc URL is normalized too
              },
            });
          }

          return siteCrawlResult;
        }

        const result = await ingestUrl(url, { crawlAllPages, maxPages, uploadedBy });

        if (webhookUrl) {
          await notifyWebhook(webhookUrl, {
            event: "document.indexed",
            ...result,
          }).catch((err) => logger.warn(`Webhook failed: ${err.message}`));
        }

        return result;
      } catch (err) {
        const error = err as Error;
        logger.error({ error: error.message }, `Ingestion job failed: ${url}`);

        if (webhookUrl) {
          await notifyWebhook(webhookUrl, {
            event: crawlAllPages ? "site.crawl.failed" : "document.failed",
            documentId: documentId,
            error: error.message,
          }).catch(() => {});
        }

        throw err; // BullMQ will retry
      }
    },
    {
      connection: redisBullMQ as ConnectionOptions,
      concurrency: 3, // process 3 URLs simultaneously
      limiter: {
        max: 10,
        duration: 60_000, // max 10 jobs per minute
      },
    },
  );

  worker.on("completed", (job) => {
    logger.info(`✅ Ingestion completed: ${job.data.url}`);
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { error: err.message },
      `❌ Ingestion failed: ${job?.data.url}`,
    );
  });

  worker.on("error", (err) => {
    logger.error({ error: err.message }, "Worker error:");
  });

  logger.info("✅ Ingestion worker started");
  return worker;
}

// ─── ADD JOB ─────────────────────────────────────────────────────────────────
export async function enqueueIngestion(data: IngestJobData): Promise<string> {
  const job = await ingestionQueue.add("ingest", data, {
    jobId: data.documentId, // idempotent by documentId
    priority: 1,
  });
  return job.id!;
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
async function notifyWebhook(url: string, payload: object): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}

// ─── FILE INGESTION QUEUE ────────────────────────────────────────────────────
export const fileIngestionQueue = new Queue<FileIngestJobData>("file-ingestion", {
  connection: redisBullMQ as ConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  },
});

export function startFileIngestionWorker(): Worker {
  const worker = new Worker<FileIngestJobData>(
    "file-ingestion",
    async (job: Job<FileIngestJobData>) => {
      const { documentId, bufferBase64, mimeType, fileName } = job.data;
      logger.info(`[FileQueue] Processing ${fileName} (doc=${documentId})`);

      // Deserialise the base64-encoded buffer stored in Redis
      const buffer = Buffer.from(bufferBase64, "base64");

      return ingestFile(documentId, buffer, mimeType, fileName);
    },
    {
      connection: redisBullMQ as ConnectionOptions,
      concurrency: 2,
    },
  );

  worker.on("completed", (job) =>
    logger.info(`✅ File ingestion completed: ${job.data.fileName}`),
  );
  worker.on("failed", (job, err) =>
    logger.error({ error: err.message }, `❌ File ingestion failed: ${job?.data.fileName}`),
  );
  worker.on("error", (err) =>
    logger.error({ error: err.message }, "File worker error:"),
  );

  logger.info("✅ File ingestion worker started");
  return worker;
}

export async function enqueueFileIngestion(
  data: FileIngestJobData,
): Promise<string> {
  const job = await fileIngestionQueue.add("ingest-file", data, {
    jobId: `file-${data.documentId}`,
    priority: 1,
  });
  return job.id!;
}
