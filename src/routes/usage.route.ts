import { Router, type IRouter } from "express";
import { getUsage } from "@controllers/query.controller";
import { AuthMiddleware } from "@middlewares/auth.middleware";
import { rateLimitByPlan } from "@middlewares/rate-limit.middleware";

const router: IRouter = Router();
const docAuth = [AuthMiddleware, rateLimitByPlan];

router.get("/", ...docAuth, getUsage);

export default router;
