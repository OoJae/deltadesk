import { PageHeader } from "@/components/brand/PageHeader";
import { Stat } from "@/components/brand/Stat";
import { DataSection, SectionHead } from "@/components/ledger/SectionHead";
import { Marginalia, N, PAGE } from "@/components/ledger/ui";
import { getPublicFeed } from "@/lib/console/feed";
import LaneActionsPanel from "./LaneActionsPanel";
import LivePanel from "./LivePanel";
import ReplaysPanel from "./ReplaysPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Desk console · DeltaDesk" };

// Public, read-only console of the desk agent: live lanes and decisions (agent public feed), the lanes' on-chain
// LaneAction events, and replays of the agent's own regime machine over historical weekends. No wallet SDK here.
export default async function ConsolePage() {
  const initial = await getPublicFeed();
  return (
    <main className={PAGE}>
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-x-8">
        <PageHeader
          className="lg:col-span-8"
          label="Desk console · Robinhood Chain"
          title="What the desk sees, decides and signs"
          italic="signs"
          lede={
            <p>
              DeltaDesk&apos;s agent runs each lane through a market-regime machine and a set of gates before any liquidity moves. This page shows that
              state live, the lanes&apos; on-chain record on Robinhood Chain, and replays of the same machine over past weekends.
            </p>
          }
        />
        <Marginalia
          className="lg:col-span-3 lg:col-start-10 lg:self-end"
          items={[
            { k: "Chain", v: <span className="num">Robinhood Chain · 4663</span> },
            { k: "Feed", v: "desk agent, public" },
            { k: "Access", v: "read-only, no wallet" },
          ]}
        />
      </div>

      <DataSection labelledBy="console-live" first>
        <SectionHead
          id="console-live"
          label="Live desk · desk agent public feed"
          title="The lanes, now."
          italic="now."
          lede={<p>Registered lanes, the regime and gates now, the decision log and gate signals (desk agent public feed).</p>}
        />
        <div className="mt-10 md:mt-14">
          <LivePanel initial={initial} />
        </div>
      </DataSection>

      <DataSection labelledBy="console-chain">
        <SectionHead
          id="console-chain"
          label="On-chain LaneAction feed · Robinhood Chain"
          title="The record the chain keeps."
          italic="the chain"
          lede={
            <p>
              Every rerange, exit, collect and signal of the registered lanes, read directly from Robinhood Chain (4663); links go to Blockscout.
            </p>
          }
        />
        <div className="mt-10 md:mt-14">
          <LaneActionsPanel />
        </div>
      </DataSection>

      <DataSection labelledBy="console-replays">
        <SectionHead
          id="console-replays"
          label="Replays · historical data, not live"
          title="The same machine, over past weekends."
          italic="past weekends."
          lede={<p>The agent&apos;s own calendar, freshness rules, gates and lane A strategy run tick by tick (5 s) over historical windows.</p>}
        />
        <div className="mt-10 md:mt-14">
          <ReplaysPanel />
        </div>
      </DataSection>

      <DataSection labelledBy="console-economics">
        <SectionHead
          id="console-economics"
          label="Economics at M2 size"
          title="What a small lane can and cannot do."
          italic="cannot"
          lede={<p>An honest note on what a ~$50 lane can and cannot do.</p>}
        />
        <div className="mt-10 grid gap-px border border-rule bg-rule sm:grid-cols-2 md:mt-14 lg:grid-cols-4">
          {[
            { k: "Gas per rerange", v: "$0.11", c: "measured: 653k gas at 0.062 gwei" },
            { k: "Cost hurdle", v: "$0.39", c: "the desk asks for at least 2× this in expected fees over the next hour" },
            { k: "A $50 position earns", v: "$0.001", c: "in a median hour; $0.009 in the best hour of the week" },
            { k: "A rerange pays from", v: "$4.3k", c: "of liquidity in the best hour; $36.7k in a median hour" },
          ].map((x) => (
            <div key={x.k} className="bg-vault-2 px-5 py-6 md:px-6 md:py-7">
              <Stat label={x.k} value={x.v} caption={x.c} size="lg" />
            </div>
          ))}
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-12 lg:gap-x-8">
          <div className="space-y-4 text-body text-paper-dim lg:col-span-8">
            <p>
              M2 proves the delegated execution path and the owner&apos;s exit, not profitability. A rerange on Robinhood Chain costs about <N>$0.11</N> of
              gas (measured: 653k gas at 0.062 gwei), and the desk&apos;s cost hurdle prices it at <N>$0.39</N> and asks for at least <N>2×</N> that in
              expected fees over the next hour.
            </p>
            <p>
              A $50 position earns about <N>$0.001</N> in a median hour and <N>$0.009</N> in the best hour of the week (the engine&apos;s hour-of-week fee
              record for NVDA/USDG). So the initial placement is the one rerange that runs (its hurdle is waived); after it the lane holds until an exit. A
              rerange clears the hurdle only from roughly <N>$4,300</N> of liquidity (best hour) to <N>$36,700</N> (median hour).
            </p>
          </div>
          <p className="text-xs leading-relaxed text-paper-mute lg:col-span-4 lg:self-end">
            Source and full derivation: <code className="font-mono text-paper-dim">agent/README.md</code>, section &ldquo;Economics at M2 size&rdquo; (inputs
            measured on 2026-09-19; reproduced by <code className="font-mono text-paper-dim">agent/test/unit/strategy/economics.test.ts</code>). Not
            investment advice.
          </p>
        </div>
      </DataSection>
    </main>
  );
}
