// src/config/index.ts
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string(),

  QDRANT_URL: z.string().default("http://localhost:6333"),
  QDRANT_API_KEY: z.string().default(""),
  QDRANT_COLLECTION: z.string().default("url_rag"),

  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_TTL_SECONDS: z.coerce.number().default(3600),

  // Embeddings (required: HF is the only provider right now)
  HF_API_KEY: z.string().min(1, "HF_API_KEY is required for embeddings"),
  HF_EMBED_MODEL: z
    .string()
    .min(1, "HF_EMBED_MODEL is required")
    .default("BAAI/bge-small-en-v1.5"),

  // ─── LLM CHAIN (Tier 1: Gemini) ───────────────────────────────────────────
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3-flash-preview"),
  /** If false, skip Gemini calls during chunking (hypothetical questions). Query-time Gemini still uses GEMINI_API_KEY. */
  GENERATE_HYPOTHETICAL_QUESTIONS: z.preprocess((val) => {
    if (val === undefined || val === null || val === "") return false;
    if (typeof val === "boolean") return val;
    const s = String(val).toLowerCase().trim();
    if (["true", "1", "yes"].includes(s)) return true;
    if (["false", "0", "no"].includes(s)) return false;
    return false;
  }, z.boolean()),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_MODEL: z
    .string()
    .default("openrouter/free"),

  FIRECRAWL_API_KEY: z.string().default(""),
  CRAWL4AI_BASE_URL: z.string().default(""),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("7d"),
  BCRYPT_ROUNDS: z.coerce.number().default(12),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_FREE: z.coerce.number().default(10),
  RATE_LIMIT_MAX_PRO: z.coerce.number().default(100),

  // ─── LANGSMITH ─────────────────────────────────────────────────────────────
  LANGCHAIN_TRACING_V2: z.string().default("false"),
  LANGCHAIN_API_KEY: z.string().default(''),
  LANGCHAIN_PROJECT: z.string().default('url-rag-production'),
  LANGCHAIN_ENDPOINT: z.string().default('https://api.smith.langchain.com'),

  // Website RAG-friendly defaults (guide: smaller chunks + ~10% overlap)
  CHUNK_SIZE: z.coerce.number().default(512),
  CHUNK_OVERLAP: z.coerce.number().default(50),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  LOG_DIR: z.string().default("logs"),
  LOG_LEVEL: z.string().default("info"),

  GROQ_API_KEY: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`❌ Invalid environment variables:\n${parsed.error.issues.map(err => `   ${err.path.join(".")}: ${err.message}`).join("\n")}`);
}

export const config = parsed.data;


export const isProduction = config.NODE_ENV === "production";
export const isDevelopment = config.NODE_ENV === "development";
