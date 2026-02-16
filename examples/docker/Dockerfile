# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Copy monorepo files needed for build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/schema/ packages/schema/
COPY examples/docker/ examples/docker/

# Install pnpm and dependencies
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm install --frozen-lockfile

# Build the example
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
