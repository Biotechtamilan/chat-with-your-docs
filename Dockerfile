# syntax=docker/dockerfile:1

# ---- dependencies: cached until package files change
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build
FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime
FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATA_DIR=/data

# Run as an unprivileged user; /data holds the database and the embedding model cache.
RUN useradd --system --uid 1001 --create-home app && mkdir /data && chown app:app /data

# node_modules is copied whole: PGlite and the ONNX runtime load files from their
# package folders at run time, so a traced "standalone" output would need care
# to include them. Simplicity over image size here.
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/package.json /app/next.config.ts ./

USER app
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0"]
