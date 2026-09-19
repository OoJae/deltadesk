"use client";

// Dynamic is mounted only under /desk, and only through DynamicShell, which is loaded lazily: nothing a desk page
// imports statically pulls in the SDK. A prefetch of /desk (the site nav links to it) therefore downloads no wallet code;
// the SDK arrives when a desk page actually renders.
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { DYNAMIC_ENV_ID } from "@/lib/desk/config";

const DynamicShell = dynamic(() => import("./DynamicShell"), {
  // Full height: on a client-side visit the page arrives with the SDK chunk, so a short shell would let the footer jump.
  loading: () => <p className="label mx-auto min-h-svh w-full max-w-[90rem] px-4 py-16 text-paper-mute md:px-8">Loading the desk…</p>,
});

export default function DeskProviders({ children }: { children: ReactNode }) {
  if (!DYNAMIC_ENV_ID) return <>{children}</>;
  return <DynamicShell environmentId={DYNAMIC_ENV_ID}>{children}</DynamicShell>;
}
