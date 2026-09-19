export type NavLink = { href: string; label: string; note: string; prefetch?: false };

/** Primary navigation, in reading order. */
export const NAV_LINKS: NavLink[] = [
  { href: "/study", label: "Study", note: "Every swap, marked to the 24/7 price" },
  { href: "/live", label: "Live desk", note: "The pool against fair value, now" },
  { href: "/tearsheet", label: "Tearsheet", note: "Check your LP position" },
  { href: "/league", label: "League", note: "Managers ranked by what they kept" },
  { href: "/console", label: "Console", note: "The agent's decisions, on-chain" },
  { href: "/brand", label: "Brand", note: "The engraved certificate" },
];

/** The one CTA. /desk is never prefetched: it mounts the wallet SDK, which loads only when a desk page opens. */
export const DESK_LINK: NavLink = { href: "/desk", label: "Start a desk", note: "Your own lane, bounded on-chain", prefetch: false };
