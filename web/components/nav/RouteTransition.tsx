import { ViewTransition, type ReactNode } from "react";

/**
 * Page transition. Rendered by app/template.tsx, which Next remounts whenever the first path segment changes
 * (/live → /league), so this boundary exits with the old page and enters with the new one:
 * the outgoing certificate lifts and fades (0.6 s, --ease-out), the incoming one rises in (0.8 s).
 * Navigations inside a segment (/desk → /desk/[lane]) keep the template, so the desk's wallet providers never remount.
 * CSS: globals.css (.page-exit / .page-enter); reduced motion: none.
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="page-enter" exit="page-exit" default="none">
      {children}
    </ViewTransition>
  );
}
