// src/services/embedder.service.ts
import { traceable } from "langsmith/traceable";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { CircuitBreaker } from "@utils/circuit-breaker";
import { isTracingEnabled } from "@/config/tracing";

// BGE requires this prefix on queries only (not documents)
const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

// ─── CIRCUIT BREAKERS ────────────────────────────────────────────────────────
const hfBreaker = new CircuitBreaker({
  name: "hf-embed",
  failureThreshold: 5,
  timeout: 60_000,
});

// ─── HUGGINGFACE EMBEDDING (via Router) ──────────────────────────────────────
async function hfEmbed(texts: string[]): Promise<number[][]> {
  if (!config.HF_API_KEY) {
    throw new Error("HF_API_KEY not set — cannot embed");
  }

  const response = await fetch(
    `https://router.huggingface.co/hf-inference/models/${config.HF_EMBED_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: texts }),
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HuggingFace embed error: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as number[][];
  return data;
}

// ─── NORMALIZE VECTOR ────────────────────────────────────────────────────────
function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

// ─── TRACED EMBED BATCH ──────────────────────────────────────────────────────
const tracedEmbedBatch = traceable(
  async (
    texts: string[],
    batchIndex: number,
  ): Promise<number[][]> => {
    const vectors = await hfBreaker.execute(() => hfEmbed(texts));
    return vectors.map(normalize);
  },
  {
    name: "EmbedBatch",
    run_type: "embedding",
    tags: ["embedding", "huggingface"],
  },
);

// ─── PUBLIC API ──────────────────────────────────────────────────────────────
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  // Bigger batches reduce API calls during ingest.
  const BATCH_SIZE = 32;
  const allVectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchIdx = Math.floor(i / BATCH_SIZE);

    let vectors: number[][];
    if (isTracingEnabled()) {
      vectors = await tracedEmbedBatch(batch, batchIdx);
    } else {
      vectors = await hfBreaker.execute(() => hfEmbed(batch));
      vectors = vectors.map(normalize);
    }

    allVectors.push(...vectors);
    logger.debug(
      `Embedded batch ${batchIdx + 1}/${Math.ceil(texts.length / BATCH_SIZE)}`,
    );
  }

  return allVectors;
}

// Build embedding input for website chunks.
// We embed: "[page title] > [section heading]\n[chunk text]"
// so vectors capture topic context, not just the raw chunk text.
export function buildEmbedText(
  chunkText: string,
  pageTitle?: string,
  section?: string | null,
): string {
  const parts: string[] = [];

  if (pageTitle?.trim()) {
    parts.push(pageTitle.trim());
  }

  if (section?.trim()) {
    // Avoid repeating the title if the section already contains it.
    const cleanedSection = section
      .trim()
      .replace(/^#+\s*/, "")
      .trim();
    const titleTrimmed = pageTitle?.trim();
    if (cleanedSection && cleanedSection !== titleTrimmed) {
      parts.push(cleanedSection);
    }
  }

  const prefix = parts.join(" > ");
  return prefix ? `${prefix}\n${chunkText}` : chunkText;
}

export async function embedQuery(query: string): Promise<number[]> {
  // BGE models perform better with query prefix
  const prefixedQuery = config.HF_EMBED_MODEL.includes("bge")
    ? BGE_QUERY_PREFIX + query
    : query;

  const vectors = await embedDocuments([prefixedQuery]);
  return vectors[0];
}

export function getEmbeddingDimension(): number {
  // nomic-embed-text = 768, bge-small = 384
  const model = config.HF_EMBED_MODEL;
  if (model.includes("bge-small")) return 384;
  if (model.includes("bge-base")) return 768;
  if (model.includes("bge-large")) return 1024;
  return 384; // safe default for bge-small
}

export function getEmbeddingModelName(): string {
  return config.HF_EMBED_MODEL;
}
