import { Button } from "@/components/brand/Button";
import { CONTAINER } from "@/components/brand/Container";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
import { PageHeader } from "@/components/brand/PageHeader";

const SCAN = "https://robinhoodchain.blockscout.com";
const short = (h: string) => `${h.slice(0, h.length > 42 ? 10 : 6)}…${h.slice(-4)}`;

const ROLES = [
  {
    name: "Vault",
    held: "You: a Dynamic embedded wallet, never delegated",
    can: ["Withdraw, all of it or one position NFT", "Revoke the operator, instantly", "Tighten caps, instantly", "Unpause the lane"],
    cannot: ["Be handed to the agent", "Name itself as operator (the factory refuses)"],
  },
  {
    name: "Operator",
    held: "DeltaDesk's agent, through Dynamic delegated access; holds only gas",
    can: ["Re-range from the lane's own inventory, never a swap", "Reduce, collect, exit, pause", "Log each decision on-chain (signal)"],
    cannot: [
      "Withdraw, or pay anyone but you",
      "Add risk while the market is closed",
      "Exceed $60 a re-range or $150 a day",
      "Place a range more than 100 bp off Chainlink",
    ],
  },
  {
    name: "Guardian",
    held: "The watchdog service: a third, separate key",
    can: ["Pause", "Reduce or flatten positions", "Extend a closure"],
    cannot: ["Anything that adds risk", "Anything that moves money out"],
  },
];

const PROOF = [
  { k: "Lane factory", v: "0x6968B97974aF2ba51537e751c043d5ba48d663B3", href: `${SCAN}/address/0x6968B97974aF2ba51537e751c043d5ba48d663B3`, note: "source-verified" },
  { k: "Lane A (NVDA/USDG)", v: "0x7f8968734E613f509991D3392074CF7f1e4bd662", href: `${SCAN}/address/0x7f8968734E613f509991D3392074CF7f1e4bd662`, note: "≈ $50.75 funded" },
  {
    k: "Gate signal: market closed",
    v: "0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375",
    href: `${SCAN}/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375`,
    note: "delegated signal()",
  },
  {
    k: "Gate signal: fair value restored",
    v: "0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223",
    href: `${SCAN}/tx/0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223`,
    note: "delegated signal()",
  },
];

export function TheDesk() {
  return (
    <section aria-label="The desk" className="border-t border-rule">
      <div className={`${CONTAINER} py-20 md:py-32`}>
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-7">
            <PageHeader
              as="h2"
              label="The desk · Robinhood Chain 4663"
              title="A desk of your own."
              italic="own"
              lede={
                <p>
                  Your lane is a contract that can only ever pay its owner. An agent runs it inside limits the contract enforces, and you can take it
                  back at any time. Three keys, three jobs:
                </p>
              }
            />
          </div>
        </div>

        {/* The certificate: the lane in the middle, three signatories under it. */}
        <div className="relative mt-12 border border-rule md:mt-16">
          <Guilloche variant="border" width={12} opacity={0.3} />
          <div className="relative m-3 border border-rule bg-vault md:m-4">
            <div className="flex flex-col gap-2 border-b border-rule px-5 py-5 md:flex-row md:items-baseline md:justify-between md:px-8">
              <div className="flex items-baseline gap-4">
                <Label tone="dim">The lane</Label>
                <span className="text-[1.05rem] text-paper">DeskLaneV3 · one per owner</span>
              </div>
              <span className="font-mono text-[0.78rem] text-paper-dim">Pays only its owner · no generic execute · approvals reset to 0</span>
            </div>
            <ol className="grid md:grid-cols-3">
              {ROLES.map((r, i) => (
                <li key={r.name} className={`relative px-5 py-7 md:px-8 md:py-9 ${i > 0 ? "border-t border-rule md:border-l md:border-t-0" : ""}`}>
                  <span aria-hidden="true" className="absolute -top-px left-5 h-6 w-px bg-rule-strong md:left-8" />
                  <h3 className="font-condensed text-[1.35rem] font-medium uppercase tracking-[0.06em] text-paper">{r.name}</h3>
                  <p className="mt-1.5 text-sm text-paper-mute">{r.held}</p>
                  <div className="mt-6 grid gap-5">
                    <div>
                      <Label as="p" tone="dim">
                        Can
                      </Label>
                      <ul className="mt-2 space-y-1.5 text-[0.95rem] text-paper">
                        {r.can.map((c) => (
                          <li key={c} className="flex gap-2.5">
                            <span aria-hidden="true" className="mt-[0.7em] h-px w-3 shrink-0 bg-paper-dim" />
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <Label as="p" tone="dim">
                        Cannot
                      </Label>
                      <ul className="mt-2 space-y-1.5 text-[0.95rem] text-paper-dim">
                        {r.cannot.map((c) => (
                          <li key={c} className="flex gap-2.5">
                            <span aria-hidden="true" className="font-mono text-[0.8rem] leading-[1.6] text-paper-mute">
                              ×
                            </span>
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-8">
            <Label as="h3">On-chain now · Blockscout</Label>
            <ul className="ledger-ruled mt-4 border-y border-rule">
              {PROOF.map((p) => (
                <li key={p.v} className="grid gap-1 py-3.5 sm:grid-cols-[15rem_1fr_auto] sm:items-baseline sm:gap-6">
                  <span className="text-paper">{p.k}</span>
                  <a
                    href={p.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[0.85rem] text-paper-dim underline decoration-rule-strong underline-offset-4 transition-colors hover:text-paper hover:decoration-paper"
                  >
                    {p.v.length > 42 ? (
                      short(p.v)
                    ) : (
                      <>
                        <span className="hidden xl:inline">{p.v}</span>
                        <span className="xl:hidden">{short(p.v)}</span>
                      </>
                    )}
                    <span aria-hidden="true"> ↗</span>
                  </a>
                  <span className="font-mono text-[0.72rem] uppercase tracking-[0.08em] text-paper-mute">{p.note}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col items-start justify-end gap-4 lg:col-span-4 lg:items-end">
            <p className="max-w-[34ch] text-paper-dim lg:text-right">Two wallets, created in one flow. The lane is yours from the first block.</p>
            <Button href="/desk" prefetch={false} size="lg" trailing="→">
              Start a desk
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
