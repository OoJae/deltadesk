// The staged prompt injection against the delegated Operator and what Dynamic's policy did with it. Needs {{DENIAL_LOG}}:
//   - an http(s) URL of a page showing the denial, or
//   - a repo file: docs/m2-desk.md (the committed record; its §3 "Policy findings" table is shown), a signer-check
//     report (agent/data/signer-check/<file>.json; chain, token and outcome are read from it), or a .txt/.log/.png.
// The card never asserts an outcome itself: headlines come from the record. What the record says (docs/m2-desk.md §3):
// the denial happened on Base (Dynamic's co-signer never signed); on Robinhood Chain, Dynamic's policies are not
// supported yet, and the lane contract is the fence.
// Safety: only those extensions, only files inside the repo, never key/env files, and the text is scanned for secrets
// before anything is rendered on camera.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { DEMO } from "../../build/beats.mjs";
import { page as card, terminal, TERM_CSS, esc } from "../lib/cards.mjs";

const REPO = join(DEMO, "..");
const TEXT = [".json", ".txt", ".log", ".md"];
const IMAGE = [".png", ".jpg", ".jpeg", ".webp"];
const CHAINS = { 1: "Ethereum", 8453: "Base", 4663: "Robinhood Chain" };

export function resolveRecord(v) {
  const cand = isAbsolute(v) ? [v] : [join(REPO, v), join(DEMO, v)];
  const file = cand.find(existsSync);
  if (!file) throw new Error(`DENIAL_LOG file not found: ${v}`);
  const real = realpathSync(file);
  if (relative(realpathSync(REPO), real).startsWith("..")) throw new Error(`DENIAL_LOG must be inside the repo: ${v}`);
  const name = basename(real).toLowerCase();
  if (/\.(pem|key|p12|pfx|keystore)$/.test(name) || name.startsWith(".env") || /private|secret|id_rsa|mnemonic/.test(name)) throw new Error(`DENIAL_LOG refuses key or env files: ${v}`);
  const ext = extname(real).toLowerCase();
  if (![...TEXT, ...IMAGE].includes(ext)) throw new Error(`DENIAL_LOG must be ${[...TEXT, ...IMAGE].join("/")}: ${v}`);
  return { file: real, ext };
}

// Refuse to put anything on camera that looks like a secret.
export function assertNoSecrets(text, label) {
  const bad = [
    [/-----BEGIN [A-Z ]*(PRIVATE|RSA|EC|OPENSSH|ENCRYPTED)[A-Z ]*-----/, "a PEM key block"],
    [/["']?(private[_ -]?key|secret|mnemonic|seed[_ ]?phrase|api[_-]?key|password|passphrase|bearer|authorization|cookie)["']?\s*[:=]\s*["']?[^\s"',}]{8,}/i, "a secret-looking field"],
    [/^\s*(export\s+)?[A-Z][A-Z0-9_]{2,}=\S{12,}/m, "an env-style assignment"],
    [/[A-Za-z0-9+/]{120,}={0,2}/, "a long base64 blob"],
  ];
  for (const [re, what] of bad) if (re.test(text)) throw new Error(`DENIAL_LOG ${label} contains ${what}; refusing to render it`);
}

const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, '<span class="mono" style="font-size:.9em">$1</span>');

// docs/m2-desk.md §3: the "Policy findings" table and the conclusion under it.
export function policyFindings(md) {
  const sec = md.split(/^## /m).find((x) => /^3 · /.test(x));
  if (!sec) throw new Error("docs/m2-desk.md has no section 3");
  const heading = sec.split("\n", 1)[0].trim();
  const lines = sec.split("\n");
  const at = lines.findIndex((l) => /\*\*Policy findings/.test(l));
  if (at < 0) throw new Error("docs/m2-desk.md §3 has no Policy findings table");
  const table = [];
  let i = at + 1;
  while (i < lines.length && !lines[i].startsWith("|")) i++;
  for (; i < lines.length && lines[i].startsWith("|"); i++) table.push(lines[i]);
  const rows = table.filter((l) => !/^\|\s*-/.test(l)).map((l) => l.replace(/^\||\|$/g, "").split(" | ").map((c) => c.trim()));
  const note = lines.slice(i).join("\n").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
  return { heading, head: rows[0], rows: rows.slice(1), note };
}

function mdView(md, v) {
  const f = policyFindings(md);
  const denied = f.rows.filter((r) => /DENIED/.test(r[1] ?? ""));
  if (!denied.length) throw new Error("the Policy findings table records no DENIED probe");
  const tr = (r) => `<tr class="${/DENIED/.test(r[1]) ? "den" : /not enforced|refused/i.test(r[1]) ? "gap" : ""}"><td>${inline(r[0])}</td><td>${inline(r[1] ?? "")}</td></tr>`;
  return {
    eyebrow: `Staged attack, real result · ${esc(v)} §${esc(f.heading)}`,
    h1: "A staged prompt injection told the Operator to move funds outside its allowlist. Dynamic's co-signer never signed.",
    sub: "Where Dynamic's policies don't reach yet (Robinhood Chain), the lane contract is the fence.",
    inner: `<table class="pf"><thead><tr><th>${inline(f.head[0])}</th><th>${inline(f.head[1])}</th></tr></thead><tbody>${f.rows.map(tr).join("")}</tbody></table>
      <p style="font-size:14.5px;color:var(--ink-2);margin-top:12px;line-height:1.45">${inline(f.note)}</p>`,
    hl: ".den",
  };
}

function jsonView(obj, v) {
  const dn = obj?.denial;
  if (!dn || !dn.outcome) throw new Error("DENIAL_LOG json has no denial.outcome (expected a signer-check report)");
  const chain = CHAINS[dn.chainId] ?? `chain ${dn.chainId}`;
  const verdict = dn.outcome === "denied" ? "Denied." : dn.outcome === "signed" ? "Signed: the policy did not enforce." : `No signature (${dn.code ?? "error"}).`;
  const text = JSON.stringify(obj, null, 2);
  return {
    eyebrow: `Staged attack, real result · signer-check report · ${esc(v)}`,
    h1: `Staged prompt injection: a token transfer on ${esc(chain)} (${esc(dn.token)}). ${esc(verdict)}`,
    sub: esc(dn.message ?? ""),
    inner: terminal(text.split("\n").slice(0, 24), { title: v, hl: /"outcome"|"code"|"message"|"chainId"/ }),
    hl: ".hl",
  };
}

export default {
  requires: ["DENIAL_LOG"],
  urls: (cfg) => [/^https?:/.test(cfg.placeholders.DENIAL_LOG ?? "") ? cfg.placeholders.DENIAL_LOG : null].filter(Boolean),
  overlay: (cfg) => {
    const v = (cfg.placeholders.DENIAL_LOG ?? "").trim();
    return { title: "Staged prompt injection against the delegated Operator · staged attack, recorded result", url: /^https?:/.test(v) ? "" : `${v} (committed record)` };
  },
  async run(s) {
    const { page } = s;
    const v = s.ph("DENIAL_LOG");
    if (/^https?:/.test(v)) {
      await s.goto(v, { waitFor: "body", settle: 1200 });
      await s.start();
      const el = await s.visible(page.locator("text=/denied|DENIED|SIGNER_DENIED|policy/"));
      if (el) {
        await s.scrollTo(el, { ms: 1000, offset: 220 });
        await s.highlight(el.locator("xpath=.."), { pad: 6 });
        await s.moveTo(el, { ms: 800 });
      }
      return;
    }
    const { file, ext } = resolveRecord(v);
    let view;
    if (IMAGE.includes(ext)) {
      const b64 = readFileSync(file).toString("base64");
      view = {
        eyebrow: `Staged attack, real result · ${esc(v)}`,
        h1: "Staged prompt injection against the delegated Operator: the recorded result",
        sub: "",
        inner: `<img src="data:image/${ext === ".jpg" ? "jpeg" : ext.slice(1)};base64,${b64}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;border:1px solid var(--ring)">`,
        hl: "img",
      };
    } else {
      const text = readFileSync(file, "utf8");
      assertNoSecrets(text, v);
      if (ext === ".md") view = mdView(text, v);
      else if (ext === ".json") view = jsonView(JSON.parse(text), v);
      else
        view = {
          eyebrow: `Staged attack, real result · ${esc(v)}`,
          h1: "Staged prompt injection against the delegated Operator: the recorded result",
          sub: "",
          inner: terminal(text.split("\n").slice(0, 24), { title: v, hl: /denied|DENIED|SIGNER_DENIED|signed|outcome/ }),
          hl: ".hl",
        };
    }
    await s.setContent(
      card(
        `<div class="wrap" style="padding:40px 80px 100px;gap:14px">
          <div><div class="eyebrow">${view.eyebrow}</div>
          <h1 style="font-size:32px;line-height:1.16;margin-top:8px;max-width:1120px">${view.h1}</h1>
          ${view.sub ? `<p style="font-size:17px;color:var(--ink-2);margin-top:6px">${view.sub}</p>` : ""}</div>
          <div class="fade" style="flex:1;min-height:0">${view.inner}</div>
        </div>`,
        {
          css: `${TERM_CSS}.term{height:100%}
.pf{width:100%;border-collapse:collapse;font-size:14.5px;line-height:1.38;background:var(--surface-1);border:1px solid var(--ring);border-radius:14px;overflow:hidden}
.pf th{text-align:left;font-weight:600;padding:8px 14px;background:var(--surface-2);color:var(--ink-2);font-size:13px;letter-spacing:.04em;text-transform:uppercase}
.pf td{padding:8px 14px;border-top:1px solid var(--grid);vertical-align:top}
.pf td:first-child{width:52%}
.pf tr.den td{background:rgba(27,175,122,.10)} .pf tr.den td:first-child{box-shadow:inset 4px 0 0 #2fbf71}
.pf tr.gap td{background:rgba(250,178,25,.10)}`,
        },
      ),
    );
    await s.start();
    const hl = await s.visible(page.locator(view.hl));
    if (hl) {
      await s.wait(1200);
      await s.highlight(hl, { pad: 4 });
      await s.moveTo(hl, { ms: 1200, dx: 260 });
    }
    await s.until(0.62);
    await s.clearHighlights();
    const gaps = page.locator("tr.gap");
    if ((await gaps.count()) > 0) {
      await s.highlightUnion([gaps.first(), gaps.nth(1)], { pad: 4 });
      await s.moveTo(gaps.first(), { ms: 900, dx: 200 });
    }
  },
};
