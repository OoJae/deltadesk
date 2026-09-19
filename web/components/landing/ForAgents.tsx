import { Button } from "@/components/brand/Button";
import { CONTAINER } from "@/components/brand/Container";
import { Label } from "@/components/brand/Label";
import { PageHeader } from "@/components/brand/PageHeader";

const BASE = "https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd";

// bankr.x402.json: every paid service, its price in USDC on Base, and what it takes.
const SERVICES = [
  { name: "safe-to-lp", price: "0.005", args: "?pool=NVDA", what: "ALLOW / CAUTION / BLOCK right now, with reasons: regime, the open guard, this hour's toxicity, the gap" },
  { name: "fair-value", price: "0.002", args: "?pool=NVDA", what: "24/7 fair value from Hyperliquid, basis-calibrated, against the pool mid and Chainlink" },
  { name: "pool-toxicity", price: "0.01", args: "?pool=NVDA", what: "How much informed flow LPs face, by market regime and hour of the week" },
  { name: "tearsheet", price: "0.05", args: "?wallet=0x…&chain=robinhood", what: "Any LP wallet's fees, informed flow, IL, gas and net, per $1k" },
  { name: "lp-league", price: "0.02", args: "?limit=20", what: "LP managers ranked by what they kept, with strategy fingerprints" },
];

const REPO = "https://github.com/OoJae/deltadesk";

export function ForAgents() {
  return (
    <section aria-label="For agents" className="border-t border-rule">
      <div className={`${CONTAINER} grid gap-12 py-20 md:py-32 lg:grid-cols-12 lg:gap-8`}>
        <div className="lg:col-span-5">
          <PageHeader
            as="h2"
            label="For agents · x402 on Bankr"
            title="Or let your agent ask."
            italic="ask"
            lede={
              <p>
                The same books, one paid call away. Each endpoint settles in USDC on Base over x402, and a failed call is not charged. The{" "}
                <span className="font-mono text-[0.92em] text-paper">lp-truth</span> skill wraps them for Bankr agents.
              </p>
            }
            actions={
              <>
                <Button href={`${REPO}/blob/main/skills/lp-truth/SKILL.md`} variant="ghost" trailing="↗">
                  lp-truth skill
                </Button>
                <Button href="https://github.com/BankrBot/skills/pull/729" variant="link" trailing="↗">
                  Bankr skills PR #729
                </Button>
              </>
            }
          />
        </div>
        <div className="min-w-0 lg:col-span-7">
          <div className="border border-rule bg-vault-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-5 py-3.5">
              <Label>Endpoint</Label>
              <Label tone="mute">GET · USDC on Base</Label>
            </div>
            <p className="overflow-x-auto whitespace-nowrap px-5 py-4 font-mono text-[0.82rem] text-paper" data-lenis-prevent>
              {BASE}/<span className="text-paper-dim">&lt;service&gt;</span>
            </p>
            <ul className="ledger-ruled border-t border-rule">
              {SERVICES.map((s) => (
                <li key={s.name} className="grid gap-1.5 px-5 py-4 sm:grid-cols-[10rem_1fr_auto] sm:gap-6">
                  <span className="font-mono text-[0.9rem] text-paper">
                    {s.name}
                    <span className="block text-[0.72rem] text-paper-mute sm:hidden">{s.args}</span>
                  </span>
                  <span className="text-[0.95rem] leading-snug text-paper-dim">
                    {s.what}
                    <span className="mt-1 hidden font-mono text-[0.75rem] text-paper-mute sm:block">{s.args}</span>
                  </span>
                  <span className="font-mono text-[0.9rem] tabular text-paper sm:text-right">${s.price}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-4 text-sm text-paper-mute">
            First settled call: <span className="font-mono">safe-to-lp?pool=NVDA</span>, $0.005, on Base in{" "}
            <a
              href="https://basescan.org/tx/0x309ddc0cbc51eccddf649fa001a25ecdc049179e402bc6dad91e798c8c8e6708"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-paper-dim underline decoration-rule-strong underline-offset-4 hover:text-paper"
            >
              0x309ddc0c…6708 ↗
            </a>
            , a self-test from our own wallet: it proves the path settles end to end, not outside demand.
          </p>
        </div>
      </div>
    </section>
  );
}
