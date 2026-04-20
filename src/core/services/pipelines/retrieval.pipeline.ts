// src/services/retrieval-pipeline.service.ts
// Architecture: User question → Decompose → [per sub-question: expand ×3 → retrieve ×4 → dedupe]∥ → merge → (synthesis in query.service)
import { traceable } from "langsmith/traceable";
import { retrieve, mergeRetrievedChunksDeduped } from "@/core/services/retrieval/retriever.service";
import { expandQueryVariants } from "@/ai/chains/query-expansion.service";
import { decomposeQuery } from "@/ai/chains/query-decomposer.service";
import type { RetrievedChunk } from "@/core/types/retrieval.interface";
import type { RetrievalOptions } from "@/core/types/retrieval.interface";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/config/tracing";

export type RetrieveFn = (
  query: string,
  options: RetrievalOptions,
) => Promise<RetrievedChunk[]>;

export interface RetrievalPipelineResult {
  chunks: RetrievedChunk[];
  subQuestions: string[];
  isCompound: boolean;
}

export interface RunRetrievalPipelineOptions {
  /** Defaults to hybrid `retrieve` from retriever.service; inject for tracing (e.g. tracedRetrieve). */
  retrieveFn?: RetrieveFn;
}

async function runRetrievalPipelineInner(
  question: string,
  retrievalOpts: RetrievalOptions & { topK?: number },
  options: RunRetrievalPipelineOptions = {},
): Promise<RetrievalPipelineResult> {
  const retrieveFn = options.retrieveFn ?? retrieve;
  const topK = retrievalOpts.topK ?? 8;
  const perQueryTopK = Math.max(4, Math.min(12, topK));

  const { subQuestions, isCompound } = await decomposeQuery(question.trim());

  logger.debug(
    { isCompound, branches: subQuestions.length },
    "Retrieval pipeline: decomposed",
  );

  // Parallel branches (one per sub-question): expand → N parallel retrievals → dedupe within branch
  const branchChunkLists: RetrievedChunk[][] = await Promise.all(
    subQuestions.map(async (subQ) => {
      const variants = await expandQueryVariants(subQ);
      const queries = variants.length > 0 ? [subQ, ...variants] : [subQ];

      logger.debug(
        { subQ: subQ.slice(0, 80), queryCount: queries.length },
        "Retrieval pipeline: sub-question branch",
      );

      const lists = await Promise.all(
        queries.map((q) =>
          retrieveFn(q, { ...retrievalOpts, topK: perQueryTopK }),
        ),
      );

      return mergeRetrievedChunksDeduped(lists, topK);
    }),
  );

  // Merge across branches; same point id keeps best score
  const chunks = mergeRetrievedChunksDeduped(branchChunkLists, topK);

  logger.debug(
    { merged: chunks.length, topK },
    "Retrieval pipeline: merged branches",
  );

  return { chunks, subQuestions, isCompound };
}

export const runRetrievalPipeline = isTracingEnabled()
  ? traceable(runRetrievalPipelineInner, {
      name: "RetrievalPipeline",
      run_type: "chain",
      tags: ["query", "decompose", "expand", "retrieve", "dedupe"],
      metadata: {
        steps: ["decompose", "expand-per-sub", "retrieve-parallel", "merge"],
      },
    })
  : runRetrievalPipelineInner;

/** Alias — same as runRetrievalPipeline */
export const retrieveWithExpansion = runRetrievalPipeline;
