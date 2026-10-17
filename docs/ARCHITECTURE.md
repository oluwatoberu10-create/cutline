# Architecture

```
Browser ──► Next.js (App Router, server components + server actions)
              │   /api/v1/*  documented REST API (registry → OpenAPI)
              │   /api/media/* signed, Range-capable media streaming
              ▼
         Domain services (src/server/services)  ◄── tenancy guard (src/server/tenancy.ts)
              │            │                │
   PostgreSQL (Drizzle)   Job queue (Postgres, SKIP LOCKED + leases)   Storage driver (local | S3 | client S3)
                                 │
                       Worker process (npm run worker)
                         ├─ workflow engine (DAG, approvals, retries)
                         ├─ FFmpeg/FFprobe (probe, silencedetect, proxies, staged renders)
                         └─ provider adapters: Anthropic SDK · OpenAI · Deepgram · YouTube Data v3 / Analytics v2
```

| Layer | Location |
|---|---|
| Pure domain logic (blueprint format, workflow DSL, EDL, render planning, metadata rules) | `src/lib` — unit tested, no I/O |
| Persistence & migrations | `src/db/schema.ts`, `drizzle/` |
| Authorization & tenant isolation | `src/server/auth.ts`, `src/server/tenancy.ts` |
| Services (one per domain) | `src/server/services/*` |
| Workflow engine & node executors | `src/server/workflow/*` |
| Jobs & worker | `src/server/jobs/*`, `scripts/worker.ts` |
| Provider adapters | `src/server/providers/*` |
| API | `src/server/api/*`, `src/app/api/v1/[...path]` |
| UI | `src/app/agency/*` (agency dashboard), `src/app/w/[ws]/*` (client workspace) |

## Key decisions

- **Queue on PostgreSQL instead of Redis/BullMQ.** Job state lives with the data it
  describes, survives restarts, needs no extra service, and is claimed with
  `FOR UPDATE SKIP LOCKED` + leases. Workers heartbeat; an expired lease is reclaimed.
- **Tenancy is enforced in the service layer.** Every workspace operation starts with
  `requireWorkspace(actor, id, permission)`; every query filters by the resulting
  `workspaceId`. Missing and forbidden workspaces return the same 404.
- **Blueprints reference integrations logically** (`youtube_connection`, `llm_provider`,
  `transcription_provider`, `media_storage`). Deployments bind those names to the client's
  own connections; nothing account-specific is ever in a blueprint.
- **Runs snapshot their configuration.** Blueprint updates never alter a run in flight,
  and deployments only change when an update is explicitly applied (with a revision for rollback).
- **Edits are data.** An edit-decision list references source assets by id; renders are
  derived. Originals are never modified.
- **Rendering is staged** — one encode per segment, then a finishing pass (concat, logo,
  ASS captions/lower thirds, `afftdn`, `loudnorm`) — so hundreds of cuts stay fast and
  memory-bounded. A render is marked successful only after FFprobe verifies the output.
- **Idempotency everywhere side effects happen**: render idempotency keys + atomic claims,
  publishing idempotency keys, a stored resumable-upload session (encrypted) and a stored
  YouTube video id so an upload is never repeated; agent-created ideas/edits are keyed by
  workflow step.
- **Honest AI.** Model outputs are schema-validated, every id they cite is checked against
  the database (invented ones are dropped), measured findings are kept separate from
  hypotheses, and a missing provider yields an actionable `NOT_CONFIGURED` error — never
  fabricated output. Mock providers exist only for tests and are labelled everywhere.
