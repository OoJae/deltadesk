import StartDesk from "@/components/desk/StartDesk";

export const metadata = { title: "Start a desk · DeltaDesk" };

export default function DeskPage() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">Start a desk</p>
        <h1 className="text-3xl font-semibold">Your own market-making desk on Robinhood Chain</h1>
        <p className="max-w-2xl text-sm text-ink-2">
          A desk is a lane contract that provides NVDA/USDG liquidity for you. Your Vault owns it and is the only place money can go. An agent runs it through a
          separate Operator wallet that the contract fences in: tight caps, no withdrawals, no swaps, and a pause and exit you can always pull yourself.
        </p>
      </header>
      <StartDesk />
    </main>
  );
}
