import type { ElementType, ReactNode } from "react";

/** The page measure shared by nav, footer and every page: max 90rem, 16 px gutters on phones, 32 px from md. */
export const CONTAINER = "mx-auto w-full max-w-[90rem] px-4 md:px-8";

export function Container({ as: Tag = "div", className, children }: { as?: ElementType; className?: string; children: ReactNode }) {
  return <Tag className={[CONTAINER, className].filter(Boolean).join(" ")}>{children}</Tag>;
}
