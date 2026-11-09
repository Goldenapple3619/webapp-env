FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app && mkdir -p /mnt/system && chown app:app /mnt/system
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER app
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=3 CMD wget -qO- http://127.0.0.1:8000/api/health >/dev/null || exit 1
CMD ["node", "index.js"]
