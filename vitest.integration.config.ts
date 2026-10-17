import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Integration tests: real PostgreSQL (a throwaway `cutline_test` database on
 * the local cluster), real FFmpeg, real storage on disk. External services
 * (LLMs, speech-to-text, YouTube) are replaced by the clearly-labelled mock
 * providers or a fake HTTP layer — these tests never claim a live
 * integration was verified.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "server-only": resolve(__dirname, "./tests/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    env: {
      DATABASE_URL: "postgresql://cutline:cutline@127.0.0.1:54333/cutline_test",
      LOCAL_STORAGE_DIR: ".media-test",
      SCRATCH_DIR: ".scratch-test",
      CUTLINE_ENABLE_MOCK_PROVIDERS: "true",
      CUTLINE_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      CUTLINE_SIGNING_SECRET: "test-signing-secret-that-is-long-enough-123456",
      APP_URL: "http://localhost:3000",
      GOOGLE_OAUTH_CLIENT_ID: "test-client.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret-value",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      DEEPGRAM_API_KEY: "",
      YOUTUBE_API_KEY: "",
    },
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
