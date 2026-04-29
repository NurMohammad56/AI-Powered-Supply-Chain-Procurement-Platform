# syntax=docker/dockerfile:1.7
# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++ \
    && corepack enable

COPY package.json ./
COPY tsconfig*.json ./
RUN npm install --include=dev

COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeapp -u 1001 -G nodejs

WORKDIR /app

COPY --from=build --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/package.json ./package.json

USER nodeapp

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
