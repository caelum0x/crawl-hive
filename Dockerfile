# CrawlHive: одна стадия — next start читает next.config.ts, поэтому нужны и dev-зависимости.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Потолок памяти сборки: на общем сервере без него next build съедал всё и ронял соседей (OOM 21.10).
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# Без root: процесс работает от uid 1001 — тот же владелец, что у ./data на хосте.
RUN groupadd -g 1001 app && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin app && chmod -R a+rX /app && chown -R 1001:1001 /app/.next
USER 1001
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
