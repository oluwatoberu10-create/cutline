# Cutline

A multi-client platform for building, exporting and deploying AI YouTube content agents.

Configure an agent once — instructions, workflows, editing rules, render presets, SEO rules,
approval gates — publish it as a versioned **blueprint**, then deploy it to any number of
creators. Each creator gets an isolated workspace with their own YouTube account, AI keys,
storage, footage, analytics and job history.

Three modules, each optional per client:

1. **Channel intelligence & ideation** — YouTube Data/Analytics sync, measured findings,
   labelled AI hypotheses, grounded content ideas, a feedback loop and a calendar.
2. **Raw-footage editor** — chunked/resumable uploads, transcription, measured pause /
   filler / repeated-take detection, AI highlights, a non-destructive edit-decision list,
   and real FFmpeg rendering (captions, logo, intro/outro, lower thirds, loudness, noise
   reduction, vertical/square reframing, Shorts).
3. **Publishing & SEO** — transcript-grounded metadata, editable in full, approval-based
   (default), manual or authorised rule-based publishing via resumable YouTube uploads.

## Quick start (local)

Requirements: Node 22+, FFmpeg/FFprobe on PATH. PostgreSQL is embedded for development.

```bash
npm install
npm run dev          # starts Postgres, migrates, starts Next.js and a worker; creates local secrets
# open http://localhost:3000 → /setup creates the agency and first admin
```

Then: Agency → Agent templates → New template → Publish a version → Deploy → follow the wizard.
Add API keys (Anthropic/OpenAI/Deepgram) under Integrations and Google OAuth credentials in
`.env.local` to use the AI and YouTube features (see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run preview` | Development / optimised local run (includes a worker) |
| `npm run build && npm start` | Production web server |
| `npm run worker` | Background worker (run ≥ 1 in production) |
| `npm run db:migrate` | Apply migrations (safe in production) |
| `npm run admin:create -- --org … --email … --name …` | Headless first admin |
| `npm run blueprint:validate -- file.zip` | Validate a blueprint without a database |
| `npm run blueprint:import -- file.zip [--yes]` | Import a blueprint from the command line |
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests (real Postgres + FFmpeg, mock AI/YouTube) |
| `npm run build && npm run test:e2e` | HTTP end-to-end test against the production build |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Blueprint format](docs/BLUEPRINTS.md) · [sample blueprint](docs/sample-blueprint.json)
- [Deploying an agent for a new client](docs/NEW_CLIENT_GUIDE.md)
- [Production deployment](docs/DEPLOYMENT.md)
- [External services, credentials, permissions and costs](docs/INTEGRATIONS.md)
- [Requirements checklist & status](docs/CHECKLIST.md)
- API reference: `/docs/api` in the app, OpenAPI at `/api/v1/openapi.json`
