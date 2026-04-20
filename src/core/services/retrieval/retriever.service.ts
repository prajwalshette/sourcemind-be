// src/services/retriever.service.ts
// v3: Hybrid (dense + BM25 + RRF), question-boost scoring, rich metadata filters.
import { traceable } from "langsmith/traceable";
import { embedQuery } from "@/ai/providers/embedder.service";
import { vectorSearch, hybridSearch } from "@/infrastructure/vectordb/qdrant.client";
import {
  SearchResult,
  SearchFilter,
} from "@/core/types/search.interface";
import { logger } from "@utils/logger";
import { Chunk } from "@generated/prisma";
import { prisma } from "@/infrastructure/database/prisma.client";
import { isTracingEnabled } from "@/config/tracing";

import {
  RetrievalOptions,
  RetrievedChunk,
} from "@/core/types/retrieval.interface";

// ─── TRACED EMBED QUERY ──────────────────────────────────────────────────────
const tracedEmbedQuery = traceable(
  async (query: string) => {
    const vector = await embedQuery(query);
    return { vector, dimensions: vector.length };
  },
  { name: "QueryEmbedder", run_type: "embedding", tags: ["query", "embedding"] },
);

// ─── TRACED HYBRID SEARCH ────────────────────────────────────────────────────
const tracedHybridSearch = traceable(
  async (
    queryVector: number[],
    queryText: string,
    filter: SearchFilter,
    topK: number,
  ) => {
    const results = await hybridSearch(queryVector, queryText, filter, topK);
    return {
      resultCount: results.length,
      topScore: results[0]?.score ?? 0,
      results,
    };
  },
  { name: "HybridSearch", run_type: "retriever", tags: ["query", "hybrid"] },
);

// ─── TRACED MMR ───────────────────────────────────────────────────────────────
const tracedMMR = traceable(
  async (candidates: SearchResult[], topK: number, lambda: number) => {
    const selected = maxMarginalRelevance(candidates, topK, lambda);
    return {
      inputCount: candidates.length,
      outputCount: selected.length,
      results: selected,
    };
  },
  { name: "MMRReranker", run_type: "tool", tags: ["query", "reranking", "mmr"] },
);

// ─── MAIN RETRIEVE ───────────────────────────────────────────────────────────
export async function retrieve(
  query: string,
  options: RetrievalOptions = {},
): Promise<RetrievedChunk[]> {
  const {
    topK = 5,
    mmrLambda = 0.7,
    // Hybrid mode uses RRF fusion scores (0.01–0.03 range), not cosine similarity.
    // Default to 0 so we never silently discard candidates. Non-hybrid callers can
    // set an explicit threshold if they want quality gating.
    scoreThreshold = 0,
    documentId,
    siteKey,
    useHybrid = true,
    domain,
    sourceType,
    tags,
    createdAfter,
    createdBefore,
  } = options;

  const searchK = Math.max(topK * 4, 20);
  const filter: SearchFilter = {
    documentId,
    siteKey,
    domain,
    sourceType,
    tags,
    createdAfter,
    createdBefore,
  };

  let queryVector: number[];
  if (isTracingEnabled()) {
    const r = await tracedEmbedQuery(query);
    queryVector = r.vector;
  } else {
    queryVector = await embedQuery(query);
  }

  let candidates: SearchResult[];
  if (useHybrid) {
    if (isTracingEnabled()) {
      const r = await tracedHybridSearch(queryVector, query, filter, searchK);
      candidates = r.results;
      logger.debug(
        `[LangSmith] Hybrid → ${r.resultCount} candidates, topScore=${r.topScore.toFixed(3)}`,
      );
    } else {
      candidates = await hybridSearch(queryVector, query, filter, searchK);
    }
  } else {
    candidates = await vectorSearch(queryVector, filter, searchK);
  }

  if (candidates.length === 0) {
    logger.warn("No results found for query");
    return [];
  }

  const boosted = applyQuestionBoost(query, candidates);
  const mmrTopK = Math.min(topK * 2, boosted.length);
  let mmrResults: SearchResult[];
  if (isTracingEnabled()) {
    const r = await tracedMMR(boosted, mmrTopK, mmrLambda);
    mmrResults = r.results;
    logger.debug(`[LangSmith] MMR → ${r.outputCount} diverse chunks`);
  } else {
    mmrResults = maxMarginalRelevance(boosted, mmrTopK, mmrLambda);
  }

  const final = mmrResults.filter((r) => r.score >= scoreThreshold).slice(0, topK);
  logger.debug(
    `Retrieved ${final.length} chunks (hybrid=${useHybrid}, candidates=${candidates.length})`,
  );

  const upgraded = await upgradeToParentContext(final);
  return upgraded.map((r) => {
    const questions = (r.metadata.hypothetical_questions as string[] | null) ?? [];
    const matched = findBestMatchingQuestion(query, questions);
    return {
      pointId: r.id,
      text: r.text,
      score: r.score,
      metadata: r.metadata,
      sourceUrl: (r.metadata.url as string) || "",
      section: (r.metadata.section as string | null) ?? null,
      hypotheticalQuestions: questions,
      matchedQuestion: matched,
    };
  });
}

// ─── Parent-Child Upgrade ───────────────────────────────────────────────────
// Child chunks are matched in Qdrant; if a child has parentText in Postgres,
// we replace the chunk.text so the LLM gets the full parent section.
async function upgradeToParentContext(
  results: SearchResult[],
): Promise<SearchResult[]> {
  const pointIds = results.map((r) => r.id).filter(Boolean);
  if (pointIds.length === 0) return results;

  const dbChunks = await prisma.chunk.findMany({
    where: { qdrantPointId: { in: pointIds } },
    select: { qdrantPointId: true, parentText: true },
  });

  const parentMap = new Map<string, string>(
    dbChunks
      .filter((c: Pick<Chunk, 'parentText'>) => !!c.parentText)
      .map((c: Pick<Chunk, 'qdrantPointId' | 'parentText'>) => [
        c.qdrantPointId,
        c.parentText as string,
      ]),
  );

  if (parentMap.size === 0) return results;

  logger.debug(
    `Parent-child upgrade: ${parentMap.size}/${results.length} chunks upgraded to parent context`,
  );

  return results.map((r) => {
    const parentText = parentMap.get(r.id);
    if (!parentText) return r;
    return {
      ...r,
      text: parentText,
    } as SearchResult;
  });
}

// ─── QUESTION BOOST (v3) ─────────────────────────────────────────────────────
function applyQuestionBoost(
  query: string,
  candidates: SearchResult[],
): SearchResult[] {
  const queryWords = new Set(
    query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  return candidates.map((c) => {
    const questions = (c.metadata.hypothetical_questions as string[] | null) ?? [];
    if (questions.length === 0) return c;
    let bestOverlap = 0;
    for (const q of questions) {
      const qWords = new Set(
        q
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );
      const inter = [...queryWords].filter((w) => qWords.has(w)).length;
      const union = new Set([...queryWords, ...qWords]).size;
      const overlap = union > 0 ? inter / union : 0;
      if (overlap > bestOverlap) bestOverlap = overlap;
    }
    const boost = 1 + bestOverlap * 0.2;
    return { ...c, score: Math.min(1.0, c.score * boost) };
  });
}

function findBestMatchingQuestion(
  query: string,
  questions: string[],
): string | undefined {
  if (questions.length === 0) return undefined;
  const qWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  );
  let best = { q: "", score: 0 };
  for (const question of questions) {
    const hqWords = new Set(
      question.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    );
    const inter = [...qWords].filter((w) => hqWords.has(w)).length;
    const union = new Set([...qWords, ...hqWords]).size;
    const score = union > 0 ? inter / union : 0;
    if (score > best.score) best = { q: question, score };
  }
  return best.score > 0.2 ? best.q : undefined;
}

// ─── MMR ────────────────────────────────────────────────────────────────────
function maxMarginalRelevance(
  candidates: SearchResult[],
  topK: number,
  lambda: number,
): SearchResult[] {
  if (candidates.length === 0) return [];
  if (candidates.length <= topK) return candidates;

  const selected: SearchResult[] = [];
  const remaining = [...candidates];

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const relevanceScore = remaining[i].score;
      let maxSim = 0;
      if (selected.length > 0) {
        maxSim = Math.max(
          ...selected.map((s) => textOverlapScore(remaining[i].text, s.text)),
        );
      }
      const score = lambda * relevanceScore - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

// Bigram overlap similarity (fast proxy for semantic similarity)
function textOverlapScore(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).slice(0, 50));
  const bWords = new Set(b.toLowerCase().split(/\s+/).slice(0, 50));
  const intersection = [...aWords].filter((w) => bWords.has(w)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union === 0 ? 0 : intersection / union;
}

export function chunkDedupeKey(c: RetrievedChunk): string {
  if (c.pointId) return c.pointId;
  const doc = String(c.metadata.document_id ?? "");
  const idx = String(c.metadata.chunk_index ?? "");
  const url = c.sourceUrl || "";
  return `${doc}:${idx}:${url}`;
}

/** Merge several retrieval lists; same chunk (by point id or doc+index+url) keeps the best score. */
export function mergeRetrievedChunksDeduped(
  chunkLists: RetrievedChunk[][],
  finalTopK: number,
): RetrievedChunk[] {
  const best = new Map<string, RetrievedChunk>();
  for (const list of chunkLists) {
    for (const c of list) {
      const key = chunkDedupeKey(c);
      const prev = best.get(key);
      if (!prev || (c.score ?? 0) > (prev.score ?? 0)) best.set(key, c);
    }
  }
  return [...best.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, finalTopK);
}

// ─── BUILD CONTEXT STRING ────────────────────────────────────────────────────
export function buildContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, i) => {
      const source = chunk.sourceUrl ? `\nSource: ${chunk.sourceUrl}` : "";
      const section = chunk.section ? `\nSection: ${chunk.section}` : "";
      const mq = chunk.matchedQuestion
        ? `\nMatched question: "${chunk.matchedQuestion}"`
        : "";
      return `<context_chunk id="${i + 1}">${source}${section}${mq}\n\n${chunk.text}\n</context_chunk>`;
    })
    .join("\n\n");
}
