"use client";

import dynamic from "next/dynamic";

// three.js and the relief's code load in their own chunks, on the client, only on /.
const ReliefCanvas = dynamic(() => import("./relief/ReliefCanvas"), { ssr: false });

export function ReliefMount({ bookId }: { bookId: string }) {
  return <ReliefCanvas bookId={bookId} />;
}
