import { prisma } from "@/infrastructure/database/prisma.client";
import { DocumentStatus } from "@generated/prisma";

export interface SourceScopeItem {
  title: string;
  url: string;
  sourceType?: string;
}

export interface SourceScopeContext {
  scopeLabel: string;
  sources: SourceScopeItem[];
}

const MAX_SOURCES_IN_PROMPT = 15;

export async function loadSourceScopeContext(options: {
  userId: string;
  documentId?: string;
  siteKey?: string;
}): Promise<SourceScopeContext> {
  const { userId, documentId, siteKey } = options;

  if (documentId) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, uploadedBy: userId, status: DocumentStatus.INDEXED },
      select: { title: true, url: true, sourceType: true, fileName: true },
    });
    if (!doc) {
      return { scopeLabel: "selected document", sources: [] };
    }
    return {
      scopeLabel: doc.title ?? doc.fileName ?? "selected document",
      sources: [
        {
          title: doc.title ?? doc.fileName ?? doc.url,
          url: doc.url,
          sourceType: doc.sourceType,
        },
      ],
    };
  }

  if (siteKey) {
    const docs = await prisma.document.findMany({
      where: { siteKey, uploadedBy: userId, status: DocumentStatus.INDEXED },
      select: { title: true, url: true, sourceType: true },
      take: MAX_SOURCES_IN_PROMPT,
      orderBy: { indexedAt: "desc" },
    });
    return {
      scopeLabel: `site: ${siteKey}`,
      sources: docs.map((d) => ({
        title: d.title ?? d.url,
        url: d.url,
        sourceType: d.sourceType,
      })),
    };
  }

  const docs = await prisma.document.findMany({
    where: { uploadedBy: userId, status: DocumentStatus.INDEXED },
    select: { title: true, url: true, sourceType: true, fileName: true },
    take: MAX_SOURCES_IN_PROMPT,
    orderBy: { indexedAt: "desc" },
  });

  return {
    scopeLabel: "all indexed sources",
    sources: docs.map((d) => ({
      title: d.title ?? d.fileName ?? d.url,
      url: d.url,
      sourceType: d.sourceType,
    })),
  };
}

export function formatSourcesForPrompt(ctx: SourceScopeContext): string {
  if (ctx.sources.length === 0) {
    return `(No indexed sources in scope: ${ctx.scopeLabel})`;
  }
  return ctx.sources
    .map((s, i) => `${i + 1}. ${s.title} (${s.url})${s.sourceType ? ` [${s.sourceType}]` : ""}`)
    .join("\n");
}
