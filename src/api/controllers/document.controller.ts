import { Request, Response, NextFunction } from "express";
import { enqueueIngestion, enqueueFileIngestion } from "@/infrastructure/queue/ingestion.queue";
import { ingestUrl } from "@/core/services/pipelines/ingestion.pipeline";
import { crawlSite } from "@/core/services/ingestion/site-crawler.service";
import {
  upsertForAsyncIngestion,
  listDocuments as listDocumentsService,
  listSources as listSourcesService,
  getDocumentById,
  deleteDocumentById,
  setReindexingAndGetDocument,
} from "../../core/services/ingestion/document.service";
import { ingestSchema, listSchema } from "@/api/validators/document.schema";
import { IngestDto, ListDocumentsDto } from "@/api/validators/document.dto";
import { HttpException } from "@/core/exceptions/httpException";
import { prisma } from "@/infrastructure/database/prisma.client";
import { MIME_TO_FILE_TYPE } from "@config/multer.config";
import { hashText } from "@utils/sanitize";
import { DocumentStatus, FileType, SourceType } from "@generated/prisma";

export async function ingestWebsite(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body: IngestDto = ingestSchema.parse(req.body);
    const userId = req.user.userId;

    // Multi-page site crawl: always async, handled via site-crawler
    if (body.crawlAllPages) {
      const trackingDoc = await upsertForAsyncIngestion(body.url, userId);

      await enqueueIngestion({
        url: body.url,
        documentId: trackingDoc.id,
        webhookUrl: body.webhookUrl,
        crawlAllPages: true,
        maxPages: body.maxPages,
        uploadedBy: userId,
      });

      res.status(202).json({
        success: true,
        message: `Site crawl queued — will discover and ingest up to ${body.maxPages ?? 50} pages`,
        data: {
          trackingDocumentId: trackingDoc.id,
          status: DocumentStatus.PENDING,
          tip: "Each discovered page will be indexed as a separate document. Check GET /documents for progress.",
        },
      });
      return;
    }

    // Single-page ingestion (existing behavior)
    if (body.async) {
      const doc = await upsertForAsyncIngestion(body.url, userId);

      await enqueueIngestion({
        url: body.url,
        documentId: doc.id,
        webhookUrl: body.webhookUrl,
        crawlAllPages: false,
        uploadedBy: userId,
      });

      res.status(202).json({
        success: true,
        message: "Ingestion queued",
        data: { documentId: doc.id, status: DocumentStatus.PENDING },
      });
    } else {
      const result = await ingestUrl(body.url, { crawlAllPages: false, uploadedBy: userId });
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
    const userId = req.user.userId;
    const { documents, total } = await listDocumentsService({
      page,
      limit,
      status,
      siteKey,
      rootOnly,
      userId,
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

export async function getSources(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.user.userId;
    const { sources } = await listSourcesService({ userId });
    res.json({ success: true, data: sources });
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
    const userId = req.user.userId;
    const doc = await getDocumentById(id, userId);
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
    const userId = req.user.userId;
    await deleteDocumentById(id, userId);
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
    const userId = req.user.userId;
    const doc = await setReindexingAndGetDocument(id, userId);

    await enqueueIngestion({ url: doc.url, documentId: id, uploadedBy: userId });

    res.json({
      success: true,
      message: "Re-indexing queued",
      data: { documentId: id },
    });
  } catch (err) {
    next(err);
  }
}

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────
export async function ingestFiles(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      throw new HttpException(400, 'No files provided. Send at least one file in the "files" field.');
    }

    const uploadedBy = req.user.userId;
    const results: Array<{ documentId: string; fileName: string; status: DocumentStatus }> = [];

    for (const file of files) {
      const fileType: FileType = MIME_TO_FILE_TYPE[file.mimetype] ?? FileType.OTHER;

      // Use a stable dedup key: sha256("file::<originalname>::<size>")
      const urlHash = hashText(`file::${file.originalname}::${file.size}::${uploadedBy}`);

      // Create / upsert the Document record
      const doc = await prisma.document.upsert({
        where: { urlHash },
        create: {
          url: `file://${urlHash}`,
          urlHash,
          title: file.originalname,
          sourceType: SourceType.FILE,
          fileName: file.originalname,
          fileType,
          mimeType: file.mimetype,
          fileSize: file.size,
          status: DocumentStatus.PENDING,
          uploadedBy,
        },
        update: {
          status: DocumentStatus.PENDING,
          errorMessage: null,
          fileSize: file.size,
          title: file.originalname,
        },
      });

      // Queue the file for background processing
      await enqueueFileIngestion({
        documentId: doc.id,
        bufferBase64: file.buffer.toString('base64'),
        mimeType: file.mimetype,
        fileName: file.originalname,
        uploadedBy,
      });

      results.push({ documentId: doc.id, fileName: file.originalname, status: DocumentStatus.PENDING });
    }

    res.status(202).json({
      success: true,
      message: `${results.length} file(s) queued for ingestion`,
      data: results,
    });
  } catch (err) {
    next(err);
  }
}
