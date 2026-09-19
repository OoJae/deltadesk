// The Engraved Book's five acts: the real Sep 11–14 2026 weekend on the NVDA/USDG pool, in time order (the only
// place on the landing where "N°" numbering is true). Frame indexes point into public/relief/weekend-2026-09-11.json
// (one frame per 30 minutes from Fri 16:00 ET). Every figure is from that file or the replay it was built from.

export type ActStat = { label: string; value: string; unit?: string; caption?: string; tone?: "paper" | "serial" };

export type Act = {
  n: number;
  /** Frames the act plays, [from, to] inclusive. */
  frames: [number, number];
  /** Mono time stamp, ET. */
  time: string;
  title: string;
  /** The word set in Bodoni italic; must appear in `title`. */
  italic: string;
  body: string;
  stat: ActStat;
};

export const ACTS: Act[] = [
  {
    n: 1,
    frames: [0, 8],
    time: "Fri Sep 11 · 16:00 ET",
    title: "The bell rings.",
    italic: "rings",
    body:
      "Regular trading ends. NVDA keeps trading on Robinhood Chain, in a Uniswap pool that never closes. Each hairline is that pool's real liquidity at one moment, summed from every open position.",
    stat: { label: "Pool vs fair value", value: "0.3", unit: "bp", caption: "Pool 218.66 USDG, fair value 218.67. Nothing to pick off yet.", tone: "serial" },
  },
  {
    n: 2,
    frames: [8, 24],
    time: "Fri Sep 11 · 20:00 ET",
    title: "The feed freezes.",
    italic: "freezes",
    body:
      "Chainlink's NVDA price stops updating for the weekend and the lane's fence reads code 5, market closed. From here the lane contract refuses any step that adds risk.",
    stat: { label: "Chainlink frozen", value: "48", unit: "h", caption: "Fri 20:00 to Sun 20:00 ET. The pool keeps trading on a stale reference." },
  },
  {
    n: 3,
    frames: [24, 70],
    time: "Sat Sep 12 → Sun 03:00 ET",
    title: "The gap opens.",
    italic: "opens",
    body:
      "Hyperliquid trades NVDA all weekend; the pool lags behind it. Traders who watch both take from the liquidity in range. Each red scratch is one of the swaps that took the most.",
    stat: {
      label: "$1k kept in range, 48 h",
      value: "$4.24",
      caption: "paid to informed flow, against $3.32 earned in fees. Net −$0.92.",
    },
  },
  {
    n: 4,
    frames: [70, 104],
    time: "Sun Sep 13 · 03:00 → 20:00 ET",
    title: "The lane stands aside.",
    italic: "aside",
    body:
      "DeltaDesk's lane A, a $50 straddle placed on fair value before the close, was held: no new range, no top-up. NVDA slid out of its range at 03:10, and the contract refused every risk-adding step while the market was closed.",
    stat: { label: "Risk-adding steps while closed", value: "0", caption: "Blocked for the whole 48-hour window, on-chain, not by policy." },
  },
  {
    n: 5,
    frames: [104, 132],
    time: "Sun 20:00 → Mon Sep 14 · 09:45 ET",
    title: "The book reopens.",
    italic: "reopens",
    body:
      "The weekend window ends and the pool snaps toward Hyperliquid. The reopen guard holds, the closed gate clears at 21:00, and the agent plans a new straddle on fair value; its cost hurdle keeps the old one until moving is worth twice the gas.",
    stat: { label: "Gap at the wake, Sun 20:02 ET", value: "52.6", unit: "bp", caption: "The widest of the weekend, two minutes after the window ends.", tone: "serial" },
  },
];

/** The frame range the whole book covers (Fri 16:00 → Mon 09:45 ET). */
export const LAST_FRAME = 132;
