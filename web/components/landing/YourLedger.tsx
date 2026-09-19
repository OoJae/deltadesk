import { CONTAINER } from "@/components/brand/Container";
import { Label } from "@/components/brand/Label";
import { PageHeader } from "@/components/brand/PageHeader";
import { LedgerForm } from "./LedgerForm";

// The tearsheet's line items, as a blank certificate the tearsheet fills in (labels only: no invented numbers).
const LINES = [
  { k: "Fees earned", d: "what your ranges collected, kept by you" },
  { k: "Taken by informed flow", d: "marked to Hyperliquid, 1 h after each swap" },
  { k: "Impermanent loss", d: "against simply holding the two tokens" },
  { k: "Price P&L", d: "the stock's own move over your holding" },
  { k: "Gas", d: "every mint, collect and burn you paid for" },
  { k: "Net", d: "per $1k, with the reconciliation residual shown" },
];

export function YourLedger() {
  return (
    <section aria-label="Your ledger" className="border-t border-rule">
      <div className={`${CONTAINER} grid gap-12 py-20 md:py-32 lg:grid-cols-12 lg:gap-8`}>
        <div className="lg:col-span-6">
          <PageHeader
            as="h2"
            label="Your ledger · Tearsheet"
            title="Your position, itemised."
            italic="itemised"
            lede={
              <p>
                Paste the wallet that holds your LP position. The tearsheet splits what it made into fees, what informed flow took, and what the
                price did, each per $1k, so you can see whether the fees paid for the risk.
              </p>
            }
          />
          <div className="mt-10 max-w-[36rem]">
            <LedgerForm />
          </div>
        </div>
        <div className="lg:col-span-5 lg:col-start-8">
          <div className="relative border border-rule bg-vault-2">
            <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
              <Label>Tearsheet · per $1k</Label>
              <Label tone="mute">Your wallet</Label>
            </div>
            <dl className="ledger-ruled">
              {LINES.map((l) => (
                <div key={l.k} className="grid grid-cols-[1fr_auto] items-baseline gap-4 px-5 py-4">
                  <dt>
                    <span className={`block ${l.k === "Net" ? "text-paper" : "text-paper"}`}>{l.k}</span>
                    <span className="block text-sm text-paper-mute">{l.d}</span>
                  </dt>
                  <dd className="w-24 border-b border-dashed border-rule-strong pb-1 text-right font-mono text-paper-mute">
                    <span className="sr-only">filled in on the tearsheet</span>
                    <span aria-hidden="true">$ ——</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="mt-3 text-sm text-paper-mute">Also over x402 for agents: $0.05 a call, and a failed call is not charged.</p>
        </div>
      </div>
    </section>
  );
}
