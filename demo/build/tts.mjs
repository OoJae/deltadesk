// Narration per beat with macOS `say` (or the user's demo/voice/<beat-id>.m4a), fitted to the beat duration,
// then the effective timeline: a beat stretches (holding its last frame) only if its voice cannot fit.
//   out/voice/<id>.aiff  raw say output      out/voice/<id>.m4a  normalized AAC (review / hand-off)
//   out/voice/<id>.wav   normalized PCM (what the stitch uses)   out/timeline.json
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO, OUT, loadBeats, loadConfig } from "./beats.mjs";
import { LEAD, TAIL, VOICE_DIR, duration, ffmpeg, run, userVoice } from "./lib.mjs";

const VOICE = process.env.DEMO_VOICE || "Samantha";
const MIN_RATE = 172, MAX_RATE = 240; // Samantha sounds natural around 172-195 wpm
const dir = join(OUT, "voice");
mkdirSync(dir, { recursive: true });

const pron = Object.entries(JSON.parse(readFileSync(join(DEMO, "build", "pronounce.json"), "utf8"))).filter(([k]) => !k.startsWith("_"));
const spoken = (t) => pron.reduce((s, [re, to]) => s.replace(new RegExp(re, "g"), to), t);

function say(text, rate, out) {
  run("say", ["-v", VOICE, "-r", String(Math.round(rate)), "-o", out, text]);
  return duration(out);
}

function normalize(src, id) {
  const wav = join(dir, `${id}.wav`);
  ffmpeg(["-i", src, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000", "-ac", "2", "-c:a", "pcm_s16le", wav]);
  ffmpeg(["-i", wav, "-c:a", "aac", "-b:a", "192k", join(dir, `${id}.m4a`)]);
  return wav;
}

const cfg = loadConfig();
const beats = loadBeats(cfg);
const full = ["m4a", "wav", "aiff", "mp3"].map((e) => join(VOICE_DIR, `full.${e}`)).find(existsSync);
const timeline = [];
let t = 0;
for (const b of beats) {
  let voice = null, voiceDur = 0, source = "none", rate = null;
  if (full) {
    source = "full";
  } else if (userVoice(b.id)) {
    const f = userVoice(b.id);
    voice = normalize(f, b.id);
    voiceDur = duration(voice);
    source = `user:${f.replace(DEMO + "/", "")}`;
  } else if (b.text) {
    const text = spoken(b.text);
    const target = b.duration - LEAD - TAIL;
    const meta = join(dir, `${b.id}.json`);
    const key = { text, voice: VOICE, target, MIN_RATE, MAX_RATE };
    const cached = existsSync(meta) && JSON.parse(readFileSync(meta, "utf8"));
    if (cached && JSON.stringify(cached.key) === JSON.stringify(key) && existsSync(join(dir, `${b.id}.wav`))) {
      ({ rate, voiceDur } = cached);
      voice = join(dir, `${b.id}.wav`);
    } else {
      const aiff = join(dir, `${b.id}.aiff`);
      const words = text.split(/\s+/).length;
      rate = Math.min(MAX_RATE, Math.max(MIN_RATE, (words / target) * 60 * 1.05));
      let d = say(text, rate, aiff);
      for (let i = 0; i < 4 && d > target && rate < MAX_RATE; i++) {
        rate = Math.min(MAX_RATE, rate * (d / target) * 1.03);
        d = say(text, rate, aiff);
      }
      voice = normalize(aiff, b.id);
      voiceDur = duration(voice);
      writeFileSync(meta, JSON.stringify({ key, rate, voiceDur }, null, 2));
    }
    source = `say:${VOICE}@${Math.round(rate)}wpm`;
  }
  const dur = Math.max(b.duration, voice ? LEAD + voiceDur + 0.3 : 0);
  const stretched = dur > b.duration + 1e-6;
  timeline.push({ id: b.id, slug: b.slug, title: b.title, mode: b.mode, pending: b.pending, missing: b.missing, text: b.text, start: t, duration: +dur.toFixed(3), scriptDuration: b.duration, voice, voiceDur: +voiceDur.toFixed(3), source });
  console.log(`${b.id.padEnd(20)} ${voiceDur.toFixed(2).padStart(6)}s / ${String(b.duration).padStart(3)}s  ${source}${stretched ? `  STRETCHED to ${dur.toFixed(2)}s` : ""}`);
  t += dur;
}
if (full) {
  const wav = normalize(full, "full");
  console.log(`using ${full.replace(DEMO + "/", "")} (${duration(wav).toFixed(1)}s) as the whole narration`);
  copyFileSync(wav, join(dir, "full.wav"));
}
writeFileSync(join(OUT, "timeline.json"), JSON.stringify({ total: +t.toFixed(3), full: full ? join(dir, "full.wav") : null, beats: timeline }, null, 2));
console.log(`timeline ${t.toFixed(1)}s`);
