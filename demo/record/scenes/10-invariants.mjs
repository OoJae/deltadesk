// "It can only pay the owner": I1 from the contract design doc + the committed invariant campaign reports (real files).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO } from "../../build/beats.mjs";
import { invariantsCard } from "../lib/cards.mjs";

const REPO = join(DEMO, "..");
const LOCAL = "contracts/reports/local-2026-09-19-r2.txt";
const FORK = "contracts/reports/fork-archive-2026-09-19.txt";

export function evidence() {
  const doc = readFileSync(join(REPO, "docs/m2-design-contracts.md"), "utf8");
  const m = doc.match(/\*\*I1\. Outflows\.\*\*\s*([\s\S]*?)\n- \*\*I2/);
  if (!m) throw new Error("I1 not found in docs/m2-design-contracts.md");
  const i1 = m[1].replace(/\s+/g, " ").trim();

  const loc = readFileSync(join(REPO, LOCAL), "utf8").split("\n");
  const find = (lines, re) => lines.find((l) => re.test(l))?.trim();
  const inv = loc.find((l) => /\[invariant\]/.test(l))?.match(/\(\[invariant\][^)]*?\)?;/)?.[0] ?? "";
  const local = [
    { t: "$ forge test --no-match-path 'test/fork/**'", cls: "cmd" },
    { t: inv.replace(/^\(|\);?$|;$/g, "").replace(/\)$/, ""), cls: "dim" },
    find(loc, /^runs logged:/),
    find(loc, /^violations:/),
    { t: find(loc, /DeskInvariantsTest invariants \(runs:/), cls: "ok" },
    ...loc.filter((l) => /\[PASS\] invariant_I/.test(l)).map((l) => ({ t: l.trim(), cls: "ok" })),
  ].filter(Boolean);

  const fk = readFileSync(join(REPO, FORK), "utf8").split("\n");
  const fork = [
    { t: "$ FOUNDRY_PROFILE=fork forge test   # Robinhood Chain archive fork", cls: "cmd" },
    find(fk, /^result\s*:/),
    find(fk, /ForkFiftyReranges\s+1\/1/),
    find(fk, /ForkAdversarial\s+12\/12/),
    find(fk, /ForkInvariants\s+13 invariant/),
    find(fk, /^\s*runs logged:/),
    find(fk, /^\s*violations:/),
  ].filter(Boolean);
  return { i1, local: { file: LOCAL, lines: local }, fork: { file: FORK, lines: fork } };
}

export default {
  // Test evidence from committed reports, not a live surface: a grey TEST EVIDENCE badge, never the green LIVE one.
  overlay: () => ({ mode: "TEST EVIDENCE", url: `${LOCAL}  ·  ${FORK}`, title: "Invariant campaigns (committed reports) · the lane can only pay its owner" }),
  async run(s) {
    const { page } = s;
    await s.setContent(invariantsCard(evidence()));
    await s.start();
    await s.moveTo("p", { ms: 1000, dx: -300 });
    await s.until(0.3);
    const v = page.locator(".term-body .hl").first();
    await s.moveTo(v, { ms: 900, dx: -120 });
    await s.until(0.65);
    const f = page.locator(".term").nth(1).locator(".hl").last();
    await s.moveTo(f, { ms: 900, dx: -100 });
  },
};
