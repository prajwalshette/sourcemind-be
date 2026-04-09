// src/services/qdrant.service.ts
// v3: Named vectors (dense + sparse), hybrid search, rich metadata filters.
import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { getEmbeddingDimension } from "@services/embedder.service";
import { textToSparseVector } from "@services/sparse-encoder";

const client = new QdrantClient({
  url: config.QDRANT_URL,
  ...(config.QDRANT_API_KEY ? { apiKey: config.QDRANT_API_KEY } : {}),
});

const COLLECTION = config.QDRANT_COLLECTION;

// ─── COLLECTION SETUP ────────────────────────────────────────────────────────
export async function ensureCollection(): Promise<void> {
  const dim = getEmbeddingDimension();

  try {
    const info = await client.getCollection(COLLECTION);
    const params = info.config.params as {
      vectors?: { size?: number; dense?: { size: number } };
    };
    const hasNamedVectors = !!params.vectors && "dense" in params.vectors;
    const existingDim =
      params.vectors?.dense?.size ?? (params.vectors as { size?: number })?.size ?? 0;

    if (!hasNamedVectors || existingDim !== dim) {
      if (!hasNamedVectors) {
        logger.warn("Collection uses legacy single vector — recreating with named vectors (dense + sparse).");
      } else {
        logger.warn(`Dimension mismatch: existing=${existingDim}, current=${dim}. Recreating collection.`);
      }
      await client.deleteCollection(COLLECTION);
      await createCollection(dim);
    } else {
      logger.debug(`Collection "${COLLECTION}" exists (dim=${dim}, hybrid).`);
    }
  } catch {
    await createCollection(dim);
  }
}

async function createCollection(dim: number): Promise<void> {
  await client.createCollection(COLLECTION, {
    vectors: {
      dense: { size: dim, distance: "Cosine", on_disk: true },
    },
    sparse_vectors: {
      sparse: { index: { on_disk: true } },
    },
    optimizers_config: { memmap_threshold: 20_000 },
    hnsw_config: { m: 16, ef_construct: 100, full_scan_threshold: 10_000 },
  } as Parameters<typeof client.createCollection>[1]);

  await Promise.all([
    client.createPayloadIndex(COLLECTION, { field_name: "document_id", field_schema: "keyword" }),
    client.createPayloadIndex(COLLECTION, { field_name: "site_key", field_schema: "keyword" }),
    client.createPayloadIndex(COLLECTION, { field_name: "chunk_index", field_schema: "integer" }),
    client.createPayloadIndex(COLLECTION, { field_name: "domain", field_schema: "keyword" }),
    client.createPayloadIndex(COLLECTION, { field_name: "source_type", field_schema: "keyword" }),
    client.createPayloadIndex(COLLECTION, { field_name: "tags", field_schema: "keyword" }),
    client.createPayloadIndex(COLLECTION, { field_name: "created_at", field_schema: "datetime" }),
    client.createPayloadIndex(COLLECTION, { field_name: "has_questions", field_schema: "bool" }),
  ]);

  logger.info(`✅ Qdrant collection "${COLLECTION}" created (dim=${dim}, hybrid vectors, site_key indexed).`);
}

// ─── UPSERT ──────────────────────────────────────────────────────────────────
import {
  QdrantPoint,
  SearchFilter,
  SearchResult,
} from "@interfaces/search.interface";

export async function upsertPoints(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return;

  const BATCH = 100;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    const formatted = batch.map((p) => ({
      id: p.id,
      vector: {
        dense: p.vector,
        ...(p.sparseVector ? { sparse: p.sparseVector } : {}),
      },
      payload: p.payload,
    }));
    await client.upsert(COLLECTION, { points: formatted, wait: true });
    logger.debug(
      `Upserted batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(points.length / BATCH)}`,
    );
  }
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────

export async function vectorSearch(
  queryVector: number[],
  filter: SearchFilter,
  topK = 20,
  scoreThreshold?: number,
): Promise<SearchResult[]> {
  const qdrantFilter = buildFilter(filter);
  const results = await client.search(COLLECTION, {
    vector: { name: "dense", vector: queryVector },
    ...(qdrantFilter && { filter: qdrantFilter }),
    limit: topK,
    with_payload: true,
    // Only apply a score_threshold when the caller explicitly sets one > 0;
    // in hybrid mode the caller passes 0 (or omits it) to return all candidates.
    ...(scoreThreshold !== undefined && scoreThreshold > 0
      ? { score_threshold: scoreThreshold }
      : {}),
  } as Parameters<typeof client.search>[1]);
  return results.map((r) => ({
    id: String(r.id),
    score: r.score,
    text: r.payload?.text as string,
    metadata: r.payload as Record<string, unknown>,
  }));
}

// ─── SPARSE (BM25) SEARCH ─────────────────────────────────────────────────────
export async function sparseSearch(
  queryText: string,
  filter: SearchFilter,
  topK = 20,
): Promise<SearchResult[]> {
  const sparseVector = textToSparseVector(queryText);
  const qdrantFilter = buildFilter(filter);
  try {
    const results = await client.search(COLLECTION, {
      vector: { name: "sparse", vector: sparseVector },
      ...(qdrantFilter && { filter: qdrantFilter }),
      limit: topK,
      with_payload: true,
    } as Parameters<typeof client.search>[1]);
    return results.map((r) => ({
      id: String(r.id),
      score: r.score,
      text: r.payload?.text as string,
      metadata: r.payload as Record<string, unknown>,
    }));
  } catch (err) {
    logger.warn(`Sparse search failed (no sparse vectors?): ${(err as Error).message}`);
    return [];
  }
}

// ─── HYBRID (dense + sparse, RRF fusion) ─────────────────────────────────────
const RRF_K = 60;

export async function hybridSearch(
  queryVector: number[],
  queryText: string,
  filter: SearchFilter,
  topK = 20,
): Promise<SearchResult[]> {
  // In hybrid mode, we never threshold the dense leg — RRF fusion handles ranking.
  const [denseResults, sparseResults] = await Promise.all([
    vectorSearch(queryVector, filter, topK * 2, 0),
    sparseSearch(queryText, filter, topK * 2),
  ]);

  if (sparseResults.length === 0) {
    logger.debug("Hybrid: sparse returned 0 — using dense only");
    return denseResults.slice(0, topK);
  }

  const scores = new Map<string, { score: number; result: SearchResult }>();
  denseResults.forEach((r, rank) => {
    scores.set(r.id, { score: 1 / (RRF_K + rank + 1), result: r });
  });
  sparseResults.forEach((r, rank) => {
    const existing = scores.get(r.id);
    if (existing) existing.score += 1 / (RRF_K + rank + 1);
    else scores.set(r.id, { score: 1 / (RRF_K + rank + 1), result: r });
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ result, score }) => ({ ...result, score }));
}

// ─── DELETE BY DOCUMENT ───────────────────────────────────────────────────────
export async function deleteByDocumentId(documentId: string): Promise<void> {
  await client.delete(COLLECTION, {
    filter: {
      must: [{ key: "document_id", match: { value: documentId } }],
    },
    wait: true,
  });
  logger.info(`Deleted vectors for document ${documentId}`);
}

/** Delete all vectors that belong to a siteKey (used when deleting a whole site). */
export async function deleteBySiteKey(siteKey: string): Promise<void> {
  await client.delete(COLLECTION, {
    filter: {
      must: [{ key: "site_key", match: { value: siteKey } }],
    },
    wait: true,
  });
  logger.info(`Deleted all vectors for siteKey ${siteKey}`);
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
export async function qdrantHealth(): Promise<boolean> {
  try {
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function buildFilter(filter: SearchFilter) {
  const must: object[] = [];

  if (filter.siteKey) {
    if (filter.siteKey.startsWith("http")) {
      // Full URL siteKey — match against stored site_key field.
      // Also include chunks where site_key is empty (the root document itself)
      // by falling back to document_id matching via a broader should clause.
      must.push({
        should: [
          { key: "site_key", match: { value: filter.siteKey } },
          // Root documents are stored with site_key="" — match them by domain too
          { key: "url", match: { value: filter.siteKey } },
        ],
        minimum_should: 1,
      });
    } else {
      // Bare hostname (e.g. "senslyze.com") — match by domain field.
      // This covers both the root page and all sub-pages crawled from the same domain.
      must.push({ key: "domain", match: { value: filter.siteKey } });
    }
  } else if (filter.documentId) {
    must.push({ key: "document_id", match: { value: filter.documentId } });
  }

  if (filter.domain) {
    must.push({ key: "domain", match: { value: filter.domain } });
  }
  if (filter.sourceType) {
    must.push({ key: "source_type", match: { value: filter.sourceType } });
  }
  if (filter.tags?.length) {
    must.push({ key: "tags", match: { any: filter.tags } });
  }
  if (filter.createdAfter) {
    must.push({ key: "created_at", range: { gte: filter.createdAfter } });
  }
  if (filter.createdBefore) {
    must.push({ key: "created_at", range: { lte: filter.createdBefore } });
  }
  if (filter.hasQuestions !== undefined) {
    must.push({ key: "has_questions", match: { value: filter.hasQuestions } });
  }
  return must.length > 0 ? { must } : undefined;
}
