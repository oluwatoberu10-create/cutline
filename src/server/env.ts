import "server-only";

/**
 * Typed access to environment configuration. Optional integrations return
 * null when unset so callers can show a setup message instead of failing.
 */

function onVercel(): boolean {
  return Boolean(process.env.VERCEL);
}

function bundled(which: "ffmpeg" | "ffprobe"): string | null {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports -- resolved lazily, only on Vercel */
    return which === "ffmpeg" ? (require("ffmpeg-static") as string) : (require("@ffprobe-installer/ffprobe") as { path: string }).path;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch {
    return null;
  }
}

function opt(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

export const env = {
  appUrl: () => (opt("APP_URL") ?? "http://localhost:3000").replace(/\/$/, ""),
  isProduction: () => process.env.NODE_ENV === "production",
  google: () => {
    const clientId = opt("GOOGLE_OAUTH_CLIENT_ID"), clientSecret = opt("GOOGLE_OAUTH_CLIENT_SECRET");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  },
  youtubeApiKey: () => opt("YOUTUBE_API_KEY"),
  anthropicKey: () => opt("ANTHROPIC_API_KEY"),
  openaiKey: () => opt("OPENAI_API_KEY"),
  deepgramKey: () => opt("DEEPGRAM_API_KEY"),
  storage: () => ({
    driver: (opt("STORAGE_DRIVER") ?? "local") as "local" | "s3",
    localDir: opt("LOCAL_STORAGE_DIR") ?? ".media",
    s3: {
      bucket: opt("S3_BUCKET"), region: opt("S3_REGION") ?? "us-east-1", endpoint: opt("S3_ENDPOINT"),
      accessKeyId: opt("S3_ACCESS_KEY_ID"), secretAccessKey: opt("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: opt("S3_FORCE_PATH_STYLE") === "true",
    },
  }),
  /** On Vercel (no system FFmpeg) the bundled static binaries are used. */
  ffmpegPath: () => opt("FFMPEG_PATH") ?? (onVercel() ? bundled("ffmpeg") : null) ?? "ffmpeg",
  ffprobePath: () => opt("FFPROBE_PATH") ?? (onVercel() ? bundled("ffprobe") : null) ?? "ffprobe",
  /** Vercel's filesystem is read-only except /tmp. */
  scratchDir: () => opt("SCRATCH_DIR") ?? (onVercel() ? "/tmp/cutline-scratch" : ".scratch"),
  onVercel: () => onVercel(),
  /** Test-only fake providers. Never enable in production. */
  mockProviders: () => opt("CUTLINE_ENABLE_MOCK_PROVIDERS") === "true" && process.env.NODE_ENV !== "production",
};
