FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tests ./tests
RUN npm test

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=28461 DATABASE_PATH=/data/notifications.sqlite
COPY --from=verify /app/package.json ./
COPY --from=verify /app/src ./src
# Keep the legacy local database path on the persistent, writable data volume.
RUN mkdir -p /data && chown node:node /data && ln -s /data /app/.local
USER node
EXPOSE 28461
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
 CMD node -e "fetch('http://127.0.0.1:28461/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]
