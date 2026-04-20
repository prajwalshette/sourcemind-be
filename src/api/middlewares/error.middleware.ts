import { Request, Response, NextFunction } from "express";
import { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";
import { ZodError } from "zod";
import { config } from "@config/env";
import { HttpException } from "@/core/exceptions/httpException";
import { logger } from "@utils/logger";

type ValidationIssue = { path: string; message: string };
type HttpExceptionWithData = HttpException & { data?: unknown };
type WithStack = { stack?: string };

interface ErrorDetails {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}
interface ErrorResponseBody {
  success: false;
  error: ErrorDetails;
}

/** Type guards */
const isZodError = (e: unknown): e is ZodError => {
  return e instanceof ZodError;
};

/** jsonwebtoken may have class boundary issues at runtime, so name-based guards are preferred */
const isTokenExpiredError = (e: unknown): e is TokenExpiredError => {
  return e instanceof Error && (e as any).name === "TokenExpiredError";
};
const isJsonWebTokenError = (e: unknown): e is JsonWebTokenError => {
  return e instanceof Error && (e as any).name === "JsonWebTokenError";
};

const toHttpException = (err: unknown): HttpException => {
  if (err instanceof HttpException) return err;

  if (isZodError(err)) {
    const data: ValidationIssue[] = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return new HttpException(400, "Validation failed", data);
  }

  if (isTokenExpiredError(err)) return new HttpException(401, "Token expired");
  if (isJsonWebTokenError(err)) return new HttpException(401, "Invalid token");

  const e = err as Error | undefined;
  return new HttpException(500, e?.message || "Internal Server Error");
};

const extractStack = (err: unknown): string | undefined => {
  if (err && typeof err === "object" && "stack" in err) {
    const s = (err as WithStack).stack;
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
};

export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const httpErr = toHttpException(error);
  const status = httpErr.status || 500;
  const message = httpErr.message || "Something went wrong";

  if (res.headersSent) return _next(httpErr);

  const stack = extractStack(httpErr);
  logger.error(
    `[${req.method}] ${req.originalUrl} | ${status} | ${message}${
      stack ? `\n${stack}` : ""
    }`,
  );

  const body: ErrorResponseBody = {
    success: false,
    error: { code: status, message },
  };

  const maybeData = (httpErr as HttpExceptionWithData).data;
  if (typeof maybeData !== "undefined") body.error.data = maybeData;
  if (config.NODE_ENV === "development" && stack) body.error.stack = stack;

  res.status(status).json(body);
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const message = `Route ${req.method} ${req.originalUrl} not found`;
  logger.warn(message);
  res.status(404).json({
    success: false,
    error: { code: 404, message },
  });
};
