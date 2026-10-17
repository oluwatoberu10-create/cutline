/**
 * Live provider check: runs Cutline's own adapters against the real APIs using
 * the keys in .env.local. Makes a handful of tiny paid calls. Prints results,
 * never key values.   npm run live:check
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { loadDotEnv } from "./env";

async function main() {
  loadDotEnv();
  const { AnthropicLlm, OpenAiLlm } = await import("../src/server/providers/llm");
  const { OpenAiTranscription, DeepgramTranscription } = await import("../src/server/providers/transcription");
  const schema = z.object({ titles: z.array(z.string()), topic: z.string() });
  const req = { system: "You write YouTube titles.", prompt: "Give 2 short titles for a video about pulling a first espresso shot, and the topic in two words.", schema, schemaName: "probe", maxTokens: 2000, effort: "low" as const };

  const run = async (name: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    try { console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${await fn()}`); }
    catch (e) { console.log(`✗ ${name}: ${e instanceof Error ? e.message : e}`); }
  };

  if (process.env.ANTHROPIC_API_KEY) await run("Anthropic claude-opus-5-5 structured JSON", async () => JSON.stringify(await new AnthropicLlm(process.env.ANTHROPIC_API_KEY!, "claude-opus-5-5").generateJson(req)));
  if (process.env.OPENAI_API_KEY) await run("OpenAI gpt-5 structured JSON", async () => JSON.stringify(await new OpenAiLlm(process.env.OPENAI_API_KEY!, "gpt-5").generateJson(req)));

  const wav = ".scratch/live/speech.wav", mp3 = ".scratch/live/speech.mp3";
  if (existsSync(wav)) {
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", mp3]);
    const fmt = (r: { segments: { start: number; text: string; words?: unknown[] }[]; hasWordTimings: boolean }) =>
      `${r.segments.length} segment(s), word timings: ${r.hasWordTimings} — "${r.segments.map((s) => s.text).join(" ").slice(0, 120)}"`;
    if (process.env.OPENAI_API_KEY) await run("OpenAI Whisper transcription", async () => fmt(await new OpenAiTranscription(process.env.OPENAI_API_KEY!, "whisper-1").transcribe(mp3, { diarization: false })));
    if (process.env.DEEPGRAM_API_KEY) await run("Deepgram nova-3 transcription", async () => fmt(await new DeepgramTranscription(process.env.DEEPGRAM_API_KEY!, "nova-3").transcribe(mp3, { diarization: true })));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
