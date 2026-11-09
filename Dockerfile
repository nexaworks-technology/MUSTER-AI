# Multi-stage production Dockerfile for NexaWorks CSM (SF-4)
# Packages the Next.js 16 production web application and background worker.

# ------------------------------------------------------------------------------
# Stage 1: Base image with pnpm and system compatibility libraries
# ------------------------------------------------------------------------------
FROM node:22-alpine AS base

RUN apk add --no-cache libc6-compat openssl
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

WORKDIR /app

# ------------------------------------------------------------------------------
# Stage 2: Install dependencies
# ------------------------------------------------------------------------------
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma/

RUN pnpm install --frozen-lockfile

# ------------------------------------------------------------------------------
# Stage 3: Build application
# ------------------------------------------------------------------------------
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client and compile Next.js production build
# The typecheck of this codebase exceeds Node's default ~2 GB heap.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm db:generate
RUN pnpm build

# ------------------------------------------------------------------------------
# Stage 4: Production Runner (Non-root user)
# ------------------------------------------------------------------------------
FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

# scripts/deploy-release.sh is a bash script; Alpine ships only busybox sh.
RUN apk add --no-cache bash

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

WORKDIR /app

# Copy runtime application assets and dependencies
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/docker ./docker
# AI prompts are loaded from ./prompts at runtime (src/lib/ai/prompts.ts).
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/next.config.ts ./next.config.ts
# tsx (worker, scripts) resolves the "@/" alias from tsconfig.json at runtime.
COPY --from=builder /app/tsconfig.json ./tsconfig.json

RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

# Default command starts the Next.js production web server.
# Overridden in docker-compose.yml for the background worker container.
CMD ["pnpm", "start"]
