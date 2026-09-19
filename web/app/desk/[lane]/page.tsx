import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { CONTAINER } from "@/components/brand/Container";
import { PageHeader } from "@/components/brand/PageHeader";
import LaneDesk from "@/components/desk/LaneDesk";
import { short } from "@/lib/desk/format";

type Props = { params: Promise<{ lane: string }> };

export async function generateMetadata(props: Props) {
  const { lane } = await props.params;
  return { title: `Desk ${isAddress(lane) ? short(lane) : ""} · DeltaDesk` };
}

export default async function LanePage(props: Props) {
  const { lane } = await props.params;
  if (!isAddress(lane)) notFound();
  return (
    <main className={`${CONTAINER} space-y-10 py-12 md:space-y-14 md:py-16`}>
      <PageHeader
        label="Desk · NVDA/USDG · Robinhood Chain"
        title="This desk’s books"
        italic="books"
        lede={
          <p>
            Read from the lane contract every 5 s: what it holds, where its ranges sit, the on-chain budget it has left and what the agent last decided. The owner controls are
            signed by the Vault in your browser and work without the agent.
          </p>
        }
      />
      <LaneDesk lane={getAddress(lane)} />
    </main>
  );
}
