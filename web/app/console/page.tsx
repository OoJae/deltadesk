import { getPublicFeed } from "@/lib/console/feed";
import LaneActionsPanel from "./LaneActionsPanel";
import LivePanel from "./LivePanel";
import ReplaysPanel, { ReplayBadge } from "./ReplaysPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Desk console · DeltaDesk" };

// Public, read-only console of the desk agent: live lanes and decisions (agent public feed), the lanes' on-chain
// LaneAction events, and replays of the agent's own regime machine over historical weekends. No wallet SDK here.
export default async function ConsolePage() {
  const initial = await getPublicFeed();
  return (
    <main className="mx-auto w-full max-w-5xl space-y-10 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">Desk console</p>
        <h1 className="text-3xl font-semibold">What the desk sees, decides and signs</h1>
        <p className="max-w-2xl text-sm text-ink-2">
          DeltaDesk&apos;s agent runs each lane through a market-regime machine and a set of gates before any liquidity moves. This page shows
          that state live, the lanes&apos; on-chain record on Robinhood Chain, and replays of the same machine over past weekends.
        </p>
      </header>

      <section className="space-y-3">
        <SectionHead title="Live desk" sub="Registered lanes, the regime and gates now, the decision log and gate signals (desk agent public feed)." />
        <LivePanel initial={initial} />
      </section>

      <section className="space-y-3">
        <SectionHead title="On-chain LaneAction feed" sub="Every rerange, exit, collect and signal of the registered lanes, read directly from Robinhood Chain (4663); links go to Blockscout." />
        <LaneActionsPanel />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SectionHead title="Replays" sub="The agent's own calendar, freshness rules, gates and lane A strategy run tick by tick (5 s) over historical windows." />
          <ReplayBadge />
        </div>
        <ReplaysPanel />
      </section>

      <section className="space-y-3">
        <SectionHead title="Economics at M2 size" sub="An honest note on what a ~$50 lane can and cannot do." />
        <div className="card space-y-3 p-5 text-sm text-ink-2">
          <p>
            M2 proves the delegated execution path and the owner&apos;s exit, not profitability. A rerange on Robinhood Chain costs about{" "}
            <strong className="text-ink">$0.11</strong> of gas (measured: 653k gas at 0.062 gwei), and the desk&apos;s cost hurdle prices it at{" "}
            <strong className="text-ink">$0.39</strong> and asks for at least <strong className="text-ink">2×</strong> that in expected fees over the next hour.
          </p>
          <p>
            A $50 position earns about <strong className="text-ink">$0.001</strong> in a median hour and <strong className="text-ink">$0.009</strong> in the best hour of the
            week (the engine&apos;s hour-of-week fee record for NVDA/USDG). So the initial placement is the one rerange that runs (its hurdle is waived);
            after it the lane holds until an exit. A rerange clears the hurdle only from roughly <strong className="text-ink">$4,300</strong> of liquidity (best hour)
            to <strong className="text-ink">$36,700</strong> (median hour).
          </p>
          <p className="text-xs text-muted">
            Source and full derivation: <code>agent/README.md</code>, section &ldquo;Economics at M2 size&rdquo; (inputs measured on 2026-09-19; reproduced by{" "}
            <code>agent/test/unit/strategy/economics.test.ts</code>). Not investment advice.
          </p>
        </div>
      </section>
    </main>
  );
}

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="max-w-3xl text-sm text-ink-2">{sub}</p>
    </div>
  );
}
