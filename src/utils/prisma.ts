import { PrismaClient } from "@generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "@utils/logger";
import { config } from "@config/env";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });

type PrismaLogEvent = { message: string };
(prisma as { $on(event: string, cb: (e: PrismaLogEvent) => void): void }).$on(
  "error",
  (e) => logger.error({ message: e.message }, "Prisma error"),
);
(prisma as { $on(event: string, cb: (e: PrismaLogEvent) => void): void }).$on(
  "warn",
  (e) => logger.warn({ message: e.message }, "Prisma warning"),
);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info("✅ Database connected");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Database disconnected");
}
