# syntax=docker/dockerfile:1
# linux/amd64 image for Sealos App Launchpad (Singapore).
# Build: docker build --platform linux/amd64 -t podcast-together:local .

FROM --platform=linux/amd64 node:20-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM --platform=linux/amd64 node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    PT_STATIC_DIR=/app/dist

RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY local-server ./local-server

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "local-server/index.mjs"]
