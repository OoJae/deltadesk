#!/usr/bin/env node
// Verify (and optionally fix) the line anchors in README.md and FEEDBACK.md.
//
//   node docs/notes/check-code-pointers.mjs          # report; exit 1 on any stale anchor
//   node docs/notes/check-code-pointers.mjs --fix    # rewrite README "Code pointers" anchors to where each symbol is now
//
// README code pointers are labelled with a symbol (e.g. [`DeskLaneV3.rerange`](contracts/src/DeskLaneV3.sol#L55));
// LABELS below says which text that line must contain, so the anchor can be re-found after other workstreams move
// code. Every other anchored link (e.g. in FEEDBACK.md) is checked for existence and, where TARGETS lists it, content.
// Run from the repo root before publishing. Zero dependencies.

import fs from "node:fs";

const LABELS = {
  "DeskLaneV3.rerange": "function rerange(",
  "DeskLaneV3._placement": "function _placement(",
  "RangeRules.check": "function check(",
  "DeskLaneV3._mintRange": "function _mintRange(",
  "DeskLaneV3.exitAll": "function exitAll(",
  "DeskLaneCore._spend": "function _spend(",
  "DeskLaneCore._admitRiskAdding": "function _admitRiskAdding(",
  "DeskLaneCore.signal": "function signal(",
  "DeskLaneCore.withdraw": "function withdraw(address",
  "ChainlinkFence.status": "function status(",
  "ChainlinkFence.isClosedWindow": "function isClosedWindow(",
  "DeskLaneFactory.createLane": "function createLane(",
  checkGuard: "export function checkGuard(",
  "guard allowlist": 'run("allowlist"',
  "guard signer-binding": 'run("signer-binding"',
  signVerifyPersist: "async function signVerifyPersist(",
  verifySignedTx: "export async function verifySignedTx(",
  createDelegatedSigner: "export function createDelegatedSigner(",
  createDynamicDelegatedSigner: "export function createDynamicDelegatedSigner(",
  verifyDynamicSignature: "export function verifyDynamicSignature(",
  "webhook decrypt": "async function decrypt(",
  createGateMachine: "export function createGateMachine(",
  regimeAt: "export function regimeAt(",
  costHurdle: "export const costHurdle",
  decideApproval: "export async function decideApproval(",
  reasonHashOf: "export function reasonHashOf(",
  plannedActions: "export function plannedActions(",
  decode_swaps: "def decode_swaps(",
  "pools.py fee split": 'if pool.venue == "v3":\n            total_pips',
  regime_at: "def regime_at(",
  calibrate_k: "def calibrate_k(",
  k_at: "def k_at(",
  mark_swaps: "def mark_swaps(",
  sweep: "def sweep(",
  "reconstruct_v3 linkage": "if t0 == T_NPM_INC:",
  reconstruct_v4: "def reconstruct_v4(",
  'SPECS["lp_txs"]': 'SPECS["lp_txs"] = Spec(',
  tearsheet: "def tearsheet(",
  rule_exprs: "def rule_exprs(",
  "gap_exclusion.run": "def run(out_dir",
  "league.build": "def build(",
  assess: "def assess(",
  pool_mid: "def pool_mid(",
  "x402 tearsheet": "export default async function handler",
  "x402 safe-to-lp": "export default async function handler",
};

// Anchors whose first line must contain a given text (FEEDBACK.md and other stable references).
const TARGETS = {
  "contracts/script/Addresses4663.sol#L8": "// Uniswap v3",
  "engine/positions/reconstruct.py#L40": "NPM = ",
  "engine/api/live.py#L25": "STATE_VIEW = ",
  "engine/markout/pools.py#L182": "else:",
  "engine/markout/pools.py#L111": "v3 protocol fee",
  "engine/positions/attribute.py#L146": "def sweep(",
  "engine/positions/reconstruct.py#L338": "if t0 == T_NPM_INC:",
  "engine/positions/reconstruct.py#L323": "if owner in npm_owned:",
  "engine/indexer/hs_backfill.py#L79": 'SPECS["lp_txs"]',
  "engine/positions/reconstruct.py#L405": "if sender == POSM:",
  "engine/markout/pools.py#L13": "v3 Swap amounts",
  "engine/markout/pools.py#L162": 'if pool.venue == "v4":',
  "contracts/src/libraries/PriceMath.sol#L5": "FullMath",
  "contracts/test/utils/V3Deployer.sol#L6": "REAL Uniswap v3",
  "contracts/src/DeskLaneFactory.sol#L83": "getPool",
  "contracts/src/DeskLaneV3.sol#L45": "V3_FACTORY()",
  "contracts/src/DeskLaneV3.sol#L232": "function _mintRange(",
  "contracts/src/ChainlinkFence.sol#L119": "18 to 8",
  "contracts/src/DeskLaneV3.sol#L120": "@inheritdoc IDeskLane",
  "engine/api/live.py#L90": "def pool_mid(",
};

const fix = process.argv.includes("--fix");
const LINK = /\[([^\]]+)\]\(([^)#\s]+)#L(\d+)(?:-L(\d+))?\)/g;
const cache = new Map();
const lines = (f) => {
  if (!cache.has(f)) cache.set(f, fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n") : null);
  return cache.get(f);
};
const lineHas = (L, n, want) => {
  const parts = want.split("\n");
  return parts.every((p, i) => (L[n - 1 + i] ?? "").includes(p));
};
const findLine = (L, want) => {
  const hits = [];
  for (let i = 1; i <= L.length; i++) if (lineHas(L, i, want)) hits.push(i);
  return hits;
};

let bad = 0;
let fixed = 0;
for (const doc of ["README.md", "FEEDBACK.md"]) {
  let text = fs.readFileSync(doc, "utf8");
  const edits = [];
  for (const m of text.matchAll(LINK)) {
    const [whole, rawLabel, file, a, b] = m;
    const label = rawLabel.replace(/`/g, "");
    const start = Number(a);
    const end = b ? Number(b) : start;
    const L = lines(file);
    if (!L) {
      console.log(`MISSING FILE  ${doc}: ${file}`);
      bad++;
      continue;
    }
    const want = LABELS[label] ?? TARGETS[`${file}#L${start}`];
    if (end > L.length) {
      console.log(`PAST EOF      ${doc}: ${file}#L${start}${b ? `-L${end}` : ""} (file has ${L.length} lines)`);
      bad++;
      continue;
    }
    if (!want) continue; // existence only
    if (lineHas(L, start, want)) {
      console.log(`ok            ${doc}: ${label} -> ${file}#L${start}`);
      continue;
    }
    const hits = findLine(L, want);
    if (hits.length !== 1) {
      console.log(`STALE         ${doc}: ${label} -> ${file}#L${start}; "${want.split("\n")[0]}" found ${hits.length} times`);
      bad++;
      continue;
    }
    const delta = hits[0] - start;
    const anchor = b ? `#L${start + delta}-L${end + delta}` : `#L${start + delta}`;
    console.log(`MOVED         ${doc}: ${label} -> ${file}#L${start} is now ${anchor}`);
    if (fix && LABELS[label]) {
      edits.push([whole, whole.replace(/#L\d+(?:-L\d+)?\)$/, `${anchor})`)]);
    } else bad++;
  }
  if (edits.length) {
    for (const [from, to] of edits) text = text.replace(from, to);
    fs.writeFileSync(doc, text);
    fixed += edits.length;
  }
}
console.log(`${bad === 0 ? "OK" : "PROBLEMS"}: ${bad} stale or missing, ${fixed} fixed`);
process.exit(bad === 0 ? 0 : 1);
