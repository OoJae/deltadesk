/**
 * pnpm exec tsx scripts/replay.ts [--in DIR] [--out DIR] [--web DIR] [--only ID]
 *
 * Runs the agent's own regime machine, gates and lane A strategy over the historical windows that
 * engine/replay_export.py exported (default ../data/replay/input/*.json) and writes labeled
 * timelines to ../data/replay/<id>.json and the console's copies to ../web/public/replays/<id>.json
 * (plus index.json). Read-only: no network, no chain, no keys.
 *
 *   cd engine && uv run python replay_export.py      # inputs
 *   cd agent && pnpm exec tsx scripts/replay.ts    # timelines
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReplayInput, REPLAY_LABEL } from "../src/replay/input.js";
import { runReplay } from "../src/replay/replay.js";
import type { HourRecord } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");

/** ERC-8056 effectiveAt per stock (read on-chain 2026-09-19 via eth_call; see the notes). */
const EFFECTIVE_AT: Record<string, { sec: number; note: string }> = {
  "NVDA/USDG": {
    sec: 1_788_998_430,
    note: "NVDA uiMultiplier step of Wed Sep 9 20:00 ET, read on-chain Sep 19: outside every NVDA window's 24 h horizon",
  },
  "SPY/USDG": {
    sec: 0,
    note: "SPY's current effectiveAt (Thu Sep 17) postdates the window; no step is known inside it",
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hourRecords(): HourRecord[] {
  const path = join(REPO, "agent", "test", "fixtures", "nvda_hour_records.json");
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    records: { how: number; fees_usd: number; swaps: number; edge_1h: number | null }[];
  };
  const out: HourRecord[] = new Array(168).fill(null).map(() => ({}));
  for (const r of doc.records)
    out[r.how] = { fees_usd: r.fees_usd, swaps: r.swaps, edge_1h: r.edge_1h };
  return out;
}

function main(): void {
  const inDir = resolve(arg("in") ?? join(REPO, "data", "replay", "input"));
  const outDir = resolve(arg("out") ?? join(REPO, "data", "replay"));
  const webDir = resolve(arg("web") ?? join(REPO, "web", "public", "replays"));
  const only = arg("only");
  const files = readdirSync(inDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => only === undefined || f === `${only}.json`)
    .sort();
  if (files.length === 0)
    throw new Error(`no replay inputs in ${inDir} (run engine/replay_export.py)`);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });
  const records = hourRecords();
  const index: Record<string, unknown>[] = [];

  for (const f of files) {
    const input = loadReplayInput(join(inDir, f));
    const ea = EFFECTIVE_AT[input.pool] ?? { sec: 0, note: "no uiMultiplier step known" };
    const started = Date.now();
    const timeline = runReplay(input, {
      hourRecords: input.pool === "NVDA/USDG" ? records : null,
      effectiveAtSec: ea.sec,
      effectiveAtNote: ea.note,
    });
    timeline.sources.push(
      "agent/test/fixtures/nvda_hour_records.json (engine hour_record(): hour-of-week fees for the cost hurdle)",
    );
    const json = JSON.stringify(timeline);
    writeFileSync(join(outDir, `${timeline.id}.json`), `${JSON.stringify(timeline, null, 1)}\n`);
    writeFileSync(join(webDir, `${timeline.id}.json`), json);
    index.push({
      id: timeline.id,
      title: timeline.title,
      pool: timeline.pool,
      mode: timeline.mode,
      window: timeline.window,
      headline: timeline.headline,
      rows: timeline.rows.length,
    });
    console.log(
      `\n${timeline.id} (${timeline.pool}, ${timeline.mode}): ${timeline.rows.length} rows, ${timeline.events.length} events, ${(json.length / 1024).toFixed(0)} KB, ${Date.now() - started} ms`,
    );
    for (const h of timeline.headline) console.log(`  - ${h}`);
  }

  // newest window first
  index.sort(
    (a, b) => (b.window as { startTs: number }).startTs - (a.window as { startTs: number }).startTs,
  );
  writeFileSync(
    join(webDir, "index.json"),
    JSON.stringify({ label: REPLAY_LABEL, generatedAt: new Date().toISOString(), replays: index }),
  );
  console.log(`\nwrote ${files.length} timeline(s) to ${outDir} and ${webDir}`);
}

main();
