FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sync-protocol/package.json packages/sync-protocol/
COPY packages/sync-local/package.json packages/sync-local/
COPY apps/sync-server/package.json apps/sync-server/
RUN npm ci --ignore-scripts --workspace @lionpocket/core --workspace @lionpocket/sync-protocol --workspace @lionpocket/sync-local --workspace @lionpocket/sync-server --include-workspace-root
COPY packages/core packages/core
COPY packages/sync-protocol packages/sync-protocol
COPY packages/sync-local packages/sync-local
COPY apps/sync-server apps/sync-server
RUN npm run build:core
USER node
CMD ["npm","run","start","--workspace","@lionpocket/sync-server"]
