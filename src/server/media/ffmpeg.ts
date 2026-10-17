import "server-only";
import { spawn } from "node:child_process";
import { env } from "../env";

/**
 * FFmpeg / FFprobe process wrapper. Arguments are always passed as an array
 * (no shell), so file names and user text can never be interpreted as
 * commands. Every run is cancellable through an AbortSignal and reports
 * progress from `-progress pipe:1`.
 */

export class FfmpegError extends Error {
  constructor(message: string, readonly stderrTail: string) { super(message); this.name = "FfmpegError"; }
}

export function run(bin: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; onProgress?: (seconds: number) => void; captureStdout?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) return reject(new Error("Cancelled"));
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", buf = "";
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (opts.captureStdout) stdout += s;
      if (opts.onProgress) {
        buf += s;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
          if (m) opts.onProgress(Number(m[1]) / 1e6);
        }
      }
    });
    // Keep only the tail of stderr: long renders produce megabytes of it.
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-64_000); });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FfmpegError(`Could not start ${bin}: ${err.message}. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH.`, ""));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new Error("Cancelled"));
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new FfmpegError(`${bin.split(/[\\/]/).pop()} exited with code ${code}: ${lastLines(stderr, 3)}`, stderr.slice(-4000)));
    });
  });
}

function lastLines(s: string, n: number): string {
  return s.trim().split(/\r?\n/).filter((l) => !/^\s*$/.test(l)).slice(-n).join(" | ").slice(0, 600);
}

export const ffmpeg = (args: string[], opts?: Parameters<typeof run>[2]) => run(env.ffmpegPath(), args, opts);
export const ffprobe = (args: string[], opts?: Parameters<typeof run>[2]) => run(env.ffprobePath(), args, { ...opts, captureStdout: true });

export async function versions(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  const v = async (fn: typeof ffmpeg) => {
    try { const r = await run(fn === ffmpeg ? env.ffmpegPath() : env.ffprobePath(), ["-version"], { captureStdout: true }); return r.stdout.split("\n")[0].trim(); }
    catch { return null; }
  };
  return { ffmpeg: await v(ffmpeg), ffprobe: await v(ffprobe) };
}

/* ── probing ──────────────────────────────────────────────────────────── */

export type ProbeResult = {
  formatName: string;
  duration: number;
  sizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  rotation: number;
  isStillImage: boolean;
  raw: unknown;
};

const ACCEPTED_FORMATS = /(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|avi|mpegts|mpeg|mxf|flv|wav|mp3|flac|ogg|aac|image2|png_pipe|jpeg_pipe|webp_pipe|caf|aiff|w64)/;

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const j = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; disposition?: { attached_pic?: number }; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
  };
  const streams = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const rate = (r?: string) => { if (!r) return null; const [a, b] = r.split("/").map(Number); return b ? Math.round((a / b) * 1000) / 1000 : null; };
  const formatName = j.format?.format_name ?? "";
  const duration = Number(j.format?.duration ?? 0) || 0;
  const rotation = Number(video?.tags?.rotate ?? video?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0) || 0;
  const swap = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
  return {
    formatName, duration, sizeBytes: Number(j.format?.size ?? 0),
    hasVideo: Boolean(video), hasAudio: Boolean(audio),
    width: video ? (swap ? video.height : video.width) ?? null : null,
    height: video ? (swap ? video.width : video.height) ?? null : null,
    fps: video ? rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) : null,
    videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null,
    rotation, isStillImage: /image2|_pipe/.test(formatName) || (Boolean(video) && duration === 0),
    raw: j,
  };
}

/** Rejects files FFprobe cannot understand or that are not audio/video/image. */
export function assertAcceptableMedia(p: ProbeResult, kind: "video" | "audio" | "image"): void {
  if (!ACCEPTED_FORMATS.test(p.formatName)) throw new Error(`Unsupported container "${p.formatName || "unknown"}".`);
  if (kind === "video" && !p.hasVideo) throw new Error("The file has no video stream.");
  if (kind === "audio" && !p.hasAudio) throw new Error("The file has no audio stream.");
  if (kind === "image" && !p.isStillImage) throw new Error("The file is not a still image.");
  if (kind !== "image" && p.duration <= 0) throw new Error("Could not determine the media duration.");
  if (p.width && p.height && (p.width > 8192 || p.height > 8192)) throw new Error("Resolutions above 8K are not supported.");
}

/* ── analysis & working copies ────────────────────────────────────────── */

/** Silence ranges from FFmpeg's silencedetect — a measurement, not a model guess. */
export async function detectSilences(path: string, noiseDb: number, minSeconds: number, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
  const { stderr } = await ffmpeg(["-hide_banner", "-nostdin", "-i", path, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, "-f", "null", "-"], { signal });
  const out: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

/** Browser-friendly 720p H.264 preview; the original is never modified. */
export function proxyArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-i", input,
    "-vf", "scale=-2:'min(720,ih)',format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-progress", "pipe:1", output];
}

export function thumbnailArgs(input: string, output: string, at: number): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", output];
}

/** 16 kHz mono 32 kbps MP3: ~14 MB per hour, under common transcription upload limits. */
export function speechAudioArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-progress", "pipe:1", output];
}

export function audioChunkArgs(input: string, output: string, start: number, duration: number): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", input, "-c", "copy", output];
}
