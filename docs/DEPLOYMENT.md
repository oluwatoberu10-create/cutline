# Production deployment

Cutline needs four things: the **web app**, at least one **worker**, **PostgreSQL 15+**, and
**FFmpeg 6+/FFprobe** available to the worker (and the web app, for health checks). Media is
stored on local disk (single host) or any S3-compatible bucket.

> Claude Code was used to build this; it is not a hosting environment. Run Cutline on a server,
> container platform or VM you control.

## Option A — Docker Compose (single host)

```bash
cp .env.example .env        # set APP_URL, POSTGRES_PASSWORD, CUTLINE_ENCRYPTION_KEY, CUTLINE_SIGNING_SECRET, Google + AI keys
docker compose up -d --build
docker compose exec web npm run admin:create -- --org "Agency" --email <you> --name "<You>"
```

Put a TLS-terminating reverse proxy (Caddy, nginx, a load balancer) in front of port 3000 and set
`APP_URL` to the public `https://` origin. *The Dockerfile and compose file were written for this
project but have not been run in this environment (Docker is not installed here); build and smoke-test
them before relying on them.*

## Option B — any Node host

```bash
npm ci && npm run build
npm run db:migrate
npm start            # web (PORT, default 3000)
npm run worker       # one or more workers (WORKER_CONCURRENCY jobs each)
```

Serverless platforms can host the web app, but the worker must run somewhere long-lived with
FFmpeg (renders and uploads run for minutes). Shared storage (S3) is required when web and
workers are on different machines.

## Required configuration

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `APP_URL` | Public origin; used for OAuth redirects |
| `CUTLINE_ENCRYPTION_KEY` | 32 bytes base64. Encrypts tokens/keys. **Back it up**: losing it makes stored credentials unreadable (clients must reconnect). |
| `CUTLINE_SIGNING_SECRET` | ≥ 32 chars; signs short-lived media URLs |
| `STORAGE_DRIVER` | `local` (+ `LOCAL_STORAGE_DIR`) or `s3` (+ `S3_*`) |

See [INTEGRATIONS.md](INTEGRATIONS.md) for Google OAuth and AI providers.

## Verify a deployment

1. `GET /api/health` → `{"ok":true}` with database, ffmpeg, ffprobe, keys all `true`.
2. Sign in, Agency → Integrations shows each installation capability as *ready*.
3. Create a test workspace, upload a short clip: it reaches *Ready* within a minute (worker + FFmpeg).
4. Deploy wizard step 7 (*Test*) passes for a real client.

## Operations

- Migrations are forward-only and safe to re-run (`npm run db:migrate`).
- Retention runs daily in the worker (per-workspace `renderDays` / `sourceDays`).
- Failed jobs: Agency → Workflow runs → Background jobs; retry or inspect logs per job.
- Back up PostgreSQL and the media storage together.
