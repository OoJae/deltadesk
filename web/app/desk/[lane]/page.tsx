import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
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
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <LaneDesk lane={getAddress(lane)} />
    </main>
  );
}
