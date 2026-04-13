import "module-alias/register";
// src/app.ts
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import hpp from "hpp";
import rateLimit from "express-rate-limit";
import { config } from "@config/env";
import { logger } from "@utils/logger";
import routes from "@routes/index";
import { errorHandler, notFoundHandler } from "@middlewares/error.middleware";

const app: Express = express();

// ─── SECURITY ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(hpp());

// CORS
app.use(
  cors({
    origin: config.CORS_ORIGINS.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
    credentials: true,
  }),
);

// Global rate limit (requests per IP)
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  }),
);

// ─── PARSING ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(compression());

// ─── LOGGING ──────────────────────────────────────────────────────────────────
if (config.NODE_ENV !== "test") {
  app.use(
    morgan("combined", {
      stream: { write: (msg) => logger.info(msg.trim()) },
    }),
  );
}

// ─── TRUST PROXY (for production behind nginx/load balancer) ──────────────────
if (config.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use("/api/v1", routes);

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
