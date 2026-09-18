import LiveDesk from "@/components/LiveDesk";

export const metadata = { title: "Live desk · DeltaDesk" };

export default function LivePage() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">Live desk</p>
        <h1 className="text-3xl font-semibold">Is it safe to LP right now?</h1>
        <p className="max-w-2xl text-sm text-ink-2">
          Each Robinhood Chain stock pool against its 24/7 fair value from Hyperliquid, the market regime, and the pool&apos;s historical record for
          this hour of the week. Chainlink freezes while US markets are closed; the pools and Hyperliquid don&apos;t.
        </p>
      </header>
      <LiveDesk />
    </main>
  );
}
