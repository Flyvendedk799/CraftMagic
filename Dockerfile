# CraftMagic — one image serving the site, the API and the agent WebSocket gateway.
#
# Two stages so the runtime image does not carry the toolchain. The build stage needs dev
# dependencies (typescript, vite) to compile; the runtime stage installs production
# dependencies only.
#
# Node 22 rather than 24: the VPS runs 22, `argon2` is a native module, and matching the
# runtime that has been tested is worth more than a newer major.
#
# There is deliberately no JDK here. The Fabric mod is built separately with Gradle and
# committed to `apps/web/public/mod`, so this image builds without a Java toolchain — adding
# one would roughly quadruple the build for an artifact that changes a few times a year.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first so a dependency install is only redone when dependencies actually change.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# `npm ci` needs the build toolchain: argon2 has no prebuild for every platform and falls
# back to compiling. It is discarded with this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same compilers, same reason — argon2 may build from source here too.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ curl \
 && npm ci --omit=dev --no-audit --no-fund \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Compiled output only. `config.ts` resolves the repo root relative to its own location, so
# this layout has to mirror the source tree even though no sources are present.
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# The spend ledger is the only thing the process writes. Created up front and owned by the
# runtime user, because the first write happens immediately after a paid Anthropic call — the
# worst possible moment to discover the directory is not writable.
RUN mkdir -p /app/.spend && chown -R node:node /app/.spend
USER node

# Overridable, but the default matches what the server itself defaults to.
ENV PORT=3016
EXPOSE 3016

# Reports `database: connected` only when Postgres actually answers, so an orchestrator sees
# a container with a dead database as unhealthy rather than merely running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "apps/server/dist/index.js"]
