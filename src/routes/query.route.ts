import { Router, type IRouter } from "express";
import {
  queryHandler,
  queryStreamHandler,
  queryHistory,
} from "@controllers/query.controller";
import { AuthMiddleware } from "@middlewares/auth.middleware";
import { rateLimitByPlan } from "@middlewares/rate-limit.middleware";
import { ValidationMiddleware } from "@middlewares/validation.middleware";
import { querySchema } from "@schemas/query.schema";

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
