import { Request, Response, NextFunction } from "express";
import {
  query as ragQuery,
  ragQuerySse,
  getQueryHistory,
  getUsageStats,
  getDashboardStats,
} from "@/core/services/pipelines/query.pipeline";
import { querySchema, historySchema } from "@/api/validators/query.schema";
import { QueryDto, QueryHistoryDto } from "@/api/validators/query.dto";
import { logger } from "@utils/logger";

export async function queryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body: QueryDto = querySchema.parse(req.body);

    const result = await ragQuery(body.question, {
      documentId: body.documentId,
      sessionId: body.sessionId,
      siteKey: body.siteKey,
      topK: body.topK,
      useCache: body.useCache,
      skipIntelligence: body.skipIntelligence,
      useHybrid: body.useHybrid,
      skipAudit: body.skipAudit,
      skipQueryExpansion: body.skipQueryExpansion,
      domain: body.domain,
      sourceType: body.sourceType,
      tags: body.tags,
      createdAfter: body.createdAfter,
      createdBefore: body.createdBefore,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

function sseWrite(res: Response, event: string, payload: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** POST /query/stream — same body as /query; responds with SSE (meta, token, done). */
export async function queryStreamHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body: QueryDto = querySchema.parse(req.body);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    let clientGone = false;
    req.on("close", () => {
      clientGone = true;
    });

    for await (const chunk of ragQuerySse(body.question, {
      documentId: body.documentId,
      sessionId: body.sessionId,
      siteKey: body.siteKey,
      topK: body.topK,
      useCache: body.useCache,
      skipIntelligence: body.skipIntelligence,
      useHybrid: body.useHybrid,
      skipAudit: body.skipAudit,
      skipQueryExpansion: body.skipQueryExpansion,
      domain: body.domain,
      sourceType: body.sourceType,
      tags: body.tags,
      createdAfter: body.createdAfter,
      createdBefore: body.createdBefore,
    })) {
      if (clientGone) break;
      if (chunk.type === "meta") {
        sseWrite(res, "meta", chunk.data);
      } else if (chunk.type === "token") {
        sseWrite(res, "token", chunk.data);
      } else {
        sseWrite(res, "done", { success: true, data: chunk.data });
      }
    }

    if (!clientGone) res.end();
  } catch (err) {
    try {
      if (!res.headersSent) {
        next(err);
      } else {
        logger.error(
          { err: (err as Error)?.message ?? String(err) },
          "Query stream failed",
        );
        sseWrite(res, "error", {
          message: (err as Error).message ?? "Stream failed",
        });
        res.end();
      }
    } catch {
      next(err);
    }
  }
}

export async function queryHistory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { page, limit, documentId }: QueryHistoryDto = historySchema.parse(
      req.query,
    );

    const { logs, total } = await getQueryHistory(page, limit, documentId);

    res.json({
      success: true,
      data: logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

export async function getUsage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getUsageStats();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function dashboardStatsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getDashboardStats();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
