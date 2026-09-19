// Parses demo/script.md into beats and resolves placeholders from demo/record/config.json.
// CLI: node demo/build/beats.mjs  → writes demo/out/beats.json and prints the rundown.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(DEMO, "out");

export function loadConfig() {
  return JSON.parse(readFileSync(join(DEMO, "record", "config.json"), "utf8"));
}

const PH = /\{\{([A-Z0-9_]+)\}\}/g;

export function filled(cfg, key) {
  const v = cfg.placeholders?.[key];
  return typeof v === "string" && v.trim() !== "";
}

// Substitute filled placeholders; drop any sentence that still holds an empty one.
export function resolveText(text, cfg) {
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"“'‘{])/).map((x) => `${x} `);
  return sentences
    .filter((s) => [...s.matchAll(PH)].every((m) => filled(cfg, m[1])))
    .map((s) => s.replace(PH, (_, k) => cfg.placeholders[k].trim()))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function quote(block, label) {
  const re = new RegExp(`\\*\\*${label}\\*\\*[^\\n]*\\n((?:>[^\\n]*\\n?)+)`);
  const m = block.match(re);
  if (!m) return "";
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^>\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function row(block, field) {
  const m = block.match(new RegExp(`^\\|\\s*${field}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, "m"));
  return m ? m[1] : "";
}

export function parseScript(md) {
  const parts = md.split(/^### /m).slice(1);
  const beats = [];
  for (const part of parts) {
    const head = part.split("\n", 1)[0];
    const hm = head.match(/^(\d\d) · ([a-z0-9-]+) · (.+)$/);
    if (!hm) continue;
    const [, num, slug, title] = hm;
    const time = row(part, "Time");
    const dm = time.match(/\((\d+(?:\.\d+)?)\s*s\)/);
    if (!dm) throw new Error(`beat ${num}-${slug}: no "(N s)" duration in the Time row`);
    const requires = [...row(part, "Requires").matchAll(PH)].map((m) => m[1]);
    beats.push({
      id: `${num}-${slug}`,
      num,
      slug,
      title: title.trim(),
      scriptTime: time.replace(/\s*\(.*\)/, ""),
      duration: Number(dm[1]),
      mode: (row(part, "Mode").match(/^[A-Z]+/) ?? ["CARD"])[0],
      surface: row(part, "Surface"),
      requires,
      narration: quote(part, "Narration"),
      draft: quote(part, "Draft narration"),
    });
  }
  return beats;
}

export function loadBeats(cfg = loadConfig()) {
  const beats = parseScript(readFileSync(join(DEMO, "script.md"), "utf8"));
  let t = 0;
  for (const b of beats) {
    b.missing = b.requires.filter((k) => !filled(cfg, k));
    b.pending = b.missing.length > 0;
    b.text = resolveText(b.pending && b.draft ? b.draft : b.narration, cfg);
    b.start = t;
    t += b.duration;
  }
  return beats;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const beats = loadBeats();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "beats.json"), JSON.stringify(beats, null, 2));
  let warn = 0;
  for (const b of beats) {
    const expect = `${fmt(b.start)}–${fmt(b.start + b.duration)}`;
    const flag = b.scriptTime !== expect ? `  (script says ${b.scriptTime})` : "";
    if (flag) warn++;
    console.log(`${b.id.padEnd(20)} ${expect.padEnd(10)} ${String(b.duration).padStart(3)}s ${b.mode.padEnd(7)} ${b.pending ? `PENDING ${b.missing.join(",")}` : "ready"}${flag}`);
  }
  const total = beats.reduce((a, b) => a + b.duration, 0);
  console.log(`total ${fmt(total)} (${total}s), ${beats.length} beats${warn ? `, ${warn} Time rows disagree with the cumulative durations` : ""}`);
}
