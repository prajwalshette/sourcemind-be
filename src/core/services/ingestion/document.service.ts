// src/services/document.service.ts
// All document-related database operations
import { Document, DocumentStatus, SourceType, FileType } from "@generated/prisma";
import { prisma } from "@/infrastructure/database/prisma.client";
import { normalizeUrl, hashText } from "@utils/sanitize";
import { deleteByDocumentId } from "@/infrastructure/vectordb/qdrant.client";
import { deleteCachePattern } from "@/infrastructure/database/redis.client";
import { HttpException } from "@/core/exceptions/httpException";

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
export async function createPlaceholder(url: string, uploadedBy?: string) {
  const normalizedUrl = normalizeUrl(url);
  const urlHash = hashText(normalizedUrl);
  return prisma.document.upsert({
    where: { urlHash },
    create: {
      url: normalizedUrl,
      urlHash,
      status: DocumentStatus.PENDING,
      ...(uploadedBy ? { uploadedBy } : {}),
    },
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
  userId: string;
}): Promise<{ documents: unknown[]; total: number }> {
  const { page, limit, status, siteKey, rootOnly, userId } = opts;
  const skip = (page - 1) * limit;

  const where: any = { uploadedBy: userId };
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

export type SourceListItem = {
  key: string; // value used in scope filter (site:<key>)
  sourceType: SourceType;
  title?: string | null;
  fileType?: FileType | null;
};

/**
 * Rich source list for UI filters.
 * - WEBSITE: includes distinct siteKeys + root (single-page) URLs
 * - FILE: includes root docs whose url is file://<id> (with fileType/title)
 * - GITHUB: includes distinct githubRepo or siteKey if present (future)
 */
export async function listSources(opts?: { userId: string }): Promise<{ sources: SourceListItem[] }> {
  const userId = opts?.userId;
  const uploadedByFilter = userId ? { uploadedBy: userId } : {};
  const [siteKeyGroups, rootDocs] = await Promise.all([
    prisma.document.findMany({
      where: { status: DocumentStatus.INDEXED, siteKey: { not: null }, ...uploadedByFilter },
      select: { siteKey: true, sourceType: true },
      distinct: ["siteKey"],
    }),
    prisma.document.findMany({
      where: { status: DocumentStatus.INDEXED, siteKey: null, ...uploadedByFilter },
      select: {
        url: true,
        title: true,
        sourceType: true,
        fileType: true,
        fileName: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const out: SourceListItem[] = [];
  const seen = new Set<string>();

  for (const g of siteKeyGroups as Array<{ siteKey: string | null; sourceType: SourceType }>) {
    if (!g.siteKey) continue;
    const key = g.siteKey;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      sourceType: g.sourceType ?? SourceType.WEBSITE,
      title: null,
      fileType: null,
    });
  }

  for (const d of rootDocs as Array<{
    url: string;
    title: string | null;
    sourceType: SourceType;
    fileType: FileType | null;
    fileName: string | null;
  }>) {
    const key = d.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      sourceType: d.sourceType ?? SourceType.WEBSITE,
      title: d.title ?? d.fileName ?? null,
      fileType: d.fileType ?? null,
    });
  }

  // stable ordering: websites then files then github, alphabetic within each bucket
  const rank = (t: SourceListItem["sourceType"]) =>
    t === SourceType.WEBSITE ? 0 : t === SourceType.FILE ? 1 : 2;
  out.sort((a, b) => {
    const r = rank(a.sourceType) - rank(b.sourceType);
    if (r !== 0) return r;
    return a.key.localeCompare(b.key);
  });

  return { sources: out };
}

// ─── GET DOCUMENT BY ID ──────────────────────────────────────────────────────
export async function getDocumentById(id: string, userId: string) {
  return prisma.document.findFirst({
    where: { id, uploadedBy: userId },
    include: {
      _count: { select: { chunks: true } },
    },
  });
}

// ─── DELETE DOCUMENT ──────────────────────────────────────────────────────────
export async function deleteDocument(id: string, userId: string): Promise<void> {
  const doc = await prisma.document.findFirst({ where: { id, uploadedBy: userId } });
  if (!doc) throw new HttpException(404, "Document not found");

  await deleteByDocumentId(id);
  await prisma.document.delete({ where: { id } });
  await deleteCachePattern(`query:*`);
}

// ─── REINDEX (UPDATE STATUS + RETURN DOC) ──────────────────────────────────────
export async function setReindexingAndGetDocument(id: string, userId: string) {
  const doc = await prisma.document.findFirst({ where: { id, uploadedBy: userId } });
  if (!doc) throw new HttpException(404, "Document not found");

  await prisma.document.update({
    where: { id },
    data: { status: DocumentStatus.REINDEXING },
  });

  return doc;
}

/** Alias for deleteDocument (used by controller). */
export const deleteDocumentById = deleteDocument;
