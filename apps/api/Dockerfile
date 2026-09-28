# NeerNow API image. Red Hat UBI base; runs as a non-root user and works with
# OpenShift's random user IDs (restricted-v2 SCC).
FROM registry.access.redhat.com/ubi9/nodejs-22 AS build
USER 0
WORKDIR /opt/app-root/src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM registry.access.redhat.com/ubi9/nodejs-22-minimal
WORKDIR /opt/app-root/src
ENV NODE_ENV=production PORT=3001 NO_COLOR=1
COPY --from=build --chown=1001:0 /opt/app-root/src/node_modules ./node_modules
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
COPY --chown=1001:0 package.json ./
COPY --chown=1001:0 migrations ./migrations
COPY --chown=1001:0 seeds ./seeds
USER 1001
EXPOSE 3001
CMD ["node", "dist/main.js"]
