// src/services/query.service.ts
// Full RAG pipeline: hybrid retrieval, intelligence, generation, hallucination auditor (v3).
import { traceable } from "langsmith/traceable";
import { prisma } from "@utils/prisma";
import { retrieve, buildContext } from "@services/retriever.service";
import {
  runRetrievalPipeline,
  type RetrieveFn,
} from "@services/retrieval-pipeline.service";
import { RetrievedChunk } from "@interfaces/retrieval.interface";
import { generateAnswer, streamAnswerEvents } from "@services/generator.service";
import {
  buildRefinedContext,
  refineChunks,
} from "@services/intelligence.service";
import {
  auditAnswer,
  buildAuditedAnswer,
  type AuditResult,
} from "@services/auditor.service";
import { getCache, setCache } from "@utils/redis";
import { createCacheKey } from "@utils/sanitize";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/tracing/langsmith";
import { config } from "@config/env";
import { getHistoryForPrompt, appendTurn } from "@services/chat-session.service";

import {
  GenerationResult,
  QueryOptions,
  QueryResult,
} from "@interfaces/query.interface";

// ─── TRACED: RETRIEVAL STEP ──────────────────────────────────────────────────
const tracedRetrieve = traceable(
  async (question: string, options: Parameters<typeof retrieve>[1]) => {
    const chunks = await retrieve(question, options);
    return {
      chunkCount: chunks.length,
      topScore: chunks[0]?.score ?? 0,
      bottomScore: chunks[chunks.length - 1]?.score ?? 0,
      sources: chunks.map((c) => c.sourceUrl),
      chunks,
    };
  },
  { name: "HybridRetriever", run_type: "retriever", tags: ["query", "retrieval", "hybrid", "mmr"] },
);

// ─── TRACED: CONTEXT BUILDER ─────────────────────────────────────────────────
const tracedBuildContext = traceable(
  async (chunks: RetrievedChunk[]) => {
    const context = buildContext(chunks);
    return {
      contextLength: context.length,
      chunkCount: chunks.length,
      context,
    };
  },
  {
    name: "ContextBuilder",
    run_type: "tool",
    tags: ["query", "context"],
  },
);

// ─── TRACED: LLM GENERATION ──────────────────────────────────────────────────
const tracedGenerate = traceable(
  async (question: string, context: string) => generateAnswer(question, context),
  { name: "LLMGenerator", run_type: "llm", tags: ["query", "generation"] },
);

// ─── TRACED: HALLUCINATION AUDITOR ───────────────────────────────────────────
const tracedAudit = traceable(
  async (question: string, answer: string, context: string) =>
    auditAnswer(question, answer, context),
  { name: "HallucinationAuditor", run_type: "chain", tags: ["audit", "validation"] },
);

// ─── TRACED: INTELLIGENCE LAYER ───────────────────────────────────────────────
const tracedIntelligence = traceable(
  async (question: string, rawChunks: RetrievedChunk[]) => {
    return refineChunks(question, rawChunks);
  },
  {
    name: "IntelligenceLayer",
    run_type: "chain",
    tags: ["intelligence", "filter", "rerank", "compress"],
  },
);

function defaultAuditResult(): QueryResult["audit"] {
  return {
    passed: true,
    groundednessScore: -1,
    completenessScore: -1,
    confidence: "skip",
    hallucinations: [],
    auditorUsed: false,
  };
}

function mapChunksToSources(finalChunks: RetrievedChunk[]): QueryResult["sources"] {
  return (finalChunks as any[]).map((c, i) => ({
    index: i + 1,
    url: c.sourceUrl ?? "",
    section: c.section ?? null,
    excerpt:
      (c.text && String(c.text).slice(0, 300)) + (c.text?.length > 300 ? "..." : ""),
    score: Math.round((c.score ?? 0) * 1000) / 1000,
    relevanceScore:
      c.relevanceScore !== undefined
        ? Math.round(c.relevanceScore * 10) / 10
        : undefined,
    matchedQuestion: (c as RetrievedChunk).matchedQuestion,
  }));
}

type PipelineReady = {
  question: string;
  context: string;
  finalChunks: RetrievedChunk[];
  chunks: RetrievedChunk[];
  retrievalMeta?: QueryResult["retrieval"];
  intelligenceStats: NonNullable<QueryResult["intelligence"]>;
  startTime: number;
  cacheKey: string;
  useCache: boolean;
  documentId?: string;
  sessionId?: string;
  skipAudit: boolean;
  useHybrid: boolean;
};

type PipelinePhase =
  | { outcome: "result"; result: QueryResult }
  | { outcome: "ready"; ready: PipelineReady };

async function runPipelineBeforeLlm(
  question: string,
  options: QueryOptions,
  skipCacheRead: boolean,
): Promise<PipelinePhase> {
  const {
    documentId,
    sessionId,
    siteKey,
    topK = 8,
    useCache = true,
    skipIntelligence = false,
    useHybrid = true,
    skipAudit = false,
    domain,
    sourceType,
    tags,
    createdAfter,
    createdBefore,
    skipQueryExpansion = false,
  } = options;
  const startTime = Date.now();

  const cacheKey = `query:${createCacheKey(documentId ?? siteKey ?? "", question)}`;

  if (!skipCacheRead && useCache) {
    const cached = await getCache<QueryResult>(cacheKey);
    if (cached) {
      logger.debug(`Cache hit for query: ${question.slice(0, 50)}`);
      const cachedResult: QueryResult = {
        ...cached,
        sources: Array.isArray(cached.sources)
          ? cached.sources.map((s, i) => ({ ...s, index: (s as any).index ?? i + 1 }))
          : [],
        audit: cached.audit ?? defaultAuditResult(),
        fromCache: true,
        latencyMs: Date.now() - startTime,
      };
      await logQuery(question, documentId ?? null, cachedResult, true);
      return { outcome: "result", result: cachedResult };
    }
  }

  if (documentId && !siteKey) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId },
      select: { status: true },
    });

    if (!doc) throw new Error(`Document not found: ${documentId}`);
    if (doc.status !== "INDEXED") {
      throw new Error(`Document not ready. Status: ${doc.status}`);
    }
  }

  const retrievalOpts = {
    topK,
    mmrLambda: 0.7,
    scoreThreshold: useHybrid ? 0 : 0.3,
    documentId,
    siteKey,
    useHybrid,
    domain,
    sourceType,
    tags,
    createdAfter,
    createdBefore,
  };
  let chunks: RetrievedChunk[];
  let retrievalMeta: QueryResult["retrieval"];

  const useQueryExpansion = !skipQueryExpansion && !!config.GEMINI_API_KEY;

  const runSingleRetrieve = async (): Promise<RetrievedChunk[]> => {
    if (isTracingEnabled()) {
      const result = await tracedRetrieve(question, retrievalOpts);
      logger.debug(
        `[LangSmith] Retrieved ${result.chunkCount} chunks, topScore=${result.topScore.toFixed(3)}`,
      );
      return result.chunks;
    }
    return retrieve(question, retrievalOpts);
  };

  const tracedRetrieveFn: RetrieveFn = async (q, opts) =>
    isTracingEnabled() ? (await tracedRetrieve(q, opts)).chunks : retrieve(q, opts);

  if (useQueryExpansion) {
    const pipeline = await runRetrievalPipeline(question, retrievalOpts, {
      retrieveFn: tracedRetrieveFn,
    });
    chunks = pipeline.chunks;
    retrievalMeta = {
      subQuestions: pipeline.subQuestions,
      isCompound: pipeline.isCompound,
    };
  } else {
    chunks = await runSingleRetrieve();
  }

  if (chunks.length === 0) {
    const noResult: QueryResult = {
      answer:
        "I could not find relevant information in the indexed documents to answer your question.",
      sources: [],
      model: "n/a",
      confidence: 0,
      fromCache: false,
      latencyMs: Date.now() - startTime,
      promptTokens: 0,
      completionTokens: 0,
      audit: defaultAuditResult(),
    };
    return { outcome: "result", result: noResult };
  }

  const useIntelligence = !skipIntelligence && !!config.GEMINI_API_KEY;
  let context: string;
  let finalChunks: RetrievedChunk[] = chunks;
  let intelligenceStats: NonNullable<QueryResult["intelligence"]> = {
    used: false,
    chunksBeforeFilter: chunks.length,
    chunksAfterFilter: chunks.length,
    droppedChunks: 0,
    compressionRatio: 0,
    processingMs: 0,
  };

  const compoundSynthesisHint =
    retrievalMeta?.isCompound && retrievalMeta.subQuestions.length > 1
      ? "The user asked several things at once. Answer each part clearly and cite sources.\n\n" +
        retrievalMeta.subQuestions.map((s, i) => `(${i + 1}) ${s}`).join("\n") +
        "\n\n---\n\n"
      : "";

  if (useIntelligence) {
    logger.debug(`Intelligence Layer: refining ${chunks.length} chunks...`);
    const intelligenceResult = isTracingEnabled()
      ? await tracedIntelligence(question, chunks)
      : await refineChunks(question, chunks);

    finalChunks = intelligenceResult.refinedChunks as unknown as RetrievedChunk[];
    context = compoundSynthesisHint + buildRefinedContext(intelligenceResult);

    intelligenceStats = {
      used: intelligenceResult.intelligenceUsed,
      chunksBeforeFilter: chunks.length,
      chunksAfterFilter: intelligenceResult.refinedChunks.length,
      droppedChunks: intelligenceResult.droppedChunks,
      compressionRatio: intelligenceResult.compressionRatio,
      processingMs: intelligenceResult.processingMs,
    };
  } else {
    if (isTracingEnabled()) {
      const result = await tracedBuildContext(chunks);
      context = compoundSynthesisHint + result.context;
    } else {
      context = compoundSynthesisHint + buildContext(chunks);
    }
  }

  if (sessionId) {
    const history = await getHistoryForPrompt(sessionId);
    if (history) context = history + context;
  }

  return {
    outcome: "ready",
    ready: {
      question,
      context,
      finalChunks,
      chunks,
      retrievalMeta,
      intelligenceStats,
      startTime,
      cacheKey,
      useCache,
      documentId,
      sessionId,
      skipAudit,
      useHybrid,
    },
  };
}

function finalizePipelineResult(
  ready: PipelineReady,
  generated: GenerationResult,
  auditResult: AuditResult,
): QueryResult {
  const { finalChunks, chunks, retrievalMeta, intelligenceStats, startTime } = ready;
  return {
    answer: generated.answer,
    sources: mapChunksToSources(finalChunks),
    model: generated.model,
    confidence:
      finalChunks[0] && (finalChunks[0] as any).relevanceScore
        ? (finalChunks[0] as any).relevanceScore / 10
        : chunks[0]?.score || 0,
    fromCache: false,
    latencyMs: Date.now() - startTime,
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
    intelligence: intelligenceStats,
    audit: {
      passed: auditResult.passed,
      groundednessScore: auditResult.groundednessScore,
      completenessScore: auditResult.completenessScore,
      confidence: auditResult.confidence,
      hallucinations: auditResult.hallucinations,
      auditorUsed: auditResult.auditorUsed,
    },
    ...(retrievalMeta ? { retrieval: retrievalMeta } : {}),
  };
}

// ─── MAIN RAG CHAIN ──────────────────────────────────────────────────────────
export const query = traceable(
  async (
    question: string,
    options: QueryOptions = {},
  ): Promise<QueryResult> => {
    const phase = await runPipelineBeforeLlm(question, options, false);
    if (phase.outcome === "result") return phase.result;

    const r = phase.ready;

    let generated: GenerationResult;
    if (isTracingEnabled()) {
      generated = await tracedGenerate(r.question, r.context);
      logger.debug(`[LangSmith] Generated answer with model=${generated.model}`);
    } else {
      generated = await generateAnswer(r.question, r.context);
    }

    let auditResult: AuditResult;
    if (!r.skipAudit) {
      auditResult = isTracingEnabled()
        ? await tracedAudit(r.question, generated.answer, r.context)
        : await auditAnswer(r.question, generated.answer, r.context);
      const audited = buildAuditedAnswer(generated, auditResult);
      if (auditResult.auditorUsed && !auditResult.passed) {
        generated = { ...generated, answer: audited.answer };
        logger.warn(
          {
            groundedness: auditResult.groundednessScore,
            hallucinations: auditResult.hallucinations?.length ?? 0,
          },
          `Hallucination detected: groundedness=${auditResult.groundednessScore}/10`,
        );
      }
    } else {
      auditResult = {
        passed: true,
        groundednessScore: -1,
        completenessScore: -1,
        confidence: "skip",
        hallucinations: [],
        auditMs: 0,
        auditorUsed: false,
      };
    }

    const result = finalizePipelineResult(r, generated, auditResult);

    if (r.useCache) await setCache(r.cacheKey, result, 3600);
    const queryLogId = await logQuery(r.question, r.documentId ?? null, result, false);
    if (r.sessionId && queryLogId) {
      await appendTurn(r.sessionId, queryLogId, r.question, result.answer).catch((err) =>
        logger.warn({ err }, "appendTurn failed — session history may be incomplete"),
      );
    }

    logger.info(
      `Query answered in ${result.latencyMs}ms (model=${result.model}, ` +
        `hybrid=${r.useHybrid}, intelligence=${r.intelligenceStats.used}, ` +
        `chunks=${r.intelligenceStats.chunksAfterFilter}/${r.intelligenceStats.chunksBeforeFilter}, ` +
        `audit=${auditResult.confidence})`,
    );
    return result;
  },
  {
    name: "RAGChain",
    run_type: "chain",
    tags: ["query", "rag", "pipeline", "v3"],
    metadata: { version: "3.0", intelligenceLayer: true, hybridRetrieval: true, auditor: true },
  },
);

/** SSE-friendly async generator: meta (sources) → token chunks → done (full QueryResult). */
export async function* ragQuerySse(
  question: string,
  options: QueryOptions = {},
): AsyncGenerator<
  | { type: "meta"; data: { sources: QueryResult["sources"]; intelligence: NonNullable<QueryResult["intelligence"]>; retrieval?: QueryResult["retrieval"] } }
  | { type: "token"; data: { text: string } }
  | { type: "done"; data: QueryResult }
> {
  const phase = await runPipelineBeforeLlm(question, options, true);
  if (phase.outcome === "result") {
    yield { type: "done", data: phase.result };
    return;
  }

  const r = phase.ready;
  yield {
    type: "meta",
    data: {
      sources: mapChunksToSources(r.finalChunks),
      intelligence: r.intelligenceStats,
      ...(r.retrievalMeta ? { retrieval: r.retrievalMeta } : {}),
    },
  };

  let fullAnswer = "";
  let model = "";
  for await (const ev of streamAnswerEvents(r.question, r.context)) {
    if (ev.type === "model") {
      model = ev.model;
    } else {
      fullAnswer += ev.text;
      yield { type: "token", data: { text: ev.text } };
    }
  }

  let generated: GenerationResult = {
    answer: fullAnswer,
    model: model || "unknown",
    promptTokens: 0,
    completionTokens: 0,
  };

  let auditResult: AuditResult;
  if (!r.skipAudit) {
    auditResult = isTracingEnabled()
      ? await tracedAudit(r.question, generated.answer, r.context)
      : await auditAnswer(r.question, generated.answer, r.context);
    const audited = buildAuditedAnswer(generated, auditResult);
    if (auditResult.auditorUsed && !auditResult.passed) {
      generated = { ...generated, answer: audited.answer };
      logger.warn(
        {
          groundedness: auditResult.groundednessScore,
          hallucinations: auditResult.hallucinations?.length ?? 0,
        },
        `Hallucination detected: groundedness=${auditResult.groundednessScore}/10`,
      );
    }
  } else {
    auditResult = {
      passed: true,
      groundednessScore: -1,
      completenessScore: -1,
      confidence: "skip",
      hallucinations: [],
      auditMs: 0,
      auditorUsed: false,
    };
  }

  const result = finalizePipelineResult(r, generated, auditResult);

  if (r.useCache) await setCache(r.cacheKey, result, 3600);
  const queryLogId = await logQuery(r.question, r.documentId ?? null, result, false);
  if (r.sessionId && queryLogId) {
    await appendTurn(r.sessionId, queryLogId, r.question, result.answer).catch((err) =>
      logger.warn({ err }, "appendTurn failed — session history may be incomplete"),
    );
  }

  logger.info(
    `Stream query answered in ${result.latencyMs}ms (model=${result.model}, ` +
      `hybrid=${r.useHybrid}, intelligence=${r.intelligenceStats.used}, ` +
      `chunks=${r.intelligenceStats.chunksAfterFilter}/${r.intelligenceStats.chunksBeforeFilter}, ` +
      `audit=${auditResult.confidence})`,
  );
  yield { type: "done", data: result };
}

async function logQuery(
  question: string,
  documentId: string | null,
  result: QueryResult,
  fromCache: boolean,
): Promise<string | null> {
  try {
    const log = await prisma.queryLog.create({
      data: {
        documentId,
        question: question.slice(0, 2000),
        answer: result.answer.slice(0, 5000),
        sources: result.sources,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        model: result.model,
        fromCache,
      },
    });

    await prisma.usageLog.create({
      data: {
        action: "QUERY",
        tokensUsed: result.promptTokens + result.completionTokens,
        metadata: { fromCache, model: result.model },
      },
    });
    return log.id;
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "Failed to log query");
    return null;
  }
}

// ─── QUERY HISTORY (DB) ───────────────────────────────────────────────────────
export async function getQueryHistory(
  page: number,
  limit: number,
  documentId?: string,
): Promise<{ logs: unknown[]; total: number }> {
  const skip = (page - 1) * limit;
  const where = documentId ? { documentId } : {};

  const [logs, total] = await Promise.all([
    prisma.queryLog.findMany({
      where,
      select: {
        id: true,
        question: true,
        answer: true,
        sources: true,
        confidence: true,
        latencyMs: true,
        model: true,
        fromCache: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.queryLog.count({ where }),
  ]);

  return { logs, total };
}

// ─── USAGE STATS (DB) ────────────────────────────────────────────────────────
export async function getUsageStats(): Promise<{
  period: string;
  queries: number;
  documents: number;
  tokensUsed: number;
  avgLatencyMs: number;
}> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [queryCount, docCount, totalTokens, avgLatency] = await Promise.all([
    prisma.queryLog.count({ where: { createdAt: { gte: since } } }),
    prisma.document.count({ where: { status: "INDEXED" } }),
    prisma.usageLog.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { tokensUsed: true },
    }),
    prisma.queryLog.aggregate({
      where: { createdAt: { gte: since }, fromCache: false },
      _avg: { latencyMs: true },
    }),
  ]);

  return {
    period: "30d",
    queries: queryCount,
    documents: docCount,
    tokensUsed: totalTokens._sum.tokensUsed || 0,
    avgLatencyMs: Math.round(avgLatency._avg.latencyMs || 0),
  };
}
