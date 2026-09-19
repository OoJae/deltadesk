"use client";

// The site's engraved stamp toast (components/brand/StampToast), for desk actions: a mode signed, an approval sent,
// the lane created, the delegation confirmed, an exit or withdrawal confirmed. app/layout.tsx mounts the provider for
// every page; where none is mounted (component tests render desk parts on their own) stamping is a no-op, so a missing
// toast can never break an action. The inline status line (TxLine) stays the record either way.
import { useStamp } from "@/components/brand/StampToast";

export type { StampKind } from "@/components/brand/StampToast";

type DeskStamp = ReturnType<typeof useStamp>;
const NONE: DeskStamp = { stamp: () => 0, dismiss: () => {} };

export function useDeskStamp(): DeskStamp {
  try {
    return useStamp();
  } catch {
    return NONE;
  }
}
