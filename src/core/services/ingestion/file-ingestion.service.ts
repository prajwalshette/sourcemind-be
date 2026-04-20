// src/services/file-ingestion.service.ts
// Pipeline: Buffer → parse → chunk → embed → Qdrant + Prisma
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/infrastructure/database/prisma.client';
import { logger } from '@utils/logger';
import { assembleChunks } from '@/core/services/ingestion/chunker/assembler';
import { parsePDF }       from '@/core/services/ingestion/chunker/pdfChunker.service';
import { parseDOCX }      from '@/core/services/ingestion/chunker/docxChunker.service';
import { parseCSV, parseExcel } from '@/core/services/ingestion/chunker/csvChunker.service';
import { parseTXT }       from '@/core/services/ingestion/chunker/txtChunker.service';
import { parseMD }        from '@/core/services/ingestion/chunker/mdChunker.service';
import { ParsedElement }  from '@/core/services/ingestion/chunker/documentChunker';
import {
  embedDocuments,
  getEmbeddingModelName,
  buildEmbedText,
} from '@/ai/providers/embedder.service';
import { ensureCollection, upsertPoints, deleteByDocumentId } from '@/infrastructure/vectordb/qdrant.client';
import { textToSparseVector } from '@/ai/chains/sparse-encoder';
import { hashText, stripNullBytes } from '@utils/sanitize';
import { IngestResult } from '@/core/types/ingestion.interface';
import { QdrantPoint } from '@/core/types/search.interface';
import { DocumentStatus, UsageType } from "@generated/prisma";

// ─── MIME → parser map ───────────────────────────────────────────────────────
async function extractElements(
  buffer: Buffer,
  mimeType: string,
): Promise<ParsedElement[]> {
  switch (mimeType) {
    case 'application/pdf':
      return parsePDF(buffer);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return parseDOCX(buffer);

    case 'text/csv':
      return parseCSV(buffer.toString('utf-8'));

    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return parseExcel(buffer);

    case 'text/markdown':
    case 'text/x-markdown':
      return parseMD(buffer.toString('utf-8'));

    case 'text/plain':
    default:
      return parseTXT(buffer.toString('utf-8'));
  }
}

// ─── MAIN PIPELINE ───────────────────────────────────────────────────────────
export async function ingestFile(
  documentId: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<IngestResult> {
  await ensureCollection();

  logger.info(`[FileIngestion] Starting: ${fileName} (${mimeType}) doc=${documentId}`);

  try {
    const doc = await prisma.document.findFirst({
      where: { id: documentId },
      select: { url: true, title: true },
    });
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    // ── Step 1: Chunk ────────────────────────────────────────────────────────
    await prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.CHUNKING },
    });

    const elements = await extractElements(buffer, mimeType);
    const rawChunks = assembleChunks(elements, documentId);

    logger.info(`[FileIngestion] ${fileName} → ${rawChunks.length} chunks`);

    // Postgres TEXT cannot contain NUL (\u0000). Sanitize once so Prisma + Qdrant stay consistent.
    const chunks = rawChunks.map((c) => ({
      ...c,
      text: stripNullBytes(c.text),
      parentText: c.parentText ? stripNullBytes(c.parentText) : c.parentText,
    }));

    // ── Step 2: Embed ────────────────────────────────────────────────────────
    await prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.EMBEDDING },
    });

    const embeddingModel = getEmbeddingModelName();
    const enrichedTexts = chunks.map(c =>
      buildEmbedText(c.text, doc.title ?? fileName, c.section ?? undefined),
    );
    const vectors = await embedDocuments(enrichedTexts);

    // ── Step 3: Delete old chunks (re-index path) ────────────────────────────
    await deleteByDocumentId(documentId);
    await prisma.chunk.deleteMany({ where: { documentId } });

    // ── Step 4: Upsert Qdrant + Prisma ───────────────────────────────────────
    const qdrantPoints: QdrantPoint[] = [];
    const prismaChunks: NonNullable<
      Parameters<typeof prisma.chunk.createMany>[0]
    >['data'] = [];

    for (const [i, chunk] of chunks.entries()) {
      const pointId = uuidv4();
      const searchText = chunk.text;
      const sparseVec  = textToSparseVector(searchText);

      qdrantPoints.push({
        id: pointId,
        vector: vectors[i],
        sparseVector: sparseVec,
        payload: {
          text: chunk.text,
          document_id: documentId,
          // File sources are scoped by their Document.url (file://<urlHash>)
          // so the UI can query `siteKey=file://...` and Qdrant can filter.
          site_key: doc.url,
          chunk_index: chunk.chunkIndex,
          token_count: chunk.tokenCount,
          section: chunk.section ?? '',
          url: doc.url,
          title: doc.title ?? fileName,
          domain: '',
          embedding_model: embeddingModel,
          created_at: new Date().toISOString(),
          hypothetical_questions: [],
          has_questions: false,
          source_type: 'file',
          tags: [],
          loader: 'file-upload',
        },
      });

      prismaChunks.push({
        id: pointId,
        documentId,
        qdrantPointId: pointId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        parentText: chunk.parentText,
        parentId: chunk.parentId,
        textHash: hashText(chunk.text),
        tokenCount: chunk.tokenCount,
        section: chunk.section ?? null,
      });
    }

    await upsertPoints(qdrantPoints);
    await prisma.chunk.createMany({ data: prismaChunks, skipDuplicates: true });

    const totalTokens = chunks.reduce((s, c) => s + c.tokenCount, 0);

    // ── Step 5: Mark INDEXED ─────────────────────────────────────────────────
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: DocumentStatus.INDEXED,
        chunkCount: chunks.length,
        tokenCount: totalTokens,
        embeddingModel,
        indexedAt: new Date(),
      },
    });

    await prisma.usageLog.create({
      data: {
        action: UsageType.EMBED,
        tokensUsed: totalTokens,
        metadata: { documentId, fileName, mimeType },
      },
    });

    logger.info(
      `[FileIngestion] ✅ Indexed: ${fileName} → ${chunks.length} chunks, ${totalTokens} tokens`,
    );

    return {
      documentId,
      chunkCount: chunks.length,
      tokenCount: totalTokens,
      status: DocumentStatus.INDEXED,
      title: fileName,
    };
  } catch (err) {
    const error = err as Error;
    await prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.FAILED, errorMessage: error.message },
    });
    logger.error({ error: error.message }, `[FileIngestion] Failed: ${fileName}`);
    throw error;
  }
}
