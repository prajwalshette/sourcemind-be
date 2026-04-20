import { Router, type IRouter } from "express";
import authRoutes from "./auth.route";
import documentRoutes from "./document.route";
import queryRoutes from "./query.route";
import usageRoutes from "./usage.route";
import healthRoutes from "./health.route";
import feedbackRoutes from "./feedback.route";
import sessionRoutes from "./session.route";

const router: IRouter = Router();

// ─── ROUTES ──────────────────────────────────────────────────────────────────
router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/documents", documentRoutes);
router.use("/query", queryRoutes);
router.use("/sessions", sessionRoutes);
router.use("/usage", usageRoutes);
router.use("/feedback", feedbackRoutes);

export default router;
