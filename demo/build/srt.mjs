// Captions from script.md via the effective timeline: each beat's narration is split into short cues whose timing is
// proportional to their length across the beat's voice (or across the beat, when one full voiceover is used).
//   out/deltadesk-demo.srt   out/cues.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./beats.mjs";
import { LEAD, TAIL } from "./lib.mjs";

const MAX = 74; // chars per cue (at most two lines)
const MAX_TAIL = 84; // a trailing fragment under 12 chars may stretch its cue this far rather than flash on its own
const MIN_CUE = 0.9; // seconds; shorter cues are merged into a neighbour

function chunks(text) {
  const out = [];
  // sentence ends: . ! ? followed by a space and a capital (so "9 a.m. hour" and "$0.107" stay whole)
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z"“'‘])/)) {
    let s = sentence.trim();
    while (s.length > MAX) {
      // split at the last comma / colon / semicolon / dash before MAX, else the last space
      const window = s.slice(0, MAX);
      let i = Math.max(window.lastIndexOf(", "), window.lastIndexOf(": "), window.lastIndexOf("; "), window.lastIndexOf(" – "));
      if (i < MAX * 0.4) i = window.lastIndexOf(" ");
      out.push(s.slice(0, i + 1).trim());
      s = s.slice(i + 1).trim();
    }
    if (s) out.push(s);
  }
  // merge very short fragments into the previous cue
  const fits = (prev, c) => (c.length < 18 && prev.length + c.length < MAX) || (c.length < 12 && prev.length + c.length + 1 <= MAX_TAIL);
  return out.reduce((a, c) => (a.length && fits(a[a.length - 1], c) ? [...a.slice(0, -1), `${a[a.length - 1]} ${c}`] : [...a, c]), []);
}

function wrap(s) {
  if (s.length <= 42) return s;
  const mid = s.length / 2;
  let best = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? s : `${s.slice(0, best)}\n${s.slice(best + 1)}`;
}

const ts = (x) => {
  const ms = Math.round(x * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

const tl = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));
const cues = [];
for (const b of tl.beats) {
  if (!b.text) continue;
  const span = tl.full ? b.duration - LEAD - TAIL : b.voiceDur;
  const t0 = b.start + LEAD;
  // a cue that would show for under MIN_CUE joins its neighbour (the previous one, or the next for the first)
  const parts = chunks(b.text);
  for (let guard = 0; guard < 20 && parts.length > 1; guard++) {
    const tot = parts.reduce((a, p) => a + p.length, 0);
    const i = parts.findIndex((p) => (p.length / tot) * span < MIN_CUE);
    if (i < 0) break;
    const j = i === 0 ? 1 : i - 1;
    const [a, z] = [Math.min(i, j), Math.max(i, j)];
    parts.splice(a, 2, `${parts[a]} ${parts[z]}`);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  let t = t0;
  for (const p of parts) {
    const d = (p.length / total) * span;
    cues.push({ beat: b.id, start: +t.toFixed(3), end: +Math.min(t + d, b.start + b.duration - 0.05).toFixed(3), text: p });
    t += d;
  }
}
writeFileSync(join(OUT, "cues.json"), JSON.stringify(cues, null, 2));
writeFileSync(join(OUT, "deltadesk-demo.srt"), cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${wrap(c.text)}\n`).join("\n"));
console.log(`${cues.length} cues → out/deltadesk-demo.srt`);
