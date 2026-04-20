import Redis from "ioredis";
import { config } from "@config/env";
import { logger } from "@utils/logger";

const redisOptions = {
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
  lazyConnect: true,
  connectTimeout: 10_000,
  enableReadyCheck: true,
  keepAlive: 30000,
};

export const redis = new Redis(config.REDIS_URL, {
  ...redisOptions,
});

/** Dedicated connection for BullMQ (requires maxRetriesPerRequest: null for blocking commands). */
export const redisBullMQ = new Redis(config.REDIS_URL, {
  ...redisOptions,
  maxRetriesPerRequest: null,
});

function formatRedisError(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err ? (err as Error & { code?: string }).code : undefined;
    return [err.message, code].filter(Boolean).join(" ") || String(err);
  }
  return String(err);
}

redis.on("connect", () => logger.info("✅ Redis connected"));
redis.on("error", (err) =>
  logger.error({ error: formatRedisError(err) }, "Redis error"),
);
redis.on("reconnecting", () => logger.warn("Redis reconnecting..."));

redisBullMQ.on("error", (err) =>
  logger.error({ error: formatRedisError(err) }, "Redis (BullMQ) error"),
);

export async function connectRedis(): Promise<void> {
  const connectWithWait = async (client: Redis, label: string): Promise<void> => {
    if (client.status === "ready") return;
    if (client.status !== "connecting") {
      try {
        await client.connect();
      } catch (err) {
        const msg = formatRedisError(err).replace(/\.$/, "");
        throw new Error(
          `Redis (${label}): ${msg}. Is Redis running at ${config.REDIS_URL}? (e.g. \`docker compose up -d\` for infra)`,
        );
      }
    }
    if (client.status === "connecting") {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Redis (${label}): connection timeout after 10s. Check ${config.REDIS_URL}`,
            ),
          );
        }, 10_000);
        client.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
        client.once("error", (err) => {
          clearTimeout(timeout);
          const msg = formatRedisError(err).replace(/\.$/, "");
          reject(
            new Error(
              `Redis (${label}): ${msg}. Is Redis running at ${config.REDIS_URL}? (e.g. \`docker compose up -d\` for infra)`,
            ),
          );
        });
      });
    }
    await client.ping();
  };

  await connectWithWait(redis, "main");
  await connectWithWait(redisBullMQ, "BullMQ");
}

// ─── CACHE HELPERS ───────────────────────────────────────────────────────────
export async function getCache<T>(key: string): Promise<T | null> {
  const val = await redis.get(key);
  if (!val) return null;
  try {
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds?: number,
): Promise<void> {
  const ttl = ttlSeconds ?? config.REDIS_TTL_SECONDS;
  await redis.setex(key, ttl, JSON.stringify(value));
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(key);
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

// ─── RATE LIMIT HELPERS ───────────────────────────────────────────────────────
export async function checkRateLimit(
  tenantId: string,
  maxRequests: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now();
  const windowKey = Math.floor(now / windowMs);
  const key = `ratelimit:${tenantId}:${windowKey}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, windowMs * 2);
  }

  const resetAt = (windowKey + 1) * windowMs;
  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetAt,
  };
}
