import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "@config/env";
import { HttpException } from "@exceptions/httpException";

import { JwtPayload } from "@interfaces/auth.interface";
import "@interfaces/request.interface";

// ─── JWT AUTH ─────────────────────────────────────────────────────────────────
export const AuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      throw new HttpException(401, "Missing or invalid authorization header");
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
      req.user = payload;
      next();
    } catch (err) {
      if ((err as Error).name === "TokenExpiredError") {
        throw new HttpException(401, "Token expired");
      } else {
        throw new HttpException(401, "Invalid token");
      }
    }
  } catch (error) {
    next(error);
  }
};

// ─── ROLE GUARD ───────────────────────────────────────────────────────────────
export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpException(403, "Insufficient permissions"));
    }
    next();
  };
};
