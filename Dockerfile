# syntax=docker/dockerfile:1

# Node 24 is current LTS and matches the `--target node24` that `pnpm build:server` uses.
ARG NODE_VERSION=24-alpine

# ── deps ─────────────────────────────────────────────────────────────────────
# Full install, dev dependencies included, for the build stage. pnpm-workspace.yaml is
# not optional: it carries `minimumReleaseAgeExclude`, without which install fails with
# ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── prod-deps ────────────────────────────────────────────────────────────────
# Runtime dependencies only, installed INSIDE Alpine. This is the stage that makes the
# libSQL native binding resolve to its musl variant; a node_modules built on a glibc host
# produces a container that dies at createClient().
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# Mutations shell out to `docker compose` (local-host.ts:508). dockerode talks to the
# socket over HTTP and does not replace the CLI.
RUN apk add --no-cache docker-cli docker-cli-compose

ENV NODE_ENV=production
ENV PORT=3000

# Every one of these paths is resolved against process.cwd(), so WORKDIR and this copy
# list have to agree or the defaults point at nothing:
#   ./data/homestead.db   config.ts:13
#   ./data/icons          config.ts:28
#   ./drizzle             db/client.ts:19 — migrations, and they live at the repo root,
#                         outside dist/
#   dist/web              routes/spa.ts:7 — and spa.ts only warns when it is missing, so
#                         getting this wrong produces a silent 404 rather than a crash
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Runs as root deliberately: /var/run/docker.sock is root-equivalent by construction, so a
# non-root user that must still reach it buys no isolation and adds uid/gid matching
# across NAS models.

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
