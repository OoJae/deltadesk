#!/usr/bin/env node
// Records demo scenes into demo/out/scenes/<beat-id>.webm (+ .json with the trim offset).
//   node demo/record/run.mjs                       all scenes (pending ones skip)
//   node demo/record/run.mjs --scenes study,x402   by slug, number ("02") or id ("02-study")
//   node demo/record/run.mjs --dry                 print the plan and probe each URL; records nothing
//   node demo/record/run.mjs --headed              watch it drive the browser
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { DEMO, OUT, loadBeats, loadConfig } from "../build/beats.mjs";
import { recordScene } from "./lib/harness.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const cfg = loadConfig();
const beats = loadBeats(cfg);
const sceneDir = join(DEMO, "record", "scenes");
const files = readdirSync(sceneDir).filter((f) => /^\d\d-.+\.mjs$/.test(f)).sort();
const wanted = opt("--scenes")?.split(",").map((s) => s.trim()).filter(Boolean);
const pick = (b) => !wanted || wanted.some((w) => w === b.id || w === b.slug || w === b.num);

const outDir = join(OUT, "scenes");
mkdirSync(outDir, { recursive: true });

const plan = [];
for (const b of beats.filter(pick)) {
  const file = files.find((f) => f === `${b.id}.mjs`);
  if (!file) {
    plan.push({ b, skip: "no scene file" });
    continue;
  }
  const mod = (await import(join(sceneDir, file))).default;
  const missing = [...new Set([...b.missing, ...(mod.requires ?? []).filter((k) => !(cfg.placeholders?.[k] ?? "").trim())])];
  plan.push({ b, mod, skip: missing.length ? `needs ${missing.map((k) => `{{${k}}}`).join(", ")}` : null });
}
if (wanted && plan.length === 0) {
  console.error(`no beat matches --scenes ${wanted.join(",")}; ids: ${beats.map((b) => b.id).join(", ")}`);
  process.exit(2);
}

if (flag("--dry")) {
  for (const { b, mod, skip } of plan) {
    const urls = mod?.urls ? mod.urls(cfg) : [];
    console.log(`${b.id.padEnd(20)} ${String(b.duration).padStart(3)}s ${b.mode.padEnd(7)} ${skip ? `SKIP (${skip})` : "record"}`);
    for (const u of urls) {
      const r = await fetch(u, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000) }).then((x) => x.status, (e) => `ERR ${e.cause?.code ?? e.message}`);
      console.log(`    ${String(r).padEnd(5)} ${u}`);
    }
  }
  process.exit(0);
}

const browser = await chromium.launch({ headless: !flag("--headed") });
const results = [];
for (const { b, mod, skip } of plan) {
  if (skip) {
    console.log(`SKIP ${b.id}: ${skip}`);
    results.push([b.id, "skipped", skip]);
    continue;
  }
  const t = Date.now();
  let ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    try {
      console.log(`REC  ${b.id} (${b.duration}s, ${b.mode})${attempt > 1 ? ` retry ${attempt}` : ""}`);
      const overlay = mod.overlay ? mod.overlay(cfg, b) : {};
      const meta = await recordScene(browser, { cfg, beat: b, outDir, overlay }, (s) => mod.run(s));
      console.log(`  ok  ${b.id}.webm, trim ${meta.offset.toFixed(2)}s, ${((Date.now() - t) / 1000).toFixed(0)}s wall`);
      results.push([b.id, "recorded", `${meta.offset.toFixed(2)}s offset`]);
      ok = true;
    } catch (e) {
      console.error(`  FAIL ${b.id}: ${e.message.split("\n")[0]}`);
      if (attempt === 2) results.push([b.id, "failed", e.message.split("\n")[0]]);
    }
  }
}
await browser.close();
console.log("\nsummary");
for (const [id, st, note] of results) console.log(`  ${id.padEnd(20)} ${st.padEnd(9)} ${note}`);
process.exit(results.some((r) => r[1] === "failed") ? 1 : 0);
