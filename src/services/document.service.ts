// src/services/document.service.ts
// All document-related database operations
import { Document, DocumentStatus } from "@generated/prisma";
import { prisma } from "@utils/prisma";
import { normalizeUrl, hashText } from "@utils/sanitize";
import { deleteByDocumentId } from "@services/qdrant.service";
import { deleteCachePattern } from "@utils/redis";
import { HttpException } from "@exceptions/httpException";

const documentSelect = {
  id: true,
  url: true,
  title: true,
  status: true,
  siteKey: true,
  chunkCount: true,
  tokenCount: true,
  contentType: true,
  crawledAt: true,
  indexedAt: true,
  errorMessage: true,
  createdAt: true,
} as const;

// ─── CREATE OR UPDATE PLACEHOLDER ────────────────────────────────────────────
export async function createPlaceholder(url: string) {
  const normalizedUrl = normalizeUrl(url);
  const urlHash = hashText(normalizedUrl);
  return prisma.document.upsert({
    where: { urlHash },
    create: { url: normalizedUrl, urlHash, status: DocumentStatus.PENDING },
    update: { status: DocumentStatus.PENDING, errorMessage: null },
  });
}

/** Alias for createPlaceholder (controller may pass urlHash; we hash internally). */
export const upsertForAsyncIngestion = createPlaceholder;

// ─── LIST DOCUMENTS ───────────────────────────────────────────────────────────
export async function listDocuments(opts: {
  page: number;
  limit: number;
  status?: DocumentStatus | string;
  siteKey?: string;
  rootOnly?: boolean;
}): Promise<{ documents: unknown[]; total: number }> {
  const { page, limit, status, siteKey, rootOnly } = opts;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (status) {
    where.status = status as DocumentStatus;
  }
  if (siteKey) {
    where.siteKey = siteKey;
  }
  if (rootOnly) {
    where.siteKey = null;
  }

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      select: documentSelect,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.document.count({ where }),
  ]);

  return { documents, total };
}

// ─── LIST SITE KEYS (for scope dropdown: includes all siteKeys + all root URLs) ──
export async function listSiteKeys(): Promise<{ siteKeys: string[] }> {
  const [docsWithKeys, rootDocs] = await Promise.all([
    prisma.document.findMany({
      where: { status: DocumentStatus.INDEXED, siteKey: { not: null } },
      select: { siteKey: true },
      distinct: ["siteKey"],
    }),
    prisma.document.findMany({
      where: { status: DocumentStatus.INDEXED, siteKey: null },
      select: { url: true },
    }),
  ]);

  const siteKeys = new Set<string>();

  // Add all explicit site keys
  for (const d of docsWithKeys as Pick<Document, 'siteKey'>[]) {
    if (d.siteKey) siteKeys.add(d.siteKey);
  }

  // Add all root document URLs
  for (const d of rootDocs as Pick<Document, 'url'>[]) {
    siteKeys.add(d.url);
  }

  return { siteKeys: Array.from(siteKeys).sort() };
}

// ─── GET DOCUMENT BY ID ──────────────────────────────────────────────────────
export async function getDocumentById(id: string) {
  return prisma.document.findFirst({
    where: { id },
    include: {
      _count: { select: { chunks: true } },
    },
  });
}

// ─── DELETE DOCUMENT ──────────────────────────────────────────────────────────
export async function deleteDocument(id: string): Promise<void> {
  const doc = await prisma.document.findFirst({ where: { id } });
  if (!doc) throw new HttpException(404, "Document not found");

  await deleteByDocumentId(id);
  await prisma.document.delete({ where: { id } });
  await deleteCachePattern(`query:*`);
}

// ─── REINDEX (UPDATE STATUS + RETURN DOC) ──────────────────────────────────────
export async function setReindexingAndGetDocument(id: string) {
  const doc = await prisma.document.findFirst({ where: { id } });
  if (!doc) throw new HttpException(404, "Document not found");

  await prisma.document.update({
    where: { id },
    data: { status: DocumentStatus.REINDEXING },
  });

  return doc;
}

/** Alias for deleteDocument (used by controller). */
export const deleteDocumentById = deleteDocument;
