import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import pino from "pino";
import { config } from "@config/env";

// Log environment config
const isProd = config.NODE_ENV === "production";
const logRoot = config.LOG_DIR || "logs";
const logLevel = config.LOG_LEVEL || "info";

// Serverless filesystems (Vercel/AWS Lambda) should not write under `/var/task`.
// Prefer stdout logging there; if a log dir is ever needed, `/tmp` is the only
// generally writable location.
const isServerless = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME,
);

// Create logs folder at the current runtime location (project root)
const projectRoot = process.cwd();
const logDir = isServerless ? join("/tmp", logRoot) : join(projectRoot, logRoot);

// Create log directory (best-effort). Never crash the app if the filesystem is
// read-only (common in serverless).
if (!isServerless) {
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  } catch {
    // fall through: we'll log to stdout only
  }
}

// File logging paths
const prodFile = join(logDir, "app");
const devFile = join(logDir, "app.dev");
const errorFile = join(logDir, "error");

// Pino instance
const transport = isServerless
  ? undefined
  : pino.transport({
      targets: isProd
        ? [
            // prod: daily/size-based rolling + retention (all logs)
            {
              target: "pino-roll",
              level: logLevel,
              options: {
                file: prodFile,
                frequency: "daily", // 'daily' | 'hourly' | number(ms)
                size: "50m",
                dateFormat: "yyyy-MM-dd",
                extension: ".log",
                mkdir: true,
                symlink: true,
                limit: { count: 30 },
              },
            },
            // prod: error-only file
            {
              target: "pino-roll",
              level: "error",
              options: {
                file: errorFile,
                frequency: "daily",
                size: "50m",
                dateFormat: "yyyy-MM-dd",
                extension: ".log",
                mkdir: true,
                symlink: true,
                limit: { count: 60 },
              },
            },
          ]
        : [
            // dev: pretty console output
            {
              target: "pino-pretty",
              level: logLevel,
              options: {
                colorize: true,
                translateTime: "yyyy-mm-dd HH:MM:ss",
                ignore: "pid,hostname",
              },
            },
            // dev: optional file logging
            {
              target: "pino-roll",
              level: logLevel,
              options: {
                file: devFile,
                frequency: "daily",
                size: "20m",
                dateFormat: "yyyy-MM-dd",
                extension: ".log",
                mkdir: true,
                symlink: true,
                limit: { count: 7 },
              },
            },
          ],
    });

// Logger instance
export const logger = pino(
  {
    level: logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    customLevels: {
      http: 35,
    },
    redact: {
      paths: ["req.headers.authorization", "password", "token"],
      censor: "[REDACTED]",
    },
  },
  transport,
);

// morgan stream
export const stream = { write: (msg: string) => logger.info(msg.trim()) };
