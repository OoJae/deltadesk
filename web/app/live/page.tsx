import { PageHeader } from "@/components/brand/PageHeader";
import { Marginalia, PAGE } from "@/components/ledger/ui";
import LiveDesk from "@/components/LiveDesk";

export const metadata = { title: "Live desk · DeltaDesk" };

export default function LivePage() {
  return (
    <main className={PAGE}>
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-x-8">
        <PageHeader
          className="lg:col-span-8"
          label="Live desk · Robinhood Chain"
          title="Is it safe to LP right now?"
          italic="right now"
          lede={
            <p>
              Each Robinhood Chain stock pool against its 24/7 fair value from Hyperliquid, the market regime, and the pool&apos;s historical record for
              this hour of the week. Chainlink freezes while US markets are closed; the pools and Hyperliquid don&apos;t.
            </p>
          }
        />
        <Marginalia
          className="lg:col-span-3 lg:col-start-10 lg:self-end"
          items={[
            { k: "Fair value", v: "Hyperliquid × basis" },
            { k: "Oracle", v: "Chainlink" },
            { k: "Refresh", v: <span className="num">every 5 s</span> },
          ]}
        />
      </div>
      <div className="mt-16 md:mt-24">
        <LiveDesk />
      </div>
      <p className="mt-10 text-sm text-paper-mute">Informational analytics, not investment advice.</p>
    </main>
  );
}
