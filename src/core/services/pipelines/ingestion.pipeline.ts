// src/services/ingestion.service.ts
// Full ingestion pipeline with LangSmith tracing on every step
import { v4 as uuidv4 } from "uuid";
import { traceable } from "langsmith/traceable";
import { prisma } from "@/infrastructure/database/prisma.client";
import { loadUrl } from "@/core/services/ingestion/url-loader.service";
import { chunkDocument } from "@/core/services/ingestion/chunker.service";
import {
  embedDocuments,
  getEmbeddingModelName,
  buildEmbedText,
} from "@/ai/providers/embedder.service";
import { ensureCollection, upsertPoints } from "@/infrastructure/vectordb/qdrant.client";
import { deleteByDocumentId } from "@/infrastructure/vectordb/qdrant.client";
import { textToSparseVector } from "@/ai/chains/sparse-encoder";
import { normalizeUrl, hashText } from "@utils/sanitize";
import { logger } from "@utils/logger";
import { isTracingEnabled } from "@/config/tracing";
import { DocumentStatus, UsageType } from "@generated/prisma";

import { IngestResult } from "@/core/types/ingestion.interface";
import { QdrantPoint } from "@/core/types/search.interface";

export type IngestLoadOptions = {
  crawlAllPages?: boolean;
  maxPages?: number;
  /** siteKey groups this page with all others crawled from the same parent URL */
  siteKey?: string;
};

// ─── TRACED: CRAWL STEP ──────────────────────────────────────────────────────
const tracedLoadUrl = traceable(
  async (url: string, options?: IngestLoadOptions) => {
    const result = await loadUrl(url, options);
    return {
      url: result.url,
      title: result.title,
      wordCount: result.wordCount,
      contentType: result.contentType,
      contentPreview: result.content.slice(0, 500),
    };
  },
  { name: "URLCrawler", run_type: "tool", tags: ["ingestion", "crawl"] },
);

// ─── TRACED: CHUNK STEP ───────────────────────────────────────────────────────
const tracedChunk = traceable(
  async (
    content: string,
    contentType: "markdown" | "text",
    metadata: Record<string, string>,
  ) => {
    const chunks = await chunkDocument(content, contentType, metadata);
    return {
      chunkCount: chunks.length,
      totalTokens: chunks.reduce((s, c) => s + c.tokenCount, 0),
      chunks,
    };
  },
  { name: "DocumentChunker", run_type: "tool", tags: ["ingestion", "chunking"] },
);

// ─── TRACED: EMBED STEP ───────────────────────────────────────────────────────
const tracedEmbed = traceable(
  async (texts: string[], model: string) => {
    const vectors = await embedDocuments(texts);
    return {
      vectorCount: vectors.length,
      dimensions: vectors[0]?.length ?? 0,
      model,
      vectors,
    };
  },
  {
    name: "DocumentEmbedder",
    run_type: "embedding",
    tags: ["ingestion", "embedding"],
  },
);

// ─── MAIN INGESTION PIPELINE ──────────────────────────────────────────────────
export const ingestUrl = traceable(
  async (url: string, options?: IngestLoadOptions): Promise<IngestResult> => {
    await ensureCollection();

    const normalizedUrl = normalizeUrl(url);
    const urlHash = hashText(normalizedUrl);
    let siteKey = options?.siteKey ? normalizeUrl(options.siteKey) : null;

    // If this document is its own siteKey, we treat it as a root document (siteKey = null)
    // to ensure it shows up in root-only filtered lists.
    if (siteKey === normalizedUrl) {
      siteKey = null;
    }

    // ── Check for existing document (dedup) ────────────────────────────────────
    const existing = await prisma.document.findUnique({
      where: { urlHash },
    });

    if (existing?.status === DocumentStatus.INDEXED) {
      logger.info(`URL already indexed: ${url} (documentId=${existing.id})`);
      return {
        documentId: existing.id,
        chunkCount: existing.chunkCount,
        tokenCount: existing.tokenCount,
        totalQuestions: 0,
        status: "ALREADY_INDEXED",
        title: existing.title || "",
      };
    }

    // ── Create or update document record (store siteKey for site crawls) ─────
    const document = await prisma.document.upsert({
      where: { urlHash },
      create: {
        url,
        urlHash,
        status: DocumentStatus.CRAWLING,
        ...(siteKey ? { siteKey } : {}),
      },
      update: { status: DocumentStatus.CRAWLING, errorMessage: null, ...(siteKey ? { siteKey } : {}) },
    });

    try {
      // ── Step 1: Crawl ──────────────────────────────────────────────────────
      await prisma.document.update({
        where: { id: document.id },
        data: { status: DocumentStatus.CRAWLING, crawledAt: new Date() },
      });

      const loaded = await loadUrl(url, options);
      if (isTracingEnabled()) await tracedLoadUrl(url, options);
      logger.info(`Crawled: ${normalizedUrl} (${loaded.wordCount} words)`);

      // ── Step 2: Chunk ──────────────────────────────────────────────────────
      await prisma.document.update({
        where: { id: document.id },
        data: { status: DocumentStatus.CHUNKING, title: loaded.title },
      });

      let chunks: Awaited<ReturnType<typeof chunkDocument>>;
      if (isTracingEnabled()) {
        const r = await tracedChunk(
          loaded.content,
          loaded.contentType,
          loaded.metadata,
        );
        chunks = r.chunks;
      } else {
        chunks = await chunkDocument(
          loaded.content,
          loaded.contentType,
          loaded.metadata,
        );
      }
      const totalQuestions = chunks.reduce(
        (s, c) => s + (c.hypotheticalQuestions?.length ?? 0),
        0,
      );
      logger.info(
        `Chunked into ${chunks.length} chunks, ${totalQuestions} hypothetical questions`,
      );

      // ── Step 3: Embed ──────────────────────────────────────────────────────
      await prisma.document.update({
        where: { id: document.id },
        data: { status: DocumentStatus.EMBEDDING },
      });

      const embeddingModel = getEmbeddingModelName();
      let vectors: number[][];
      if (isTracingEnabled()) {
        const enrichedTexts = chunks.map((c) =>
          buildEmbedText(c.text, loaded.title, c.section),
        );
        const r = await tracedEmbed(
          enrichedTexts,
          embeddingModel,
        );
        vectors = r.vectors;
      } else {
        const enrichedTexts = chunks.map((c) =>
          buildEmbedText(c.text, loaded.title, c.section),
        );
        vectors = await embedDocuments(enrichedTexts);
      }
      logger.info(`Embedded ${vectors.length} chunks`);

    // ── Step 4: Delete old chunks (re-index case) ──────────────────────────
    await deleteByDocumentId(document.id);
    await prisma.chunk.deleteMany({ where: { documentId: document.id } });

    const sourceType = inferSourceType(loaded.url, loaded.metadata);
    const tags = extractTags(loaded.title, loaded.metadata);

    // ── Step 5: Store in Qdrant + PostgreSQL (v3: sparse + questions + metadata) ─
    const qdrantPoints: QdrantPoint[] = [];
    const prismaChunks: NonNullable<
      Parameters<typeof prisma.chunk.createMany>[0]
    >["data"] = [];

    for (const [i, chunk] of chunks.entries()) {
      const pointId = uuidv4();
      const searchText = [
        chunk.text,
        ...(chunk.hypotheticalQuestions ?? []),
      ].join(" ");
      const sparseVec = textToSparseVector(searchText);

      qdrantPoints.push({
        id: pointId,
        vector: vectors[i],
        sparseVector: sparseVec,
        payload: {
          text: chunk.text,
          document_id: document.id,
          site_key: siteKey ?? "",
          chunk_index: chunk.chunkIndex,
          token_count: chunk.tokenCount,
          section: chunk.section,
          url: loaded.url,
          title: loaded.title,
          domain: loaded.metadata.domain ?? "",
          embedding_model: embeddingModel,
          created_at: new Date().toISOString(),
          hypothetical_questions: chunk.hypotheticalQuestions ?? [],
          has_questions: (chunk.hypotheticalQuestions?.length ?? 0) > 0,
          source_type: sourceType,
          tags,
          loader: loaded.loader,
        },
      });

      prismaChunks.push({
        id: pointId, // same as qdrant point id
        documentId: document.id,
        qdrantPointId: pointId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        parentText: chunk.parentText,
        parentId: chunk.parentId,
        textHash: chunk.textHash,
        tokenCount: chunk.tokenCount,
        section: chunk.section,
      });
    }

    await upsertPoints(qdrantPoints);
    await prisma.chunk.createMany({ data: prismaChunks, skipDuplicates: true });

    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);

    // ── Step 6: Mark as indexed ────────────────────────────────────────────
    await prisma.document.update({
      where: { id: document.id },
      data: {
        status: DocumentStatus.INDEXED,
        chunkCount: chunks.length,
        tokenCount: totalTokens,
        embeddingModel,
        contentType: loaded.contentType,
        metadata: {
          ...loaded.metadata,
          totalQuestions: String(totalQuestions),
          sourceType,
          tags: tags.join(","),
          ...(siteKey ? { siteKey } : {}),
        },
        indexedAt: new Date(),
      },
    });

    await prisma.usageLog.create({
      data: {
        action: UsageType.EMBED,
        tokensUsed: totalTokens,
        metadata: { documentId: document.id, url, totalQuestions, ...(siteKey ? { siteKey } : {}) },
      },
    });

    logger.info(
      `✅ Indexed: ${normalizedUrl} → ${chunks.length} chunks, ${totalQuestions} questions, ${totalTokens} tokens${siteKey ? `, siteKey=${siteKey}` : ""}`,
    );

    return {
      documentId: document.id,
      chunkCount: chunks.length,
      tokenCount: totalTokens,
      totalQuestions,
      status: DocumentStatus.INDEXED,
      title: loaded.title,
    };
  } catch (err) {
    const error = err as Error;
    await prisma.document.update({
      where: { id: document.id },
      data: { status: DocumentStatus.FAILED, errorMessage: error.message },
    });
    logger.error({ error: error.message }, `Ingestion failed: ${url}`);
    throw error;
  }
  },
  { name: "IngestURL", run_type: "chain", tags: ["ingestion", "pipeline"] },
);

// ─── v3: Rich metadata helpers ───────────────────────────────────────────────
function inferSourceType(
  url: string,
  metadata: Record<string, string>,
): string {
  const u = url.toLowerCase();
  if (u.includes("/docs") || u.includes("/documentation")) return "documentation";
  if (u.includes("/blog") || u.includes("/post")) return "blog";
  if (u.includes("/api") || u.includes("api.")) return "api";
  if (u.includes("/pricing")) return "pricing";
  if (u.includes("github.com")) return "github";
  if (u.includes("stackoverflow.com")) return "stackoverflow";
  return "website";
}

function extractTags(title: string, metadata: Record<string, string>): string[] {
  const text = (title + " " + (metadata.description || "")).toLowerCase();
  const TAG_KEYWORDS = [
    "pricing",
    "tutorial",
    "guide",
    "api",
    "docs",
    "reference",
    "quickstart",
    "getting started",
    "faq",
    "changelog",
    "release",
  ];
  const tags: string[] = [];
  for (const kw of TAG_KEYWORDS) {
    if (text.includes(kw)) tags.push(kw);
  }
  return [...new Set(tags)];
}
