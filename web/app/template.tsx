import type { ReactNode } from "react";
import { RouteTransition } from "@/components/nav/RouteTransition";

// Remounted by Next on each first-segment change: that is what gives <ViewTransition> its enter/exit pair.
export default function Template({ children }: { children: ReactNode }) {
  return <RouteTransition>{children}</RouteTransition>;
}
