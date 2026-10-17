# External services, credentials, permissions and costs

Nothing below has been verified against the live service from this build environment — no real
credentials were available. The adapters implement the providers' documented APIs and are covered
by tests against mocked/fake endpoints only. Verify each with real credentials (Integrations →
*Test*, and the deploy wizard's *Test* step) before going live. Prices change; check each provider.

## YouTube (required for channel sync and publishing)

1. Google Cloud Console → create a project → enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen: add scopes `youtube.readonly`, `yt-analytics.readonly`, `youtube.upload`
   and (optional) `youtube.force-ssl`. While the app is in *Testing*, add creators as test users;
   publishing for everyone requires Google's OAuth verification (sensitive/restricted scopes).
3. Credentials → OAuth client ID → *Web application* → redirect URI `APP_URL/api/oauth/google/callback`.
4. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. Optional `YOUTUBE_API_KEY` for public research.

| Capability | Scope | Notes |
|---|---|---|
| Channel, uploads, playlists | `youtube.readonly` | |
| Per-video analytics | `yt-analytics.readonly` | Owner's channel only |
| Upload / schedule | `youtube.upload` | Scheduling = `privacyStatus: private` + `publishAt` |
| Captions, playlist insertion | `youtube.force-ssl` | Optional |
| Pinning comments | — | **Not possible via the API**; Cutline drafts the comment only |
| Custom thumbnails | — | Needs a verified channel; Cutline gives concepts, upload in Studio |
| Transcripts of existing videos, demographics, competitor analytics | — | Not collected; reported as unavailable |

**Cost:** free within the API quota (default 10,000 units/day per Google Cloud project; a video
upload costs ~1,600 units, list calls ~1 unit). Quota exhaustion is reported as a clear error.
Agencies with many publishing clients should request a quota increase, or have clients use
their own Google Cloud project (client-owned installs).

## Language models (ideas, hypotheses, highlights, metadata)

- **Anthropic** — official `@anthropic-ai/sdk`, structured outputs, adaptive thinking, server-side
  refusal fallback enabled. Default model `claude-opus-5-5` (≈ $4 / $20 per million input/output
  tokens at time of writing). Key: console.anthropic.com.
- **OpenAI** — Chat Completions with `json_schema` response format. Model is configurable per blueprint.

Typical usage per workspace: one call per analysis, per idea batch, per edit proposal and per
metadata draft. Monthly call limits are enforced per workspace.

## Speech-to-text (footage)

- **OpenAI Whisper** (`whisper-1`) — word timestamps, no speaker labels; 25 MB request limit
  (Cutline sends 16 kHz mono MP3 and splits long recordings automatically). Billed per audio minute.
- **Deepgram** (`nova-3`) — utterances, word timings, optional diarisation. Billed per audio minute.

## Storage

**Google Drive (recommended on Vercel).** Enable the **Google Drive API** in the same Google Cloud
project as the YouTube OAuth client. Then Agency → Integrations → *Connect Google Drive* makes one
Drive folder the default storage for every client; a client can connect their own Drive in their
workspace. With a folder link Cutline asks for full Drive access (`drive`, a restricted scope —
fine for test users; public use needs Google verification); without a link it asks only for
`drive.file` and creates a "Cutline Media" folder. Uploads stream straight into Drive in ordered
parts. Drive has no anonymous signed URLs, so playback streams through `/api/media`. Personal
Drives have 15 GB free.

Local disk by default. S3-compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO) via `S3_*` or a
per-client bucket connected in the workspace. Costs: storage + egress of your provider; footage
is large (≈ 1–4 GB per hour of 1080p source).

## Compute

FFmpeg rendering is CPU-bound: a 10-minute 1080p final render takes roughly 1–5 minutes per
worker core depending on preset. Size workers for concurrent renders; per-workspace monthly render
and transcription minutes are enforced.
