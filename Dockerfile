# Declare all ARGs at the top (global scope)
ARG NODE_BASE_IMAGE=node:22
ARG NODE_RUNTIME_IMAGE=node:22-slim

# Stage 1: build
FROM ${NODE_BASE_IMAGE} AS builder
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init
WORKDIR /app

COPY package*.json ./
COPY ./prisma ./prisma
RUN npm install

COPY ./src ./src
COPY ./scripts ./scripts
COPY tsconfig.json .
# tsconfig.scripts.json too, or `npm test` below dies on TS5058 before it runs a single check.
# The check-* scripts ARE this service's test suite and were never typechecked (tsconfig.json
# excludes "scripts", and tsx does no typechecking), so typecheck:scripts was added to the chain
# — and the chain runs here, in the builder, which means a missing file blocks every deploy.
COPY tsconfig.scripts.json .

RUN npx prisma generate

# Verification gate: typecheck plus the hermetic pricing assertions (no network, no DB, no
# credentials). A build that would misprice a line item fails here instead of shipping — the
# pricing invariant is the one thing this service must not get wrong. Credentialed checks
# (check:electrical, check:catalog) stay manual; they need API keys and spend search quota.
RUN npm test

RUN npx tsc
# HTML proposal documents are data, not TypeScript, so tsc leaves them behind — copy them next
# to the compiled module that reads them (__dirname/templates).
RUN mkdir -p dist/copilot/estimating/html/templates \
  && cp src/copilot/estimating/html/templates/*.html dist/copilot/estimating/html/templates/ 2>/dev/null || true

# Stage 2: runtime
FROM ${NODE_RUNTIME_IMAGE}
COPY --from=builder /usr/bin/dumb-init /usr/bin/dumb-init
WORKDIR /app

# curl for ECS health checks; chromium to print HTML proposal documents to PDF.
# puppeteer-core drives THIS binary (see html/htmlToPdf.ts) rather than downloading its own,
# so the browser stays a patchable system package. The font packages matter: without them a
# container renders tofu boxes for anything outside Latin-1, on a customer's proposal.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["dumb-init", "node", "dist/server.js"]