import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEMO } from "./beats.mjs";

export const LEAD = 0.35; // silence before each beat's narration
export const TAIL = 0.45; // minimum silence after it
export const FPS = 30;
export const VOICE_DIR = join(DEMO, "voice");

export function run(cmd, args, { quiet = true } = {}) {
  const r = spawnSync(cmd, args, { stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim().split("\n").slice(-6).join("\n");
    throw new Error(`${cmd} ${args.slice(0, 6).join(" ")}… failed (${r.status}):\n${err}`);
  }
  return r.stdout?.toString() ?? "";
}

export const ffmpeg = (args) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export function duration(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}

// A user-supplied voice file for a beat: demo/voice/<beat-id>.(m4a|wav|aiff|mp3)
export function userVoice(id) {
  for (const ext of ["m4a", "wav", "aiff", "mp3"]) {
    const f = join(VOICE_DIR, `${id}.${ext}`);
    if (existsSync(f)) return f;
  }
  return null;
}
