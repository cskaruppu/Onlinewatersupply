# NeerNow web image (Next.js standalone server). Red Hat UBI base; non-root.
FROM registry.access.redhat.com/ubi9/nodejs-22 AS build
USER 0
WORKDIR /opt/app-root/src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM registry.access.redhat.com/ubi9/nodejs-22-minimal
WORKDIR /opt/app-root/src
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=1001:0 /opt/app-root/src/.next/standalone ./
COPY --from=build --chown=1001:0 /opt/app-root/src/.next/static ./.next/static
COPY --from=build --chown=1001:0 /opt/app-root/src/public ./public
# Next.js writes a cache at runtime; OpenShift runs with a random UID in group 0.
USER 0
RUN mkdir -p .next/cache && chmod -R g=u .next
USER 1001
EXPOSE 3000
CMD ["node", "server.js"]
