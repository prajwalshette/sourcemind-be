import { Router, type IRouter } from "express";
import { getUsage, dashboardStatsHandler } from "@/api/controllers/query.controller";
import { AuthMiddleware } from "@/api/middlewares/auth.middleware";
import { rateLimitByPlan } from "@/api/middlewares/rate-limit.middleware";

const router: IRouter = Router();
const docAuth = [AuthMiddleware, rateLimitByPlan];

router.get("/", ...docAuth, getUsage);
router.get("/dashboard", ...docAuth, dashboardStatsHandler);

export default router;
