import "server-only";
import { renderEnvExample } from "@/lib/blueprint/readme";
import type { Blueprint } from "@/lib/blueprint/schema";

/**
 * Files for a client-owned installation: the client runs their own Cutline
 * with their own credentials and imports this blueprint. Contains variable
 * NAMES only — nothing from the agency's environment is copied in.
 */
export function deploymentKitFiles(bp: Blueprint, packagePath: string): { path: string; content: string }[] {
  const compose = `# Cutline — client-owned installation (${bp.blueprint.name} v${bp.blueprint.version})
# Build the image from the Cutline source (docker build -t cutline:${bp.compatibility.minAppVersion} .)
# or set CUTLINE_IMAGE to an image you have built and pushed yourself.
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: cutline
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: cutline
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U cutline"], interval: 5s, retries: 20 }

  migrate:
    image: \${CUTLINE_IMAGE:-cutline:${bp.compatibility.minAppVersion}}
    env_file: .env
    environment: { DATABASE_URL: "postgresql://cutline:\${POSTGRES_PASSWORD}@db:5432/cutline" }
    command: ["npm", "run", "db:migrate"]
    depends_on: { db: { condition: service_healthy } }

  web:
    image: \${CUTLINE_IMAGE:-cutline:${bp.compatibility.minAppVersion}}
    restart: unless-stopped
    env_file: .env
    environment: { DATABASE_URL: "postgresql://cutline:\${POSTGRES_PASSWORD}@db:5432/cutline", LOCAL_STORAGE_DIR: /data/media, SCRATCH_DIR: /data/scratch }
    command: ["npm", "run", "start"]
    ports: ["3000:3000"]
    volumes: [media:/data]
    depends_on: { migrate: { condition: service_completed_successfully } }

  worker:
    image: \${CUTLINE_IMAGE:-cutline:${bp.compatibility.minAppVersion}}
    restart: unless-stopped
    env_file: .env
    environment: { DATABASE_URL: "postgresql://cutline:\${POSTGRES_PASSWORD}@db:5432/cutline", LOCAL_STORAGE_DIR: /data/media, SCRATCH_DIR: /data/scratch }
    command: ["npm", "run", "worker"]
    volumes: [media:/data]
    depends_on: { migrate: { condition: service_completed_successfully } }

volumes:
  pgdata:
  media:
`;

  const envFile = renderEnvExample(bp).replace("DATABASE_URL=\n", "POSTGRES_PASSWORD=\nCUTLINE_IMAGE=\n");

  const deploy = `# Deploying "${bp.blueprint.name}" on your own infrastructure

This kit lets you (the creator) run Cutline yourself, with your own accounts and credentials.
Nothing from the agency that built the blueprint is included: no keys, tokens, data or settings.

## 1. Prerequisites
- Docker 24+ with Compose v2 (or Node ${"22+"}, PostgreSQL 15+ and FFmpeg 6+ if running without Docker)
- A Google Cloud project with the **YouTube Data API v3** and **YouTube Analytics API** enabled,
  and an OAuth 2.0 *Web application* client whose redirect URI is \`<APP_URL>/api/oauth/google/callback\`
- An API key for at least one language model (Anthropic or OpenAI) and one transcription provider (OpenAI Whisper or Deepgram)

## 2. Configure
\`\`\`
cp .env.example .env
# Generate the two secrets:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # CUTLINE_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # CUTLINE_SIGNING_SECRET
\`\`\`
Fill in APP_URL (your public https URL), POSTGRES_PASSWORD and your provider credentials.

## 3. Start
\`\`\`
docker compose up -d
docker compose exec web npm run admin:create -- --org "My Channel" --email <your-email> --name "Your Name"
\`\`\`
(\`admin:create\` prints a one-time password; change it after signing in.)

## 4. Import the blueprint
Sign in → Agency → Blueprint Library → Import → upload \`${packagePath}\`, review the report, confirm.
Or from the command line: \`docker compose exec web npm run blueprint:import -- /path/to/package.zip\`

## 5. Deploy the agent to your workspace
Agency → Deploy → choose the imported blueprint → create your workspace → fill in your channel profile →
connect YouTube and your providers → Validate → Test → review the differences → Activate.

## 6. Verify
- Integrations page shows every connection as Connected (each has a Test button).
- Upload a short clip in Media; it should reach "Ready" within a minute (this confirms the worker and FFmpeg).
- Run "${bp.config.workflows[0]?.name ?? "a workflow"}" from the Agent page and watch Workflow Runs.

## Requirements of this blueprint
${bp.config.integrations.map((i) => `- \`${i.ref}\` — ${i.kind}${i.required ? " (required)" : ""}${i.scopes ? `, scopes: ${i.scopes.join(", ")}` : ""}: ${i.purpose}`).join("\n")}
`;

  return [
    { path: "docker-compose.yml", content: compose },
    { path: ".env.example", content: envFile },
    { path: "DEPLOY.md", content: deploy },
  ];
}
