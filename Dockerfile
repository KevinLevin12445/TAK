FROM node:20-slim AS base
RUN npm install -g pnpm@latest

# ─── BUILD STAGE ─────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./

# Copy all packages
COPY lib/ ./lib/
COPY artifacts/ ./artifacts/

# Install all deps
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build backend
RUN pnpm --filter @workspace/api-server build

# Build frontend
RUN pnpm --filter @workspace/ak-terminal build

# ─── FINAL IMAGE ─────────────────────────────────────────────
FROM node:20-slim
RUN npm install -g pnpm@latest
WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/api-server ./artifacts/api-server

# Install production deps only
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Copy built backend
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

# Copy built frontend as static files served by backend
COPY --from=builder /app/artifacts/ak-terminal/dist ./public

EXPOSE 3000

ENV PORT=3000

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
