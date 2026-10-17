import { describe, expect, it } from "vitest";
import { defaultAgentConfig } from "./blueprint/defaults";
import { clipsFromRanges, cuesFromTranscript, keepRanges, sourceToTimeline, timelineCues, toAss, toSrt, wrapLines, type Edl } from "./edl";
import { fitTags, normalizeChapters } from "./metadata";
import { buildRenderPlan } from "./render-plan";

describe("edit-decision lists", () => {
  it("computes keep ranges and drops tiny fragments", () => {
    expect(keepRanges(10, [{ start: 2, end: 3 }, { start: 2.5, end: 4 }, { start: 4.2, end: 5 }], 0.5))
      .toEqual([{ start: 0, end: 2 }, { start: 5, end: 10 }]);
  });

  it("maps source time to the cut timeline and projects captions", () => {
    const clips = clipsFromRanges("s1", [{ start: 0, end: 2 }, { start: 5, end: 10 }]);
    expect(sourceToTimeline(clips, "s1", 6)).toBe(3);
    expect(sourceToTimeline(clips, "s1", 3)).toBeNull();
    expect(timelineCues(clips, [{ id: "q1", sourceId: "s1", start: 1, end: 6, text: "hello" }]))
      .toEqual([{ start: 1, end: 2, text: "hello" }, { start: 2, end: 3, text: "hello" }]);
  });

  it("builds caption cues within the character limit", () => {
    const cues = cuesFromTranscript("s1", [{ id: "1", start: 0, end: 6, text: "one two three four five six seven eight nine ten eleven twelve" }], { maxCharsPerLine: 20, maxLines: 1 });
    expect(cues.every((c) => c.text.length <= 20)).toBe(true);
    expect(cues[0].start).toBe(0);
    expect(wrapLines("aaaa bbbb cccc", 9, 2)).toBe("aaaa bbbb\ncccc");
  });

  it("formats SRT and neutralises ASS override blocks in user text", () => {
    expect(toSrt([{ start: 61.5, end: 62, text: "hi" }])).toBe("1\n00:01:01,500 --> 00:01:02,000\nhi\n");
    const ass = toAss({ width: 1920, height: 1080, style: defaultAgentConfig().modules.editing.captions.style, cues: [{ start: 0, end: 1, text: "{\\b1}x" }], lowerThirds: [], captions: true });
    expect(ass).not.toContain("{\\b1}");
  });
});

describe("render plan", () => {
  const cfg = defaultAgentConfig();
  const preset = cfg.renderPresets.find((p) => p.id === "draft-540p")!;
  const edl: Edl = {
    version: 1,
    sources: [{ id: "s1", assetId: "6f1c2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b" }],
    clips: clipsFromRanges("s1", [{ start: 0, end: 2 }, { start: 5, end: 9 }]),
    output: { presetId: preset.id, reframe: "fit" },
    audio: { normalize: true, targetLufs: -14, noiseReduction: "light" },
    transitions: { type: "fade", durationMs: 200 },
    captions: { enabled: true, burnIn: true, style: cfg.modules.editing.captions.style, cues: [] },
    branding: { logoAssetId: null, logoPosition: "top-right", logoScale: 0.1, logoOpacity: 0.8, introAssetId: null, outroAssetId: null },
    lowerThirds: [],
  };

  it("produces one segment per clip and a finishing pass", () => {
    const plan = buildRenderPlan({ edl, preset, sources: { s1: { file: "src.mp4", hasAudio: true, hasVideo: true, duration: 10 } }, assFile: "captions.ass", outputFile: "out.mp4" });
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[1].args.slice(3, 9)).toEqual(["-ss", "5", "-t", "4", "-i", "src.mp4"]);
    expect(plan.steps[0].args.join(" ")).toContain("fade=t=out:st=1.8:d=0.2");
    const fin = plan.steps[2].args.join(" ");
    expect(fin).toContain("ass=captions.ass");
    expect(fin).toContain("afftdn=nr=6");
    expect(fin).toContain("loudnorm=I=-14");
    expect(plan.concatList).toBe("file 'seg0000.mkv'\nfile 'seg0001.mkv'\n");
    expect(plan.timelineSeconds).toBe(6);
  });

  it("synthesises picture for audio-only sources", () => {
    const plan = buildRenderPlan({ edl: { ...edl, captions: { ...edl.captions, burnIn: false } }, preset, sources: { s1: { file: "a.wav", hasAudio: true, hasVideo: false, duration: 10 } }, outputFile: "o.mp4" });
    expect(plan.steps[0].args.join(" ")).toContain("color=c=black:s=960x540");
  });
});

describe("metadata rules", () => {
  it("enforces YouTube chapter rules", () => {
    expect(normalizeChapters([{ start: 3, title: "Intro" }, { start: 40, title: "B" }, { start: 45, title: "too close" }, { start: 90, title: "C" }], 200).chapters)
      .toEqual([{ start: 0, title: "Intro" }, { start: 40, title: "B" }, { start: 90, title: "C" }]);
    expect(normalizeChapters([{ start: 0, title: "A" }, { start: 30, title: "B" }], 100).chapters).toEqual([]);
  });

  it("fits tags into the 500-character budget and dedupes", () => {
    const tags = fitTags(["a", "A", ...Array.from({ length: 100 }, (_, i) => `tag number ${i}`)], 50);
    expect(tags[0]).toBe("a");
    expect(tags.filter((t) => t.toLowerCase() === "a")).toHaveLength(1);
    expect(tags.reduce((s, t, i) => s + t.length + (t.includes(" ") ? 2 : 0) + (i ? 1 : 0), 0)).toBeLessThanOrEqual(500);
  });
});
