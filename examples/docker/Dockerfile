# Build context is the MONOREPO ROOT, not this directory.
#   docker compose up --build          (context is set in docker-compose.yml)
#   docker build -f examples/docker/Dockerfile -t celsian-api ../..

# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# The whole workspace is copied because pnpm needs every workspace member
# listed in pnpm-lock.yaml to resolve a frozen install. Dockerfile.dockerignore
# keeps node_modules and build output out of the context.
COPY . .

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm install --frozen-lockfile

# @celsian/core and @celsian/schema publish from dist/, so they must be
# compiled before esbuild can bundle the example against them.
RUN pnpm --filter @celsian/core build

# Bundle the example into a single file
WORKDIR /app/examples/docker
RUN node build.mjs

# Stage 2: Run
FROM node:22-slim AS runner
WORKDIR /app

# Copy only the built output
COPY --from=builder /app/examples/docker/dist/index.js ./index.js

# Non-root user
RUN addgroup --system app && adduser --system --ingroup app app
USER app

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "index.js"]
