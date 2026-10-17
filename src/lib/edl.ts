import { z } from "zod";
import { captionStyleSchema, type CaptionStyle } from "./blueprint/schema";

/**
 * Edit-decision list (EDL).
 *
 * An edit never modifies footage. It is this JSON document: which ranges of
 * which source assets to play, in what order, plus captions, branding,
 * audio processing and output settings. Rendering turns it into an FFmpeg
 * filter graph; changing it and re-rendering is always safe.
 *
 * Times on clips and caption cues are in SOURCE seconds; timeline positions
 * are derived, so cutting or restoring a segment never desynchronises captions.
 */

const t = z.number().min(0).max(86_400);

export const clipSchema = z.object({
  id: z.string().min(1).max(40),
  sourceId: z.string().min(1).max(40),
  in: t,
  out: t,
  label: z.string().max(200).optional(),
}).strict().refine((c) => c.out > c.in, { message: "Clip out must be after in." });

export const cueSchema = z.object({
  id: z.string().min(1).max(40),
  sourceId: z.string().min(1).max(40),
  start: t,
  end: t,
  text: z.string().max(500),
}).strict();

export const edlSchema = z.object({
  version: z.literal(1),
  sources: z.array(z.object({ id: z.string().min(1).max(40), assetId: z.uuid() }).strict()).min(1).max(20),
  clips: z.array(clipSchema).max(2000),
  output: z.object({
    presetId: z.string().min(1).max(40),
    reframe: z.enum(["fit", "center_crop", "blur_pad"]).default("fit"),
  }).strict(),
  audio: z.object({
    normalize: z.boolean().default(true),
    targetLufs: z.number().min(-30).max(-9).default(-14),
    noiseReduction: z.enum(["off", "light", "medium", "strong"]).default("off"),
  }).strict(),
  transitions: z.object({ type: z.enum(["none", "fade"]).default("none"), durationMs: z.number().int().min(0).max(2000).default(200) }).strict(),
  captions: z.object({
    enabled: z.boolean().default(true),
    burnIn: z.boolean().default(false),
    style: captionStyleSchema,
    cues: z.array(cueSchema).max(10_000).default([]),
  }).strict(),
  branding: z.object({
    logoAssetId: z.uuid().nullable().default(null),
    logoPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("top-right"),
    logoScale: z.number().min(0.03).max(0.4).default(0.1),
    logoOpacity: z.number().min(0.1).max(1).default(0.85),
    introAssetId: z.uuid().nullable().default(null),
    outroAssetId: z.uuid().nullable().default(null),
  }).strict(),
  lowerThirds: z.array(z.object({
    id: z.string().min(1).max(40),
    text: z.string().min(1).max(80),
    subtext: z.string().max(80).default(""),
    /** Timeline seconds (after cuts). */
    start: t,
    duration: z.number().min(0.5).max(30),
  }).strict()).max(50).default([]),
}).strict();

export type Edl = z.infer<typeof edlSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Cue = z.infer<typeof cueSchema>;
export type Range = { start: number; end: number };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Merges overlapping/adjacent ranges. */
export function mergeRanges(ranges: Range[], gap = 0): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/**
 * The ranges of a source to KEEP once `removals` are cut out. Fragments
 * shorter than `minClip` are dropped (they would read as glitches).
 */
export function keepRanges(duration: number, removals: Range[], minClip = 0.5): Range[] {
  const cuts = mergeRanges(removals.map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) })));
  const keep: Range[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });
  return keep.filter((k) => k.end - k.start >= minClip).map((k) => ({ start: r3(k.start), end: r3(k.end) }));
}

export function clipsFromRanges(sourceId: string, ranges: Range[]): Clip[] {
  return ranges.map((r, i) => ({ id: `c${i + 1}`, sourceId, in: r.start, out: r.end }));
}

export function timelineDuration(clips: Pick<Clip, "in" | "out">[]): number {
  return r3(clips.reduce((s, c) => s + (c.out - c.in), 0));
}

/** Where each clip lands on the output timeline. */
export function clipOffsets(clips: Clip[]): { clip: Clip; start: number; end: number }[] {
  let at = 0;
  return clips.map((clip) => {
    const start = at;
    at += clip.out - clip.in;
    return { clip, start: r3(start), end: r3(at) };
  });
}

/** Maps a source-time instant to timeline time, or null if that moment was cut. */
export function sourceToTimeline(clips: Clip[], sourceId: string, time: number): number | null {
  for (const o of clipOffsets(clips)) {
    if (o.clip.sourceId === sourceId && time >= o.clip.in && time <= o.clip.out) return r3(o.start + (time - o.clip.in));
  }
  return null;
}

/**
 * Timeline position of the first surviving moment of a source range, or null
 * if all of it was cut. (A segment whose first word was trimmed still counts.)
 */
export function rangeToTimeline(clips: Clip[], sourceId: string, start: number, end: number): number | null {
  for (const o of clipOffsets(clips)) {
    if (o.clip.sourceId !== sourceId) continue;
    const s = Math.max(start, o.clip.in), e = Math.min(end, o.clip.out);
    if (e - s >= 0.2) return r3(o.start + (s - o.clip.in));
  }
  return null;
}

/** Projects source-time cues onto the timeline, splitting or dropping where the footage was cut. */
export function timelineCues(clips: Clip[], cues: Cue[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const o of clipOffsets(clips)) {
    for (const cue of cues) {
      if (cue.sourceId !== o.clip.sourceId || !cue.text.trim()) continue;
      const s = Math.max(cue.start, o.clip.in), e = Math.min(cue.end, o.clip.out);
      if (e - s < 0.2) continue;
      out.push({ start: r3(o.start + (s - o.clip.in)), end: r3(o.start + (e - o.clip.in)), text: cue.text.trim() });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ── transcript → caption cues ────────────────────────────────────────── */

export type TranscriptWord = { w: string; start: number; end: number };
export type TranscriptSegment = { id: string; start: number; end: number; text: string; speaker?: string; words?: TranscriptWord[] };

/**
 * Splits transcript segments into readable caption cues of at most
 * `maxChars × maxLines` characters, using word timings when the provider
 * returned them and proportional timing otherwise.
 */
export function cuesFromTranscript(sourceId: string, segments: TranscriptSegment[], style: Pick<CaptionStyle, "maxCharsPerLine" | "maxLines">): Cue[] {
  const limit = style.maxCharsPerLine * style.maxLines;
  const cues: Cue[] = [];
  let n = 0;
  for (const seg of segments) {
    const words: TranscriptWord[] = seg.words?.length
      ? seg.words
      : spreadWords(seg.text, seg.start, seg.end);
    let buf: TranscriptWord[] = [];
    const flush = () => {
      if (!buf.length) return;
      cues.push({ id: `q${++n}`, sourceId, start: r3(buf[0].start), end: r3(buf[buf.length - 1].end), text: wrapLines(buf.map((w) => w.w).join(" "), style.maxCharsPerLine, style.maxLines) });
      buf = [];
    };
    for (const w of words) {
      const len = buf.map((x) => x.w).join(" ").length + w.w.length + 1;
      if (len > limit) flush();
      buf.push(w);
      if (/[.!?]$/.test(w.w) && buf.map((x) => x.w).join(" ").length > limit * 0.5) flush();
    }
    flush();
  }
  return cues;
}

function spreadWords(text: string, start: number, end: number): TranscriptWord[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const total = ws.reduce((s, w) => s + w.length + 1, 0) || 1;
  let at = start;
  return ws.map((w) => {
    const d = ((w.length + 1) / total) * (end - start);
    const word = { w, start: at, end: at + d };
    at += d;
    return word;
  });
}

export function wrapLines(text: string, maxChars: number, maxLines: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars && lines.length < maxLines - 1) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

/* ── subtitle formats ─────────────────────────────────────────────────── */

function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function toSrt(cues: { start: number; end: number; text: string }[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: { start: number; end: number; text: string }[]): string {
  return "WEBVTT\n\n" + cues.map((c) => `${srtTime(c.start).replace(",", ".")} --> ${srtTime(c.end).replace(",", ".")}\n${c.text}\n`).join("\n");
}

function assTime(s: number): string {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360_000), m = Math.floor((cs % 360_000) / 6000), sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** "#RRGGBB" → ASS "&H00BBGGRR". */
function assColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "");
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function assEscape(text: string): string {
  // ASS override blocks start with "{"; braces and backslashes from user text are neutralised.
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\n/g, "\\N");
}

/** Advanced SubStation file for burned-in captions and lower thirds. */
export function toAss(opts: {
  width: number; height: number; style: CaptionStyle;
  cues: { start: number; end: number; text: string }[];
  lowerThirds: { text: string; subtext: string; start: number; duration: number }[];
  captions: boolean;
}): string {
  const { width, height, style } = opts;
  const scale = height / 1080;
  const align = style.position === "top" ? 8 : style.position === "middle" ? 5 : 2;
  const fontSize = Math.round(style.fontSize * scale);
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${style.font},${fontSize},${assColor(style.primaryColor)},${assColor(style.primaryColor)},${assColor(style.outlineColor)},&H64000000,-1,0,0,0,100,100,0,0,1,${style.outline},0,${align},${Math.round(60 * scale)},${Math.round(60 * scale)},${Math.round(70 * scale)},1`,
    `Style: LowerThird,${style.font},${Math.round(40 * scale)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,3,${Math.round(14 * scale)},0,1,${Math.round(70 * scale)},${Math.round(70 * scale)},${Math.round(150 * scale)},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (opts.captions) for (const c of opts.cues) lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${assEscape(c.text)}`);
  for (const l of opts.lowerThirds) {
    const body = l.subtext ? `${assEscape(l.text)}\\N{\\fs${Math.round(28 * scale)}\\b0}${assEscape(l.subtext)}` : assEscape(l.text);
    lines.push(`Dialogue: 1,${assTime(l.start)},${assTime(l.start + l.duration)},LowerThird,,0,0,0,,{\\fad(250,250)}${body}`);
  }
  return lines.join("\n") + "\n";
}
