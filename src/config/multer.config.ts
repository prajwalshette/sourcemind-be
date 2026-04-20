// src/config/multer.config.ts
import multer from 'multer';
import { HttpException } from '@/core/exceptions/httpException';
import { FileType } from "@generated/prisma";

// ─── Allowed MIME types → FileType enum value ────────────────────────────────
export const MIME_TO_FILE_TYPE: Record<string, FileType> = {
  'application/pdf': FileType.PDF,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': FileType.DOCX,
  'text/csv': FileType.CSV,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FileType.XLSX,
  'text/plain': FileType.TXT,
  'text/markdown': FileType.MD,
  'text/x-markdown': FileType.MD,
};

export const ALLOWED_MIMES = new Set(Object.keys(MIME_TO_FILE_TYPE));

// ─── Multer instance ─────────────────────────────────────────────────────────
export const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB per file
    files: 10,                   // max 10 files per request
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new HttpException(
          400,
          `Unsupported file type: "${file.mimetype}". Allowed: PDF, DOCX, CSV, XLSX, TXT, MD`,
        ),
      );
    }
  },
});
