# Cutline — one image for the web app, the worker and migrations.
# Debian trixie ships FFmpeg 7.x, which the render pipeline uses.
FROM node:22-trixie-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# Dev dependencies are needed: the build (TypeScript, Tailwind) and tsx (worker, migrations).
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app /app
RUN useradd --create-home --uid 10001 cutline && mkdir -p /data && chown -R cutline /data /app/.next
USER cutline
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
