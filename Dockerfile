# Build stage (uses pnpm to match repo lockfile)
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec prisma generate
RUN pnpm run build

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 appuser

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
# Prisma client is generated to src/generated/prisma (custom output); Node resolves @generated/prisma via node_modules
COPY --from=builder /app/src/generated/prisma ./node_modules/@generated/prisma
COPY prisma ./prisma
# Prisma CLI needed for migrate deploy (devDep in package.json)
RUN pnpm add prisma@^7.4.2

# Create logs directory; give appuser ownership of /app so prisma migrate deploy can write at runtime
RUN mkdir -p logs && chown -R appuser:nodejs /app

USER appuser

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
