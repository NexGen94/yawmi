# Yawmi web image: build the Preact PWA, serve dist/ with nginx on 8080 as a non-root user.
# Build from this folder:  docker build -t ghcr.io/nexgen94/yawmi-web:<version> web
FROM node:24.19.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install script runs in the build (supply-chain hardening).
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && node scripts/check-budget.mjs

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
