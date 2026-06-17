import { traceable } from "langsmith/traceable";
import { RAG_FALLBACK_POLICY, type AnswerSourceType } from "@config/rag-fallback.policy";
import { config } from "@config/env";
import { RetrievedChunk } from "@/core/types/retrieval.interface";
import {
  tavilySearchTool,
  buildWebSearchContext,
  isTavilySearchAvailable,
} from "@/ai/tools/tavily-search.tool";
import type { WebSearchResult } from "@/ai/tools/web-search.types";
import {
  isQuestionRelatedToSources,
  buildUnrelatedSourceAnswer,
} from "@/ai/agents/source-relevance.service";
import type { SourceScopeContext } from "@/core/services/retrieval/source-scope.service";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/config/tracing";

export interface FallbackEvaluation {
  shouldFallback: boolean;
  confidence: number;
  reason: "no_documents" | "low_confidence" | "sufficient_documents" | "fallback_disabled";
}

export interface WebFallbackResult {
  sourceType: AnswerSourceType;
  fallbackUsed: boolean;
  fallbackNotification: string | null;
  confidence: number;
  context: string;
  webResults: WebSearchResult[];
  /** Mapped to QueryResult.sources when sourceType is web */
  webSources: Array<{
    index: number;
    url: string;
    section: string | null;
    excerpt: string;
    score: number;
    sourceKind: "web";
  }>;
}

export type WebFallbackOutcome =
  | { kind: "web"; data: WebFallbackResult }
  | { kind: "skipped_unrelated"; message: string; reason: string }
  | { kind: "failed" };

export function computeDocumentConfidence(
  chunks: RetrievedChunk[],
  finalChunks: RetrievedChunk[],
): number {
  const pool = finalChunks.length > 0 ? finalChunks : chunks;
  if (pool.length === 0) return 0;

  const top = pool[0];
  const relevanceScore = (top as RetrievedChunk & { relevanceScore?: number }).relevanceScore;
  if (relevanceScore !== undefined) {
    return Math.min(1, Math.max(0, relevanceScore / 10));
  }
  return Math.min(1, Math.max(0, top.score ?? 0));
}

export function evaluateRetrievalForFallback(
  chunks: RetrievedChunk[],
  finalChunks: RetrievedChunk[],
): FallbackEvaluation {
  const fallbackEnabled =
    config.RAG_FALLBACK_ENABLED && RAG_FALLBACK_POLICY.enabled && isTavilySearchAvailable();

  if (!fallbackEnabled) {
    return {
      shouldFallback: false,
      confidence: computeDocumentConfidence(chunks, finalChunks),
      reason: "fallback_disabled",
    };
  }

  const confidence = computeDocumentConfidence(chunks, finalChunks);
  const hasDocuments = (finalChunks.length > 0 ? finalChunks : chunks).length > 0;

  if (!hasDocuments) {
    return { shouldFallback: true, confidence: 0, reason: "no_documents" };
  }

  if (confidence < RAG_FALLBACK_POLICY.confidenceThreshold) {
    return { shouldFallback: true, confidence, reason: "low_confidence" };
  }

  return { shouldFallback: false, confidence, reason: "sufficient_documents" };
}

function mapWebResultsToSources(
  results: WebSearchResult[],
): WebFallbackResult["webSources"] {
  return results.map((r, i) => ({
    index: i + 1,
    url: r.url,
    section: r.title,
    excerpt:
      r.snippet.length > 300 ? `${r.snippet.slice(0, 300)}...` : r.snippet,
    score: Math.round((1 - i * 0.08) * 1000) / 1000,
    sourceKind: "web" as const,
  }));
}

async function executeWebFallbackInner(
  question: string,
  evaluation: FallbackEvaluation,
  sourceScope: SourceScopeContext,
): Promise<WebFallbackOutcome> {
  if (!evaluation.shouldFallback) {
    return { kind: "failed" };
  }

  const relevance = await isQuestionRelatedToSources(question, sourceScope);
  if (!relevance.isRelated) {
    logger.info(
      { reason: relevance.reason, method: relevance.method },
      "RAG fallback: skipped Tavily — question unrelated to indexed sources",
    );
    return {
      kind: "skipped_unrelated",
      message: buildUnrelatedSourceAnswer(sourceScope.scopeLabel),
      reason: relevance.reason,
    };
  }

  logger.info(
    { reason: evaluation.reason, confidence: evaluation.confidence, relevance: relevance.reason },
    "RAG fallback: triggering Tavily web search tool",
  );

  try {
    const searchOutput = await tavilySearchTool({
      query: question,
      numResults: config.TAVILY_MAX_RESULTS,
    });

    if (searchOutput.resultCount === 0) {
      return {
        kind: "web",
        data: {
          sourceType: "web",
          fallbackUsed: true,
          fallbackNotification: RAG_FALLBACK_POLICY.userNotification.show
            ? RAG_FALLBACK_POLICY.userNotification.message
            : null,
          confidence: 0,
          context: buildWebSearchContext([]),
          webResults: [],
          webSources: [],
        },
      };
    }

    const context =
      "The following information comes from trusted web sources (not the user's uploaded documents).\n\n" +
      buildWebSearchContext(searchOutput.results);

    return {
      kind: "web",
      data: {
        sourceType: "web",
        fallbackUsed: true,
        fallbackNotification: RAG_FALLBACK_POLICY.userNotification.show
          ? RAG_FALLBACK_POLICY.userNotification.message
          : null,
        confidence: Math.min(0.85, 0.5 + searchOutput.resultCount * 0.07),
        context,
        webResults: searchOutput.results,
        webSources: mapWebResultsToSources(searchOutput.results),
      },
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "RAG fallback: web search tool failed",
    );
    return { kind: "failed" };
  }
}

const tracedExecuteWebFallback = traceable(executeWebFallbackInner, {
  name: "RagFallbackOrchestrator",
  run_type: "chain",
  tags: ["rag-fallback", "tool-calling", "tavily"],
});

export async function executeWebFallback(
  question: string,
  evaluation: FallbackEvaluation,
  sourceScope: SourceScopeContext,
): Promise<WebFallbackOutcome> {
  return isTracingEnabled()
    ? tracedExecuteWebFallback(question, evaluation, sourceScope)
    : executeWebFallbackInner(question, evaluation, sourceScope);
}

export function buildUnverifiedAnswer(): string {
  return (
    "I could not find reliable information in your uploaded documents or from trusted web sources " +
    "to answer this question. The answer could not be verified."
  );
}

export { buildUnrelatedSourceAnswer };
