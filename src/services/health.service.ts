// src/services/health.service.ts
// Health check operations (e.g. database ping)

import { prisma } from "@utils/prisma";

/** Ping database; returns "ok" or "fail". */
export async function checkDatabase(): Promise<"ok" | "fail"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "fail";
  }
}
