// Default M2 caps for lane A (docs/m2-design-contracts.md, "Default M2 caps"; first live mint about $50).
// Field order and widths follow IDeskTypes.Caps.

export type Caps = {
  maxDeployUsd6: bigint;
  turnoverUsd6PerDay: bigint;
  placeBandBps: number;
  maxTickDelta: number;
  minWidthTicks: number;
  maxWidthTicks: number;
  reranges1h: number;
  reranges24h: number;
  minRerangeInterval: number;
  maxDeadlineAhead: number;
  maxRanges: number;
};

export const DEFAULT_CAPS: Caps = {
  maxDeployUsd6: BigInt(60_000_000),
  turnoverUsd6PerDay: BigInt(150_000_000),
  placeBandBps: 100,
  maxTickDelta: 10,
  minWidthTicks: 20,
  maxWidthTicks: 2000,
  reranges1h: 4,
  reranges24h: 24,
  minRerangeInterval: 300,
  maxDeadlineAhead: 120,
  maxRanges: 2,
};

/** Human rows for the caps table (label, formatted value, what it bounds). */
export function capsRows(c: Caps): { label: string; value: string; note: string }[] {
  const usd = (x: bigint) => `$${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return [
    { label: "Max deploy per rerange", value: usd(c.maxDeployUsd6), note: "fence-valued notional minted in one rerange" },
    { label: "Daily turnover", value: usd(c.turnoverUsd6PerDay), note: "token bucket, refills over 24 h" },
    { label: "Placement band", value: `${c.placeBandBps} bp`, note: "no range may sit further than this from the Chainlink reference" },
    { label: "Max tick move", value: `${c.maxTickDelta} ticks`, note: "pool may move at most this between plan and execution" },
    { label: "Range width", value: `${c.minWidthTicks}–${c.maxWidthTicks} ticks`, note: "spacing 10" },
    { label: "Reranges", value: `${c.reranges1h}/h · ${c.reranges24h}/day`, note: `at least ${c.minRerangeInterval / 60} min apart` },
    { label: "Deadline", value: `≤ ${c.maxDeadlineAhead} s`, note: "every agent action expires quickly" },
    { label: "Live positions", value: String(c.maxRanges), note: "no swaps in M2" },
  ];
}
