import { Router, type IRouter } from "express";
import {
  createSessionHandler,
  listSessionsHandler,
  getSessionHandler,
  updateSessionHandler,
  deleteSessionHandler,
} from "@/api/controllers/session.controller";
import { AuthMiddleware } from "@/api/middlewares/auth.middleware";
import { rateLimitByPlan } from "@/api/middlewares/rate-limit.middleware";

const router: IRouter = Router();
const auth = [AuthMiddleware, rateLimitByPlan];

router.post("/", ...auth, createSessionHandler);
router.get("/", ...auth, listSessionsHandler);
router.get("/:id", ...auth, getSessionHandler);
router.patch("/:id", ...auth, updateSessionHandler);
router.delete("/:id", ...auth, deleteSessionHandler);

export default router;

