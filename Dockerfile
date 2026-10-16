FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js worker.js ./
COPY lib ./lib
COPY routes ./routes
COPY migrations ./migrations
COPY mcp ./mcp
COPY spec ./spec

# Unprivileged user; all state lives in Postgres, so no volume is needed.
USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# One image, two processes: the web process by default; run the worker
# with `node worker.js` (see docker-compose.yml).
CMD ["node", "server.js"]
