import { Router, type IRouter } from "express";
import {
  ingest,
  listDocuments,
  getSiteKeys,
  getDocument,
  deleteDocument,
  reindexDocument,
  uploadFiles,
} from "@controllers/document.controller";
import { AuthMiddleware } from "@middlewares/auth.middleware";
import { rateLimitByPlan } from "@middlewares/rate-limit.middleware";
import { ValidationMiddleware } from "@middlewares/validation.middleware";
import { ingestSchema } from "@schemas/document.schema";
import { multerUpload } from "@config/multer.config";

const router: IRouter = Router();
const docAuth = [AuthMiddleware, rateLimitByPlan];

router.post("/ingest", ...docAuth, ValidationMiddleware(ingestSchema), ingest);
router.post("/upload", ...docAuth, multerUpload.array("files", 10), uploadFiles);
router.get("/", ...docAuth, listDocuments);
router.get("/site-keys", ...docAuth, getSiteKeys);
router.get("/:id", ...docAuth, getDocument);
router.delete("/:id", ...docAuth, deleteDocument);
router.post("/:id/reindex", ...docAuth, reindexDocument);

export default router;
