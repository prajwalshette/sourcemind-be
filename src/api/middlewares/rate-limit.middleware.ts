// src/middlewares/rate-limit.middleware.ts
import { Request, Response, NextFunction } from "express";
import { checkRateLimit } from "@/infrastructure/database/redis.client";
import { config } from "@config/env";

const DEFAULT_LIMIT = config.RATE_LIMIT_MAX_FREE;

export function rateLimitByPlan(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    const userId = req.user.userId;
    const maxRequests = DEFAULT_LIMIT;

    const { allowed, remaining, resetAt } = await checkRateLimit(
      userId,
      maxRequests,
      config.RATE_LIMIT_WINDOW_MS,
    );

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", Math.floor(resetAt / 1000));

    if (!allowed) {
      res.status(429).json({
        success: false,
        message: "Rate limit exceeded",
        retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
      });
      return;
    }

    next();
  })();
}
