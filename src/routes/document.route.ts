import { Router, type IRouter } from "express";
import {
  ingestWebsite,
  listDocuments,
  getSources,
  getDocument,
  deleteDocument,
  reindexDocument,
  ingestFiles,
} from "@controllers/document.controller";
import { AuthMiddleware } from "@middlewares/auth.middleware";
import { ValidationMiddleware } from "@middlewares/validation.middleware";
import { ingestSchema } from "@schemas/document.schema";
import { multerUpload } from "@config/multer.config";

const router: IRouter = Router();
const docAuth = [AuthMiddleware];

router.post(
  "/ingest-website",
  ...docAuth,
  ValidationMiddleware(ingestSchema),
  ingestWebsite
);
router.post(
  "/ingest-files",
  ...docAuth,
  multerUpload.array("files", 10),
  ingestFiles
);
router.get("/", ...docAuth, listDocuments);
router.get("/sources", ...docAuth, getSources);
router.get("/:id", ...docAuth, getDocument);
router.delete("/:id", ...docAuth, deleteDocument);
router.post("/:id/reindex", ...docAuth, reindexDocument);

export default router;
