import type { RenderPreset } from "./blueprint/schema";
import { timelineDuration, type Edl } from "./edl";

/**
 * Turns an EDL into the FFmpeg invocations that render it. Pure — no
 * filesystem or process access — so the exact commands are unit-tested.
 *
 * Two stages, so a 30-minute recording with hundreds of cuts stays fast and
 * memory-bounded:
 *
 *   1. one short encode per segment (intro, each clip, outro), seeking straight
 *      to the range and normalising size, frame rate and audio format;
 *   2. a finishing pass that concatenates the segments and applies the
 *      timeline-wide work: logo overlay, burned-in captions/lower thirds,
 *      noise reduction, loudness normalisation and the output codec.
 *
 * All file names are relative; renders run with the scratch directory as cwd,
 * which also avoids filter-graph path escaping on Windows.
 */

export type PlanSource = { file: string; hasVideo: boolean; hasAudio: boolean; duration: number };
export type PlanStep = { label: string; args: string[]; /** Output seconds this step produces, for progress. */ seconds: number };

export type RenderPlan = {
  steps: PlanStep[];
  /** Contents of the concat-demuxer list file (segments.txt). */
  concatList: string;
  timelineSeconds: number;
};

const NR: Record<string, number> = { light: 6, medium: 12, strong: 20 };
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

export function reframeFilter(mode: Edl["output"]["reframe"], W: number, H: number): string {
  switch (mode) {
    case "center_crop":
      return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    case "blur_pad":
      return `split=2[bg0][fg0];[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bg];` +
        `[fg0]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
    default:
      return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
}

export function buildRenderPlan(opts: {
  edl: Edl;
  preset: RenderPreset;
  /** EDL source id → input file. */
  sources: Record<string, PlanSource>;
  intro?: PlanSource | null;
  outro?: PlanSource | null;
  logo?: { file: string } | null;
  /** Burned-in captions/lower thirds file, when present. */
  assFile?: string | null;
  outputFile: string;
}): RenderPlan {
  const { edl, preset } = opts;
  const W = preset.width, H = preset.height, F = preset.fps;
  if (!edl.clips.length) throw new Error("The edit has no clips to render.");
  const fade = edl.transitions.type === "fade" ? edl.transitions.durationMs / 1000 : 0;

  const steps: PlanStep[] = [];
  const segFiles: string[] = [];

  const segment = (name: string, src: PlanSource, start: number, end: number, withFade: boolean) => {
    const len = Math.max(0.05, end - start);
    const d = withFade ? Math.min(fade, len / 3) : 0;
    const vFade = d > 0 ? `,fade=t=in:st=0:d=${f3(d)},fade=t=out:st=${f3(len - d)}:d=${f3(d)}` : "";
    const aFade = d > 0 ? `,afade=t=in:st=0:d=${f3(d)},afade=t=out:st=${f3(len - d)}:d=${f3(d)}` : "";
    const out = `${name}.mkv`;
    segFiles.push(out);

    const inputs: string[] = [];
    let vIn: string, aIn: string;
    // Seeking before -i is frame-accurate when re-encoding and avoids decoding the whole file.
    inputs.push("-ss", f3(start), "-t", f3(len), "-i", src.file);
    if (src.hasVideo) vIn = "[0:v]";
    else { inputs.push("-f", "lavfi", "-t", f3(len), "-i", `color=c=black:s=${W}x${H}:r=${F}`); vIn = "[1:v]"; }
    if (src.hasAudio) aIn = "[0:a]";
    else { inputs.push("-f", "lavfi", "-t", f3(len), "-i", "anullsrc=r=48000:cl=stereo"); aIn = `[${src.hasVideo ? 1 : 2}:a]`; }

    const graph =
      // reframeFilter may contain its own split/overlay sub-graph; the chain continues from its last filter.
      `${vIn}fps=${F},${reframeFilter(edl.output.reframe, W, H)},format=yuv420p${vFade}[v];` +
      `${aIn}aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo${aFade}[a]`;

    steps.push({
      label: `Segment ${name}`,
      seconds: len,
      args: [
        "-hide_banner", "-nostdin", "-y", ...inputs,
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        "-t", f3(len),
        // Near-lossless intermediate; quality is decided by the finishing pass.
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-g", String(Math.round(F)),
        "-c:a", "pcm_s16le",
        "-progress", "pipe:1", "-stats_period", "1",
        out,
      ],
    });
  };

  if (opts.intro) segment("intro", opts.intro, 0, opts.intro.duration, false);
  edl.clips.forEach((c, i) => {
    const src = opts.sources[c.sourceId];
    if (!src) throw new Error(`Clip ${c.id} references unknown source ${c.sourceId}.`);
    const end = src.duration > 0 ? Math.min(c.out, src.duration) : c.out;
    if (end - c.in < 0.05) return;
    segment(`seg${String(i).padStart(4, "0")}`, src, c.in, end, true);
  });
  if (opts.outro) segment("outro", opts.outro, 0, opts.outro.duration, false);

  const concatList = segFiles.map((f) => `file '${f}'`).join("\n") + "\n";

  // Finishing pass.
  const vf: string[] = [];
  let vLabel = "[0:v]";
  const extraInputs: string[] = [];
  if (opts.logo) {
    const b = edl.branding;
    const m = Math.round(Math.min(W, H) * 0.03);
    const pos = { "top-left": `${m}:${m}`, "top-right": `W-w-${m}:${m}`, "bottom-left": `${m}:H-h-${m}`, "bottom-right": `W-w-${m}:H-h-${m}` }[b.logoPosition];
    extraInputs.push("-i", opts.logo.file);
    vf.push(`[1:v]scale=${Math.round(W * b.logoScale)}:-1,format=rgba,colorchannelmixer=aa=${f3(b.logoOpacity)}[logo]`);
    vf.push(`${vLabel}[logo]overlay=${pos}:format=auto[vl]`);
    vLabel = "[vl]";
  }
  if (opts.assFile) {
    vf.push(`${vLabel}ass=${opts.assFile}[vs]`);
    vLabel = "[vs]";
  }
  vf.push(`${vLabel}format=yuv420p[vout]`);

  const aChain: string[] = [];
  if (edl.audio.noiseReduction !== "off") aChain.push(`afftdn=nr=${NR[edl.audio.noiseReduction]}:nf=-40`);
  if (edl.audio.normalize) aChain.push(`loudnorm=I=${edl.audio.targetLufs}:TP=-1.5:LRA=11`);
  aChain.push("aresample=48000");
  const graph = [...vf, `[0:a]${aChain.join(",")}[aout]`].join(";");

  const codec = preset.container === "webm"
    ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(Math.min(63, preset.crf + 10)), "-row-mt", "1", "-deadline", preset.speed === "ultrafast" ? "realtime" : "good", "-c:a", "libopus", "-b:a", `${preset.audioBitrateK}k`]
    : ["-c:v", "libx264", "-preset", preset.speed, "-crf", String(preset.crf), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", `${preset.audioBitrateK}k`, "-movflags", "+faststart"];

  const total = segFiles.length ? timelineDuration(edl.clips) + (opts.intro?.duration ?? 0) + (opts.outro?.duration ?? 0) : 0;
  steps.push({
    label: "Finishing pass",
    seconds: total,
    args: [
      "-hide_banner", "-nostdin", "-y",
      "-f", "concat", "-safe", "0", "-i", "segments.txt",
      ...extraInputs,
      "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
      "-r", String(F), ...codec,
      "-progress", "pipe:1", "-stats_period", "1",
      opts.outputFile,
    ],
  });

  return { steps, concatList, timelineSeconds: Math.round(total * 1000) / 1000 };
}
