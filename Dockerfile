# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY schemas ./schemas
COPY web ./web
RUN npx prisma generate && npm run build \
  && npm prune --omit=dev \
  && npm install prisma@6.15.0 --omit=dev --no-save

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Runtime libs for sharp / @napi-rs/canvas / OCR helpers
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    fontconfig \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r bsapp && useradd -r -g bsapp bsapp \
  && mkdir -p /app/uploads /app/data \
  && chown -R bsapp:bsapp /app

COPY --from=build --chown=bsapp:bsapp /app/dist ./dist
COPY --from=build --chown=bsapp:bsapp /app/node_modules ./node_modules
COPY --from=build --chown=bsapp:bsapp /app/package.json ./package.json
COPY --from=build --chown=bsapp:bsapp /app/prisma ./prisma
COPY --from=build --chown=bsapp:bsapp /app/schemas ./schemas
COPY --from=build --chown=bsapp:bsapp /app/web ./web
COPY --chown=bsapp:bsapp scripts/railway-start.mjs ./scripts/railway-start.mjs

USER bsapp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
CMD ["node", "scripts/railway-start.mjs"]
