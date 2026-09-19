import { CONTAINER } from "@/components/brand/Container";
import { PageHeader } from "@/components/brand/PageHeader";
import StartDesk from "@/components/desk/StartDesk";

export const metadata = { title: "Start a desk · DeltaDesk" };

export default function DeskPage() {
  return (
    <main className={`${CONTAINER} space-y-12 py-12 md:space-y-16 md:py-16`}>
      <PageHeader
        label="Start a desk · Robinhood Chain"
        title="Your own market‑making desk" /* U+2011: the compound never breaks at its hyphen */
        italic="desk"
        lede={
          <p>
            A desk is a lane contract that provides NVDA/USDG liquidity for you. Your Vault owns it and is the only place money can go. An agent runs it through a separate
            Operator wallet that the contract fences in: tight caps, no withdrawals, no swaps, and a pause and exit you can always pull yourself.
          </p>
        }
      />
      <StartDesk />
    </main>
  );
}
