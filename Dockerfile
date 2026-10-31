FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY qa/package.json qa/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY qa/package.json qa/package.json
RUN npm ci --omit=dev --omit=optional --workspace @nomad/api --workspace @nomad/shared --include-workspace-root=false

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SERVE_WEB_DIST=true \
    PORT=3001 \
    DATABASE_PATH=/data/nomad.sqlite
RUN mkdir /data && chown node:node /data
COPY --from=dependencies --chown=node:node /app/package.json ./package.json
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=dependencies --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=dependencies --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=dependencies --chown=node:node /app/qa/package.json ./qa/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
USER node
EXPOSE 3001
CMD ["npm", "start"]
