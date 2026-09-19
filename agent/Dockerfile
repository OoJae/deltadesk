# DeltaDesk agent image: one image, two services.
#
#   desk-agent  the tick loop + HTTP (/health, the Dynamic webhook, the web API). Needs a volume at
#               /data (SQLite: decisions, executions, signed bytes, the vault's sealed rows).
#   watchdog    the guardian-only watchdog (pause / exitAll). No volume, never the operator's secrets.
#
# Build context: agent/ (standalone pnpm package; no build step, TypeScript runs through tsx).
#   docker build -t deltadesk-agent agent/                       # default target: desk-agent
#   docker build --target watchdog -t deltadesk-watchdog agent/
# Or run either service from the default image with DESK_SERVICE=desk-agent|watchdog (Railway: one
# image, a different variable per service). One-off scripts: override the command, e.g.
#   docker run --rm -v desk-data:/data deltadesk-agent node --import tsx scripts/status.ts
#   docker run --rm --platform linux/amd64 deltadesk-agent node scripts/native-check.mjs

# Node 26 on Debian bookworm slim (glibc 2.36). Never alpine/musl: the Dynamic MPC addon ships
# glibc builds only (libmpc_executor_linux_{x86_64,arm64}_nodejs.node).
ARG NODE_VERSION=26

# ---- dependencies (native addons: better-sqlite3 and the Dynamic MPC addon, glibc) -------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.1.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The full install keeps tsx (the runtime loader). Only the allowlisted packages run build scripts.
RUN CI=true pnpm install --frozen-lockfile
# Fail the build, not the boot, if a native addon did not land for this platform: load AND exercise
# better-sqlite3 and the Dynamic MPC addon (offline), and list every .node file mapped.
COPY scripts/native-check.mjs ./scripts/native-check.mjs
RUN node scripts/native-check.mjs

# ---- runtime ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DESK_DB_PATH=/data/desk.sqlite \
    DESK_APPROVAL_DIR=/data/approvals
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# Again in the runtime image (no build toolchain here): the addons must load where they will run.
RUN node scripts/native-check.mjs
# `node --import tsx` (not the tsx CLI): signals reach the process that drains the tick and
# releases the daemon lock.
# Railway (and most hosts) mount volumes root-owned: start as root only to hand /data to `node`,
# then drop privileges with setpriv (util-linux) before the service runs. Never runs the agent as root.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'if [ "$(id -u)" = "0" ]; then' \
    '  mkdir -p /data/approvals && chown -R node:node /data' \
    '  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"' \
    'fi' \
    'case "${DESK_SERVICE:-desk-agent}" in' \
    '  desk-agent) exec node --import tsx src/main.ts ;;' \
    '  watchdog) exec node --import tsx src/watchdog/main.ts ;;' \
    '  *) echo "DESK_SERVICE must be desk-agent or watchdog, got ${DESK_SERVICE}" >&2; exit 64 ;;' \
    'esac' > /usr/local/bin/desk-service \
  && chmod 755 /usr/local/bin/desk-service \
  && mkdir -p /data \
  && chown node:node /data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["desk-service"]

# ---- the guardian watchdog -----------------------------------------------------------------------
FROM runtime AS watchdog
ENV DESK_SERVICE=watchdog

# ---- the desk agent (default target) ------------------------------------------------------------
FROM runtime AS desk-agent
ENV DESK_SERVICE=desk-agent PORT=8080
EXPOSE 8080
# /health is public and always 200; `ok` is false until the loop ticks and holds the lock.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(h=>process.exit(h.ok?0:1),()=>process.exit(1))"
