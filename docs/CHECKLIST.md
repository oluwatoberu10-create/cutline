# Requirements checklist

Legend: ✅ built and covered by automated tests · 🟡 built, not verified against the live external service · ⛔ blocked on something external

## Acceptance scenarios

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1 | Agency admin creates a client workspace | ✅ | e2e (API), integration helpers, Clients screen |
| 2 | Creator connects YouTube with valid credentials | 🟡 | OAuth + PKCE + single-use user-bound state tested against a fake Google token endpoint (`youtube-ideas-publish.test.ts`); needs a real Google OAuth client to verify live |
| 3 | Channel data retrieved and ideas grounded in it | 🟡 | Sync, analytics access reporting, measured analysis, hypotheses and ideas with invented ids dropped — tested with fake YouTube + mock LLM; live APIs unverified |
| 4 | Upload real footage and receive a transcript | ✅ / 🟡 | Real chunked upload, FFprobe validation, working copies, chunked audio (tests + e2e). Transcript via mock STT in tests; Whisper/Deepgram adapters unverified live |
| 5 | Edit plan and real FFmpeg render | ✅ | Real renders in `pipeline.test.ts` and e2e: draft, final 1080p, burned captions, logo, fades, lower thirds, loudnorm, 1080×1920 short, duration verified |
| 6 | Creator reviews and approves the edit | ✅ | Restore/adjust/manual cuts, version approval, approval gates resume workflows; viewers cannot approve |
| 7 | Editable publishing metadata | ✅ / 🟡 | Transcript-grounded chapters, YouTube limits, validation; AI drafting via mock LLM in tests |
| 8 | Upload or schedule with valid permissions | 🟡 | Resumable upload, resume after failure, never-twice, processing tracking — against a fake upload endpoint; live upload unverified |
| 9 | Export a blueprint without secrets or client data | ✅ | `blueprint-deploy.test.ts` (client key and name absent), scanner on every file, e2e |
| 10 | Import that blueprint into a new client workspace | ✅ | Imported into a separate agency, deployed to a new client |
| 11 | New client connects own accounts and activates | ✅ | Validation fails with specific reasons until profile/providers/YouTube exist; activation recorded as revision 1 |
| 12 | Imported agent performs the same operations with the new client's settings | ✅ | Footage workflow runs on the new client's footage with their overrides (publishing disabled → metadata/upload skipped) |
| 13 | A client cannot access another client's data | ✅ | `tenancy.test.ts` (files, edits, renders, ideas, runs, transcripts, credentials, approvals, signed URLs, roles, API tokens), e2e (API + browser session → 404) |
| 14 | Failed jobs inspectable and safely retried | ✅ | Run fails honestly when a provider is removed, retries from the failed step; job logs; idempotent renders/uploads |
| 15 | Blueprint updates do not silently change deployments | ✅ | v1.1.0 published; client stays on v1.0.0 until applied; overrides kept; rollback restores |
| 16 | Missing integrations identified, never fake success | ✅ | `NOT_CONFIGURED` errors with next steps (tests + e2e); setup screens in UI |

## Deliverables

| Deliverable | Status |
|---|---|
| Application source, schema & migrations | ✅ `src/`, `drizzle/` |
| Agency dashboard & client workspace UI (all 17 key screens) | ✅ 44 screens render in e2e with real data |
| Agent configuration, workflow engine, blueprint format, export/import, deployment wizard | ✅ |
| YouTube integration, footage pipeline, publishing workflow | ✅ built · 🟡 live YouTube/AI unverified |
| Automated tests | ✅ unit (31), integration (34), HTTP e2e (30 checks) |
| `.env.example`, Docker configuration | ✅ written · 🟡 Docker not executed here (not installed) |
| Docs: setup, deployment, blueprint format, new-client guide, services/costs | ✅ `docs/` |
| Sample blueprint | ✅ `docs/sample-blueprint.json` (validated) |

## Known limitations / next steps

- ⛔ Live verification of Google OAuth, YouTube Data/Analytics/upload, Anthropic, OpenAI and
  Deepgram requires real credentials (see INTEGRATIONS.md).
- Google OAuth app verification is required before arbitrary creators can grant upload scopes.
- No email delivery: invites are shared as links.
- The timeline editor adjusts cuts by timestamps and transcript; there is no drag-to-trim waveform UI.
- Speaker identification only with Deepgram and only as accurate as the provider.
- The API supports session cookies and personal API tokens; there is no OAuth for third-party API clients.
