// src/services/intelligence.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// RAG Intelligence Layer
//
// Sits BETWEEN vector retrieval and final answer generation.
// Takes raw chunks from Qdrant → runs 3 Gemini-powered refinement steps →
// returns clean, compressed, re-ranked context for the final answer.
//
// PIPELINE:
//   ① Relevance Filter  — score each chunk 0-10, drop < 5
//   ② Smart Re-ranker   — reorder remaining chunks by importance
//   ③ Chunk Compressor  — keep ONLY sentences that answer the question
//
// Each step is batched (one Gemini call per step) and fails open (returns raw).
// ─────────────────────────────────────────────────────────────────────────────

import { traceable } from "langsmith/traceable";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/tracing/langsmith";

import { RetrievedChunk } from "@interfaces/retrieval.interface";

export interface RefinedChunk extends RetrievedChunk {
  relevanceScore: number; // 0-10 from Gemini
  originalRank: number;
  finalRank: number;
  compressed: boolean;
  originalLength: number;
}

export interface IntelligenceResult {
  refinedChunks: RefinedChunk[];
  droppedChunks: number;
  compressionRatio: number; // 0-1
  intelligenceUsed: boolean;
  processingMs: number;
}

async function callGemini(prompt: string, maxTokens = 2048): Promise<string> {
  if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  const model = config.GEMINI_MODEL || "gemini-2.0-flash-exp";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }], role: "user" }],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: maxTokens,
        topP: 1,
        topK: 1,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 429) throw new Error("Gemini rate limited");
  if (!response.ok) {
    throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

async function filterByRelevance(
  question: string,
  chunks: RetrievedChunk[],
): Promise<{ chunk: RetrievedChunk; score: number }[]> {
  const prompt = `You are a relevance scoring engine for a RAG system.

Question: "${question}"

Score each chunk below from 0-10 based on how relevant it is to answering the question:
- 9-10: Directly answers the question with specific facts
- 7-8:  Contains useful supporting information
- 5-6:  Somewhat related, may be useful context
- 3-4:  Tangentially related, provides some background
- 0-2:  Completely irrelevant (navigation, ads, footers, repeated headers)

IMPORTANT: For broad or general questions asking for "all information" or an overview, score generously.
Chunks with ANY useful information about the topic should score at least 4.

Chunks to score:
${chunks.map((c, i) => `CHUNK_${i}: """${c.text.slice(0, 600)}"""`).join("\n\n")}

Return ONLY a JSON array of scores in the same order as the chunks.
Example: [8, 3, 9, 1, 6]
No explanation, no markdown, just the JSON array.`;

  const raw = await callGemini(prompt, 256);
  const clean = raw.replace(/```json|```/g, "").trim();
  const scores = JSON.parse(clean) as number[];

  if (!Array.isArray(scores) || scores.length !== chunks.length) {
    logger.warn(
      "Intelligence: score array length mismatch — using raw scores",
    );
    return chunks.map((c) => ({ chunk: c, score: c.score * 10 }));
  }

  const result = chunks.map((chunk, i) => ({
    chunk,
    score: Math.min(10, Math.max(0, scores[i] || 0)),
  }));

  const kept = result.filter((r) => r.score >= 3).length;
  const dropped = result.filter((r) => r.score < 3).length;
  logger.debug(`Intelligence Filter: ${kept} kept, ${dropped} dropped (< 3)`);

  return result;
}

async function reRankChunks(
  question: string,
  scored: { chunk: RetrievedChunk; score: number }[],
): Promise<{ chunk: RetrievedChunk; score: number; rank: number }[]> {
  if (scored.length <= 1) return scored.map((s, i) => ({ ...s, rank: i }));

  const prompt = `You are a document re-ranker for a RAG system.

Question: "${question}"

Re-rank these chunks from MOST to LEAST relevant for answering the question.
Prioritize chunks that:
1. Contain the most direct, specific answer
2. Have key facts, numbers, or definitions
3. Are from the main content (not sidebars/navigation)

Chunks:
${scored
  .map(
    (s, i) =>
      `CHUNK_${i} (current score: ${s.score}/10): """${s.chunk.text.slice(0, 400)}"""`,
  )
  .join("\n\n")}

Return ONLY a JSON array of chunk indices in the new order (best first).
Example: [2, 0, 3, 1, 4]
No explanation, no markdown, just the JSON array.`;

  const raw = await callGemini(prompt, 128);
  const clean = raw.replace(/```json|```/g, "").trim();
  const order = JSON.parse(clean) as number[];

  if (!Array.isArray(order) || order.length !== scored.length) {
    logger.warn("Intelligence: re-rank order invalid — keeping order");
    return scored.map((s, i) => ({ ...s, rank: i }));
  }

  const validOrder = [...new Set(order)].filter(
    (i) => i >= 0 && i < scored.length,
  );
  if (validOrder.length !== scored.length) {
    return scored.map((s, i) => ({ ...s, rank: i }));
  }

  logger.debug(`Intelligence Re-rank: [${validOrder.join(", ")}]`);
  return validOrder.map((originalIdx, newRank) => ({
    ...scored[originalIdx],
    rank: newRank,
  }));
}

async function compressChunks(
  question: string,
  chunks: { chunk: RetrievedChunk; score: number; rank: number }[],
): Promise<
  { chunk: RetrievedChunk; score: number; rank: number; compressedText: string }[]
> {
  const needsCompression = chunks.filter((c) => c.chunk.text.length > 400);
  const alreadyShort = chunks.filter((c) => c.chunk.text.length <= 400);

  if (needsCompression.length === 0) {
    return chunks.map((c) => ({ ...c, compressedText: c.chunk.text }));
  }

  const prompt = `You are a context compressor for a RAG system.

Question: "${question}"

For each chunk below, extract ONLY the sentences that are directly relevant to answering the question.
- Remove navigation text, ads, repeated headers, footers
- Remove sentences that don't relate to the question
- Keep all specific facts, numbers, dates, names that relate to the question
- If the entire chunk is relevant, return it unchanged
- If nothing is relevant, return an empty string ""

Chunks to compress:
${needsCompression
  .map((c, i) => `CHUNK_${i}:\n"""${c.chunk.text.slice(0, 1000)}"""`)
  .join("\n\n")}

Return ONLY a JSON object where keys are "CHUNK_0", "CHUNK_1", etc. and values are the compressed text.
Example: {"CHUNK_0": "compressed text here", "CHUNK_1": "other compressed text"}
No explanation, no markdown backticks, just the JSON object.`;

  const raw = await callGemini(prompt, 4096);
  const clean = raw.replace(/```json|```/g, "").trim();
  const result = JSON.parse(clean) as Record<string, string>;

  const totalBefore = needsCompression.reduce(
    (s, c) => s + c.chunk.text.length,
    0,
  );
  let totalAfter = 0;

  const compressed = needsCompression.map((c, i) => {
    const compressedText = result[`CHUNK_${i}`]?.trim() || c.chunk.text;
    totalAfter += compressedText.length;
    const ratio = (
      ((c.chunk.text.length - compressedText.length) / c.chunk.text.length) *
      100
    ).toFixed(0);
    logger.debug(
      `Intelligence Compress CHUNK_${i}: ${c.chunk.text.length} → ${compressedText.length} chars (-${ratio}%)`,
    );
    return { ...c, compressedText };
  });

  const compressionRatio = totalBefore > 0 ? 1 - totalAfter / totalBefore : 0;
  logger.debug(
    `Intelligence: total compression ${(compressionRatio * 100).toFixed(1)}%`,
  );

  const shortMapped = alreadyShort.map((c) => ({
    ...c,
    compressedText: c.chunk.text,
  }));

  return [...compressed, ...shortMapped].sort((a, b) => a.rank - b.rank);
}

async function runIntelligencePipeline(
  question: string,
  rawChunks: RetrievedChunk[],
): Promise<IntelligenceResult> {
  const startTime = Date.now();

  if (!config.GEMINI_API_KEY) {
    logger.warn("Intelligence: GEMINI_API_KEY not set — skipping refinement");
    return {
      refinedChunks: rawChunks.map((c, i) => ({
        ...c,
        relevanceScore: c.score * 10,
        originalRank: i,
        finalRank: i,
        compressed: false,
        originalLength: c.text.length,
      })),
      droppedChunks: 0,
      compressionRatio: 0,
      intelligenceUsed: false,
      processingMs: 0,
    };
  }

  try {
    logger.debug(
      `Intelligence: starting pipeline for ${rawChunks.length} chunks`,
    );

    const scored = await filterByRelevance(question, rawChunks);
    const passing = scored.filter((s) => s.score >= 3);

    if (passing.length === 0) {
      logger.warn(
        "Intelligence: all chunks scored < 3, keeping top 3 raw chunks",
      );
      const fallback = scored.sort((a, b) => b.score - a.score).slice(0, 3);
      return buildResult(
        rawChunks,
        fallback.map((s, i) => ({ ...s, rank: i, compressedText: s.chunk.text })),
        rawChunks.length - fallback.length,
        0,
        Date.now() - startTime,
      );
    }

    const reRanked = await reRankChunks(question, passing);
    const compressed = await compressChunks(question, reRanked);

    const totalOriginal = rawChunks.reduce((s, c) => s + c.text.length, 0);
    const totalCompressed = compressed.reduce(
      (s, c) => s + c.compressedText.length,
      0,
    );
    const compressionRatio =
      totalOriginal > 0 ? 1 - totalCompressed / totalOriginal : 0;

    logger.info(
      `✅ Intelligence pipeline done: ${rawChunks.length} → ${compressed.length} chunks, ` +
        `${(compressionRatio * 100).toFixed(0)}% compressed, ` +
        `${Date.now() - startTime}ms`,
    );

    return buildResult(
      rawChunks,
      compressed,
      rawChunks.length - passing.length,
      compressionRatio,
      Date.now() - startTime,
    );
  } catch (err) {
    logger.warn(
      `Intelligence pipeline failed — using raw chunks: ${(err as Error).message}`,
    );
    return {
      refinedChunks: rawChunks.map((c, i) => ({
        ...c,
        relevanceScore: c.score * 10,
        originalRank: i,
        finalRank: i,
        compressed: false,
        originalLength: c.text.length,
      })),
      droppedChunks: 0,
      compressionRatio: 0,
      intelligenceUsed: false,
      processingMs: Date.now() - startTime,
    };
  }
}

function buildResult(
  rawChunks: RetrievedChunk[],
  compressed: {
    chunk: RetrievedChunk;
    score: number;
    rank: number;
    compressedText: string;
  }[],
  droppedChunks: number,
  compressionRatio: number,
  processingMs: number,
): IntelligenceResult {
  const refinedChunks: RefinedChunk[] = compressed.map((c, finalRank) => ({
    ...c.chunk,
    text: c.compressedText || c.chunk.text,
    relevanceScore: c.score,
    originalRank: rawChunks.findIndex((r) => r.text === c.chunk.text),
    finalRank,
    compressed:
      c.compressedText !== c.chunk.text &&
      c.compressedText.length < c.chunk.text.length,
    originalLength: c.chunk.text.length,
  }));

  return {
    refinedChunks,
    droppedChunks,
    compressionRatio,
    intelligenceUsed: true,
    processingMs,
  };
}

export const refineChunks = isTracingEnabled()
  ? traceable(
      async (
        question: string,
        rawChunks: RetrievedChunk[],
      ): Promise<IntelligenceResult> => runIntelligencePipeline(question, rawChunks),
      {
        name: "RAGIntelligenceLayer",
        run_type: "chain",
        tags: ["intelligence", "filter", "rerank", "compress"],
        metadata: { steps: ["relevance-filter", "re-ranker", "compressor"] },
      },
    )
  : runIntelligencePipeline;

export function buildRefinedContext(result: IntelligenceResult): string {
  const { refinedChunks } = result;

  const header = result.intelligenceUsed
    ? `<!-- RAG Intelligence: ${refinedChunks.length} chunks, ${(result.compressionRatio * 100).toFixed(0)}% compressed, ${result.droppedChunks} irrelevant dropped -->\n\n`
    : "";

  const chunks = refinedChunks
    .map((chunk, i) => {
      const src = chunk.sourceUrl ? `\nSource: ${chunk.sourceUrl}` : "";
      const sec = chunk.section ? `\nSection: ${chunk.section}` : "";
      const quality = result.intelligenceUsed
        ? `\nRelevance: ${chunk.relevanceScore.toFixed(1)}/10`
        : "";
      return `<context_chunk id="${i + 1}"${quality}>${src}${sec}\n\n${chunk.text}\n</context_chunk>`;
    })
    .join("\n\n");

  return header + chunks;
}

