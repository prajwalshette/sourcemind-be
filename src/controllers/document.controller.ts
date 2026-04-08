 

import { Request, Response, NextFunction } from "express";
import { enqueueIngestion } from "@jobs/ingestion.queue";
import { ingestUrl } from "@services/ingestion.service";
import { crawlSite } from "@services/site-crawler.service";
import {
  upsertForAsyncIngestion,
  listDocuments as listDocumentsService,
  listSiteKeys as listSiteKeysService,
  getDocumentById,
  deleteDocumentById,
  setReindexingAndGetDocument,
} from "@services/document.service";
import { ingestSchema, listSchema } from "@schemas/document.schema";
import { IngestDto, ListDocumentsDto } from "@dtos/document.dto";
import { HttpException } from "@exceptions/httpException";

export async function ingest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body: IngestDto = ingestSchema.parse(req.body);

    // Multi-page site crawl: always async, handled via site-crawler
    if (body.crawlAllPages) {
      const trackingDoc = await upsertForAsyncIngestion(body.url);

      await enqueueIngestion({
        url: body.url,
        documentId: trackingDoc.id,
        webhookUrl: body.webhookUrl,
        crawlAllPages: true,
        maxPages: body.maxPages,
      });

      res.status(202).json({
        success: true,
        message: `Site crawl queued — will discover and ingest up to ${body.maxPages ?? 50} pages`,
        data: {
          trackingDocumentId: trackingDoc.id,
          status: "PENDING",
          tip: "Each discovered page will be indexed as a separate document. Check GET /documents for progress.",
        },
      });
      return;
    }

    // Single-page ingestion (existing behavior)
    if (body.async) {
      const doc = await upsertForAsyncIngestion(body.url);

      await enqueueIngestion({
        url: body.url,
        documentId: doc.id,
        webhookUrl: body.webhookUrl,
        crawlAllPages: false,
      });

      res.status(202).json({
        success: true,
        message: "Ingestion queued",
        data: { documentId: doc.id, status: "PENDING" },
      });
    } else {
      const result = await ingestUrl(body.url, { crawlAllPages: false });
      res.status(200).json({ success: true, data: result });
    }
  } catch (err) {
    next(err);
  }
}

export async function listDocuments(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { page, limit, status, siteKey, rootOnly }: ListDocumentsDto = listSchema.parse(
      req.query,
    );
    const { documents, total } = await listDocumentsService({
      page,
      limit,
      status,
      siteKey,
      rootOnly,
    });

    res.json({
      success: true,
      data: documents,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

export async function getSiteKeys(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { siteKeys } = await listSiteKeysService();
    res.json({ success: true, data: siteKeys });
  } catch (err) {
    next(err);
  }
}

export async function getDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = req.params.id as string;
    const doc = await getDocumentById(id);
    if (!doc) throw new HttpException(404, "Document not found");
    res.json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
}

export async function deleteDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = req.params.id as string;
    await deleteDocumentById(id);
    res.json({ success: true, message: "Document deleted" });
  } catch (err) {
    next(err);
  }
}

export async function reindexDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = req.params.id as string;
    const doc = await setReindexingAndGetDocument(id);

    await enqueueIngestion({ url: doc.url, documentId: id });

    res.json({
      success: true,
      message: "Re-indexing queued",
      data: { documentId: id },
    });
  } catch (err) {
    next(err);
  }
}
