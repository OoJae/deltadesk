// Stitches scene videos (or stills) + narration + captions into out/deltadesk-demo.mp4 (1920x1080, 30 fps, H.264, AAC).
//   node demo/build/stitch.mjs [--captions burn|soft|none]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./beats.mjs";
import { FPS, LEAD, duration, ffmpeg } from "./lib.mjs";

const args = process.argv.slice(2);
const mode = args.includes("--captions") ? args[args.indexOf("--captions") + 1] : "burn";
if (!["burn", "soft", "none"].includes(mode)) throw new Error(`--captions must be burn, soft or none (got ${mode})`);

const tl = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));
const work = join(OUT, "build");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS)];

// 1. one video segment per beat, exactly round(duration * FPS) frames
const segs = [];
tl.beats.forEach((b, i) => {
  const frames = Math.round(b.duration * FPS);
  const out = join(work, `v-${b.id}.mp4`);
  const fades = [];
  if (i === 0) fades.push("fade=t=in:st=0:d=0.6");
  if (i === tl.beats.length - 1) fades.push(`fade=t=out:st=${(b.duration - 1).toFixed(2)}:d=1`);
  const card = join(OUT, "cards", `${b.id}.png`);
  const scene = join(OUT, "scenes", `${b.id}.webm`);
  const meta = join(OUT, "scenes", `${b.id}.json`);
  if (!b.pending && existsSync(scene) && existsSync(meta) && !existsSync(card)) {
    const { offset } = JSON.parse(readFileSync(meta, "utf8"));
    const avail = duration(scene) - offset;
    const vf = [`fps=${FPS}`, "scale=1920:1080:flags=lanczos,setsar=1", `tpad=stop_mode=clone:stop_duration=${Math.max(0, b.duration - avail + 1).toFixed(2)}`, ...fades, "format=yuv420p"].join(",");
    ffmpeg(["-ss", offset.toFixed(3), "-i", scene, "-vf", vf, "-frames:v", String(frames), "-an", ...X264, out]);
    console.log(`video ${b.id.padEnd(20)} ${b.duration.toFixed(2)}s from scene (trim ${offset.toFixed(2)}s${avail < b.duration ? `, held last frame ${(b.duration - avail).toFixed(2)}s` : ""})`);
  } else {
    if (!existsSync(card)) throw new Error(`no scene video and no card for ${b.id}; run demo/build/render.mjs`);
    const vf = ["scale=1920:1080,setsar=1", ...fades, "format=yuv420p"].join(",");
    ffmpeg(["-loop", "1", "-framerate", String(FPS), "-i", card, "-vf", vf, "-frames:v", String(frames), ...X264, out]);
    console.log(`video ${b.id.padEnd(20)} ${b.duration.toFixed(2)}s from card`);
  }
  segs.push(out);
});
writeFileSync(join(work, "video.txt"), segs.map((s) => `file '${s}'`).join("\n"));
const video = join(work, "video.mp4");
ffmpeg(["-f", "concat", "-safe", "0", "-i", join(work, "video.txt"), "-c", "copy", video]);

// 2. narration: each beat's voice, delayed by LEAD, padded to the beat; or the user's full voiceover
const narration = join(work, "narration.wav");
if (tl.full) {
  ffmpeg(["-i", tl.full, "-af", `apad=whole_dur=${tl.total}`, "-t", String(tl.total), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", narration]);
} else {
  const parts = tl.beats.map((b) => {
    const out = join(work, `a-${b.id}.wav`);
    const dur = (Math.round(b.duration * FPS) / FPS).toFixed(4);
    if (b.voice) ffmpeg(["-i", b.voice, "-af", `adelay=${Math.round(LEAD * 1000)}:all=1,apad=whole_dur=${dur}`, "-t", dur, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out]);
    else ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", dur, "-c:a", "pcm_s16le", out]);
    return out;
  });
  writeFileSync(join(work, "audio.txt"), parts.map((s) => `file '${s}'`).join("\n"));
  ffmpeg(["-f", "concat", "-safe", "0", "-i", join(work, "audio.txt"), "-c", "copy", narration]);
}

// 3. final mux
const final = join(OUT, "deltadesk-demo.mp4");
const srt = join(OUT, "deltadesk-demo.srt");
const common = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-metadata", "title=DeltaDesk demo"];
if (mode === "burn") {
  const cues = JSON.parse(readFileSync(join(OUT, "cues.json"), "utf8"));
  const cdir = join(OUT, "captions");
  const lines = ["ffconcat version 1.0"];
  let t = 0;
  cues.forEach((c, i) => {
    if (c.start > t + 0.001) lines.push(`file '${join(cdir, "blank.png")}'`, `duration ${(c.start - t).toFixed(3)}`);
    lines.push(`file '${join(cdir, `${String(i + 1).padStart(3, "0")}.png`)}'`, `duration ${(c.end - Math.max(c.start, t)).toFixed(3)}`);
    t = c.end;
  });
  lines.push(`file '${join(cdir, "blank.png")}'`, `duration ${Math.max(0.1, tl.total - t).toFixed(3)}`, `file '${join(cdir, "blank.png")}'`);
  writeFileSync(join(work, "captions.ffconcat"), lines.join("\n"));
  // strip bottom sits just above the in-page caption bar (66 px at the bottom of live/replay scenes)
  ffmpeg([
    "-i", video, "-i", narration, "-f", "concat", "-safe", "0", "-i", join(work, "captions.ffconcat"),
    "-filter_complex", `[2:v]fps=${FPS},format=rgba[c];[0:v][c]overlay=0:H-h-72:eof_action=pass,format=yuv420p[v]`,
    "-map", "[v]", "-map", "1:a", ...X264, ...common, "-t", String(tl.total), final,
  ]);
} else if (mode === "soft") {
  ffmpeg(["-i", video, "-i", narration, "-i", srt, "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "copy", ...common, "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-t", String(tl.total), final]);
} else {
  ffmpeg(["-i", video, "-i", narration, "-map", "0:v", "-map", "1:a", "-c:v", "copy", ...common, "-t", String(tl.total), final]);
}
console.log(`\n${final} (captions: ${mode}), ${duration(final).toFixed(2)}s; sidecar ${srt}`);
