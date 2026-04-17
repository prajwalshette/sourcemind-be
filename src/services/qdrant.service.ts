// src/services/qdrant.service.ts
// v3: Named vectors (dense + sparse), hybrid search, rich metadata filters.
import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import { getEmbeddingDimension } from "@services/embedder.service";
import { textToSparseVector } from "@services/sparse-encoder";
import { normalizeUrl } from "@utils/sanitize";

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
      sparse_vectors?: { sparse?: unknown };
    };
    const hasNamedVectors = !!params.vectors && "dense" in params.vectors;
    const hasSparseVectors = !!params.sparse_vectors && "sparse" in params.sparse_vectors;
    const existingDim =
      params.vectors?.dense?.size ?? (params.vectors as { size?: number })?.size ?? 0;

    if (!hasNamedVectors || !hasSparseVectors || existingDim !== dim) {
      if (!hasNamedVectors) {
        logger.warn("Collection uses legacy single vector — recreating with named vectors (dense + sparse).");
      } else if (!hasSparseVectors) {
        logger.warn("Collection missing sparse vectors — recreating for hybrid search (dense + sparse).");
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
    client.createPayloadIndex(COLLECTION, { field_name: "url", field_schema: "keyword" }),
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
  logger.debug({ collection: COLLECTION, filter: qdrantFilter, topK, queryVectorLen: queryVector.length }, "vectorSearch called");
  try {
    const results = await client.search(COLLECTION, {
      vector: { name: "dense", vector: queryVector },
      ...(qdrantFilter && { filter: qdrantFilter }),
      limit: topK,
      with_payload: true,
      ...(scoreThreshold !== undefined && scoreThreshold > 0
        ? { score_threshold: scoreThreshold }
        : {}),
    } as Parameters<typeof client.search>[1]);
    const mapped = results.map((r) => ({
      id: String(r.id),
      score: r.score,
      text: r.payload?.text as string,
      metadata: r.payload as Record<string, unknown>,
    }));
    if (mapped.length === 0 && filter.siteKey?.startsWith("http")) {
      // Some records (especially the root page) may have site_key="" and only be discoverable by URL.
      // Also, stored URLs may be normalized (e.g., trailing slash).
      const normalized = normalizeUrl(filter.siteKey);
      const urlCandidates = [normalized, filter.siteKey, `${normalized}/`].filter(
        (v, i, arr) => v && arr.indexOf(v) === i,
      );
      logger.debug({ siteKey: filter.siteKey, urlCandidates }, "vectorSearch: siteKey fallback by url");
      for (const urlValue of urlCandidates) {
        try {
          const urlResults = await client.search(COLLECTION, {
            vector: { name: "dense", vector: queryVector },
            filter: { must: [{ key: "url", match: { value: urlValue } }] },
            limit: topK,
            with_payload: true,
            ...(scoreThreshold !== undefined && scoreThreshold > 0
              ? { score_threshold: scoreThreshold }
              : {}),
          } as Parameters<typeof client.search>[1]);
          if (urlResults.length > 0) {
            return urlResults.map((r) => ({
              id: String(r.id),
              score: r.score,
              text: r.payload?.text as string,
              metadata: r.payload as Record<string, unknown>,
            }));
          }
        } catch {
          // If URL-filtered fallback fails, keep trying other candidates.
        }
      }
    }
    return mapped;
  } catch (err) {
    const error = err as Error & { status?: number; response?: { status?: number; data?: unknown } };
    const status = error.status ?? error.response?.status;
    const msg = error.message ?? String(err);
    const responseData = error.response?.data;

    if (status === 400 && qdrantFilter) {
      logger.warn(`Vector search with filter failed (400), retrying without filter: ${msg}`);
      try {
        const fallbackResults = await client.search(COLLECTION, {
          vector: { name: "dense", vector: queryVector },
          limit: topK,
          with_payload: true,
        } as Parameters<typeof client.search>[1]);
        return fallbackResults.map((r) => ({
          id: String(r.id),
          score: r.score,
          text: r.payload?.text as string,
          metadata: r.payload as Record<string, unknown>,
        }));
      } catch (fallbackErr) {
        const fallbackMsg = (fallbackErr as Error)?.message ?? String(fallbackErr);
        logger.error(`Vector search fallback also failed: ${fallbackMsg}`);
      }
    }

    logger.error(
      { status, msg, responseData, collection: COLLECTION },
      `Vector search failed: ${msg}`,
    );
    return [];
  }
}

// ─── SPARSE (BM25) SEARCH ─────────────────────────────────────────────────────
let sparseSearchSupported: boolean | undefined;
let sparseDisableLogged = false;

export async function sparseSearch(
  queryText: string,
  filter: SearchFilter,
  topK = 20,
): Promise<SearchResult[]> {
  if (sparseSearchSupported === false) return [];
  const sparseVector = textToSparseVector(queryText);
  const qdrantFilter = buildFilter(filter);
  try {
    const results = await client.search(COLLECTION, {
      vector: { name: "sparse", vector: sparseVector },
      ...(qdrantFilter && { filter: qdrantFilter }),
      limit: topK,
      with_payload: true,
    } as Parameters<typeof client.search>[1]);
    const mapped = results.map((r) => ({
      id: String(r.id),
      score: r.score,
      text: r.payload?.text as string,
      metadata: r.payload as Record<string, unknown>,
    }));
    if (mapped.length === 0 && filter.siteKey?.startsWith("http")) {
      const normalized = normalizeUrl(filter.siteKey);
      const urlCandidates = [normalized, filter.siteKey, `${normalized}/`].filter(
        (v, i, arr) => v && arr.indexOf(v) === i,
      );
      logger.debug({ siteKey: filter.siteKey, urlCandidates }, "sparseSearch: siteKey fallback by url");
      for (const urlValue of urlCandidates) {
        try {
          const urlResults = await client.search(COLLECTION, {
            vector: { name: "sparse", vector: sparseVector },
            filter: { must: [{ key: "url", match: { value: urlValue } }] },
            limit: topK,
            with_payload: true,
          } as Parameters<typeof client.search>[1]);
          if (urlResults.length > 0) {
            return urlResults.map((r) => ({
              id: String(r.id),
              score: r.score,
              text: r.payload?.text as string,
              metadata: r.payload as Record<string, unknown>,
            }));
          }
        } catch {
          // ignore
        }
      }
    }
    return mapped;
  } catch (err) {
    const error = err as Error & { status?: number; response?: { status?: number } };
    const status = error.status ?? error.response?.status;
    const msg = error.message ?? String(err);
    if (status === 400 || msg.toLowerCase().includes("bad request")) {
      sparseSearchSupported = false;
      if (!sparseDisableLogged) {
        sparseDisableLogged = true;
        logger.warn(`Sparse search disabled (Qdrant returned 400): ${msg}`);
      }
      return [];
    }
    logger.warn(`Sparse search failed: ${msg}`);
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
  let denseResults: SearchResult[] = [];
  let sparseResults: SearchResult[] = [];

  try {
    denseResults = await vectorSearch(queryVector, filter, topK * 2, 0);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.warn(`Hybrid search: dense leg failed, ${msg}`);
  }

  try {
    sparseResults = await sparseSearch(queryText, filter, topK * 2);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.warn(`Hybrid search: sparse leg failed, ${msg}`);
  }

  if (denseResults.length === 0 && sparseResults.length === 0) {
    logger.warn("Hybrid search: both dense and sparse returned empty");
    return [];
  }

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
    if (filter.siteKey.startsWith("file://")) {
      // File scope (uploaded docs): UI sends siteKey=file://<urlHash> (Document.url)
      // File chunks are scoped by payload.site_key (set to Document.url for file sources).
      must.push({ key: "site_key", match: { value: filter.siteKey } });
    } else if (filter.siteKey.startsWith("http")) {
      // Full URL siteKey — match against stored site_key field.
      must.push({ key: "site_key", match: { value: filter.siteKey } });
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
