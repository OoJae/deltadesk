import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The static engraving (scripts/relief-svg.mjs, same JSON as the WebGL relief), inlined: it paints with the first
// byte of HTML, never waits on a request, and an inline <svg> is not an LCP candidate, so the headline stays the LCP.
let cached: string | null = null;
function svg(): string {
  if (cached) return cached;
  try {
    const raw = readFileSync(join(process.cwd(), "public/relief/weekend-2026-09-11.svg"), "utf8");
    cached = raw
      .replace(/<svg([^>]*?) width="\d+" height="\d+"/, '<svg$1 preserveAspectRatio="xMidYMid meet" focusable="false"')
      .replace(/role="img" aria-label="[^"]*"/, 'aria-hidden="true"')
      .replace(/<title>[\s\S]*?<\/title>/, "")
      .replace(/<desc>[\s\S]*?<\/desc>/, "");
  } catch {
    cached = "";
  }
  return cached;
}

export function ReliefPoster({ className }: { className?: string }) {
  return <div aria-hidden="true" className={className} dangerouslySetInnerHTML={{ __html: svg() }} />;
}
