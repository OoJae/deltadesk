import type { ReactNode } from "react";
import DeskProviders from "@/components/desk/DeskProviders";

// Dynamic's SDK is mounted here and nowhere else, so the rest of the site never loads wallet code.
export default function DeskLayout({ children }: { children: ReactNode }) {
  return <DeskProviders>{children}</DeskProviders>;
}
