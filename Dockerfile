# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
WORKDIR /app
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 hardware \
  && useradd --system --uid 1001 --gid hardware --home-dir /app hardware

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=builder --chown=hardware:hardware /app/public ./public
COPY --from=builder --chown=hardware:hardware /app/.next/standalone ./
COPY --from=builder --chown=hardware:hardware /app/.next/static ./.next/static
COPY --from=builder --chown=hardware:hardware /app/dist-worker ./dist-worker
COPY --from=builder --chown=hardware:hardware /app/dist-db ./dist-db
COPY --from=builder --chown=hardware:hardware /app/drizzle ./drizzle

RUN mkdir -p /app/.next/cache \
  && chown -R hardware:hardware /app/.next

USER hardware
EXPOSE 3000
CMD ["node", "server.js"]
