FROM oven/bun:1.4.4-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY container ./container
WORKDIR /app/container
EXPOSE 12000
CMD ["bun", "run", "server.ts"]
