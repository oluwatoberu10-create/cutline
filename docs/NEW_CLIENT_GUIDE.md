# Deploying an agent for a new client

## Agency-managed (the client is hosted on your installation)

1. **Blueprint** — Agency → Agent templates: build or import the agent, then *Publish* a version.
2. **Deploy** — Agency → Deploy → choose the version and *Create a new client workspace*.
3. **Client profile** — niche, audience, formats, tone, goals, topics to avoid. Fields the
   blueprint marks as required must be filled.
4. **Connect accounts** — for each logical integration:
   - `youtube_connection`: *Connect a YouTube channel* — the creator signs in with their own
     Google account and grants the scopes shown (Analytics, Upload, Captions & playlists).
   - `llm_provider` / `transcription_provider`: add the client's own API key, or leave on
     *Automatic* to use an agency-shared provider (only if the workspace allows it).
   - `media_storage`: Automatic = this installation's storage; or connect the client's bucket.
5. **Configure** — editing mode (review-first is recommended for new clients), publishing mode
   (approval-based by default), ideation batch size, captions, noise reduction.
6. **Validate** — every failing check says exactly what to fix.
7. **Test** — live connection tests, an FFmpeg test on a generated clip, and a dry run of every
   workflow showing which steps will run or be skipped for this client.
8. **Review** — the differences between this client's agent and the blueprint.
9. **Activate** — records revision 1. Workflows can now run from the client's Agent page.

Then invite the creator: workspace → Settings → *Invite* with role **Owner** (they approve edits
and publishing). Share the link shown — Cutline does not send email.

## Client-owned (the client runs their own installation)

1. Blueprint library → the version → *Download client-owned deployment kit*.
2. Give the kit to the client. `DEPLOY.md` inside walks them through Docker Compose, their own
   Google OAuth client and AI keys, `admin:create`, importing the blueprint and running the
   wizard on their installation. None of your credentials or data are in the kit.

## Updating clients later

Publish a new version → each client's Agent page shows *Update available* → review the diff →
*Apply*. Clients you do not update keep running their current version. *Restore* on any
revision rolls back exactly.
