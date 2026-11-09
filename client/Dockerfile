FROM node:22-alpine AS build

WORKDIR /src

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN node tools/optimize.mjs
RUN node tools/build.mjs --out /dist

FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx/templates /etc/nginx/templates
COPY nginx/snippets /etc/nginx/snippets
COPY --from=build /dist /usr/share/nginx/html

ENV API_UPSTREAM=api:8000 \
    WS_UPSTREAM=socket:8001 \
    DNS_RESOLVER=127.0.0.11 \
    CSP_CONNECT_SRC="'self' ws: wss:" \
    CSP_REMOTE_SRC=""

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
