import { Router, type IRouter } from "express";
import {
  queryHandler,
  queryStreamHandler,
  queryHistory,
} from "@/api/controllers/query.controller";
import { AuthMiddleware } from "@/api/middlewares/auth.middleware";
import { rateLimitByPlan } from "@/api/middlewares/rate-limit.middleware";
import { ValidationMiddleware } from "@/api/middlewares/validation.middleware";
import { querySchema } from "@/api/validators/query.schema";

const router: IRouter = Router();
const docAuth = [AuthMiddleware, rateLimitByPlan];

router.post("/", ...docAuth, ValidationMiddleware(querySchema), queryHandler);
router.post(
  "/stream",
  ...docAuth,
  ValidationMiddleware(querySchema),
  queryStreamHandler,
);
router.get("/history", ...docAuth, queryHistory);

export default router;
