import "server-only";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { TranscriptSegment } from "@/lib/edl";
import { ProviderError } from "./llm";

/**
 * Speech-to-text providers. Each returns segments in seconds relative to the
 * audio it was given; the caller offsets chunked audio. Features differ by
 * provider and are reported, not assumed: Whisper gives word timings but no
 * speakers; Deepgram can diarise when asked.
 */

export type TranscriptionResult = {
  language: string | null;
  segments: TranscriptSegment[];
  hasWordTimings: boolean;
  hasSpeakers: boolean;
};

export interface TranscriptionProvider {
  readonly provider: "openai" | "deepgram" | "mock";
  readonly model: string;
  readonly isMock: boolean;
  /** Largest audio file (bytes) one request accepts. */
  readonly maxBytes: number;
  transcribe(audioPath: string, opts: { language?: string; diarization: boolean; signal?: AbortSignal }): Promise<TranscriptionResult>;
}

export class OpenAiTranscription implements TranscriptionProvider {
  readonly provider = "openai" as const;
  readonly isMock = false;
  readonly maxBytes = 24 * 1024 * 1024;
  constructor(private apiKey: string, readonly model: string, private fetchImpl: typeof fetch = fetch) {}

  async transcribe(audioPath: string, opts: { language?: string; diarization: boolean; signal?: AbortSignal }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(await readFile(audioPath))], { type: "audio/mpeg" }), basename(audioPath));
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (opts.language) form.append("language", opts.language.slice(0, 2));
    const res = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: opts.signal,
    });
    if (res.status === 401) throw new ProviderError("OpenAI rejected the API key for transcription.", false);
    if (res.status === 413) throw new ProviderError("The audio chunk exceeded OpenAI's upload limit.", false);
    if (res.status === 429) throw await openAi429(res);
    if (!res.ok) throw new ProviderError(`OpenAI transcription error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status >= 500);
    const j = await res.json() as { language?: string; segments?: { id: number; start: number; end: number; text: string }[]; words?: { word: string; start: number; end: number }[] };
    const words = j.words ?? [];
    const segments: TranscriptSegment[] = (j.segments ?? []).map((s) => ({
      id: `s${s.id}`, start: s.start, end: s.end, text: s.text.trim(),
      words: words.filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01).map((w) => ({ w: w.word.trim(), start: w.start, end: w.end })),
    }));
    return { language: j.language ?? null, segments, hasWordTimings: words.length > 0, hasSpeakers: false };
  }
}

export class DeepgramTranscription implements TranscriptionProvider {
  readonly provider = "deepgram" as const;
  readonly isMock = false;
  readonly maxBytes = 1024 * 1024 * 1024;
  constructor(private apiKey: string, readonly model: string, private fetchImpl: typeof fetch = fetch) {}

  async transcribe(audioPath: string, opts: { language?: string; diarization: boolean; signal?: AbortSignal }): Promise<TranscriptionResult> {
    const params = new URLSearchParams({ model: this.model, smart_format: "true", punctuate: "true", utterances: "true", diarize: String(opts.diarization) });
    if (opts.language) params.set("language", opts.language);
    else params.set("detect_language", "true");
    const res = await this.fetchImpl(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST", headers: { authorization: `Token ${this.apiKey}`, "content-type": "audio/mpeg" }, body: new Uint8Array(await readFile(audioPath)), signal: opts.signal,
    });
    if (res.status === 401 || res.status === 403) throw new ProviderError("Deepgram rejected the API key.", false);
    if (res.status === 429) throw new ProviderError("Deepgram rate limit reached; the job will retry.", true);
    if (!res.ok) throw new ProviderError(`Deepgram error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status >= 500);
    const j = await res.json() as {
      results?: {
        channels?: { detected_language?: string }[];
        utterances?: { start: number; end: number; transcript: string; speaker?: number; words?: { word: string; punctuated_word?: string; start: number; end: number }[] }[];
      };
    };
    const utts = j.results?.utterances ?? [];
    return {
      language: j.results?.channels?.[0]?.detected_language ?? opts.language ?? null,
      segments: utts.map((u, i) => ({
        id: `s${i}`, start: u.start, end: u.end, text: u.transcript.trim(),
        speaker: opts.diarization && u.speaker !== undefined ? `Speaker ${u.speaker + 1}` : undefined,
        words: (u.words ?? []).map((w) => ({ w: (w.punctuated_word ?? w.word).trim(), start: w.start, end: w.end })),
      })),
      hasWordTimings: utts.some((u) => (u.words?.length ?? 0) > 0),
      hasSpeakers: opts.diarization && utts.some((u) => u.speaker !== undefined),
    };
  }
}

/** Test-only. Produces labelled placeholder text over the speech (non-silent) ranges it is told about. */
export class MockTranscription implements TranscriptionProvider {
  readonly provider = "mock" as const;
  readonly model = "mock-stt";
  readonly isMock = true;
  readonly maxBytes = 1024 * 1024 * 1024;
  constructor(private script: (audioPath: string) => Promise<TranscriptSegment[]>) {}
  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    const segments = await this.script(audioPath);
    return { language: "en", segments, hasWordTimings: segments.some((s) => s.words?.length), hasSpeakers: false };
  }
}

/** OpenAI uses 429 for both rate limits and an exhausted balance; only the former is worth retrying. */
async function openAi429(res: Response): Promise<ProviderError> {
  const j = await res.json().catch(() => ({})) as { error?: { type?: string; code?: string } };
  if (j.error?.type === "insufficient_quota" || j.error?.code === "insufficient_quota" || j.error?.code === "credit_balance_exhausted") {
    return new ProviderError("The OpenAI account has no remaining credits. Add credits at platform.openai.com → Billing, then retry.", false);
  }
  return new ProviderError("OpenAI rate limit reached; the job will retry.", true);
}
