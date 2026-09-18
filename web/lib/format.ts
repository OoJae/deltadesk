export const POOLS = ["NVDA/USDG", "SPY/USDG", "TSLA/USDG", "QQQ/SPY"] as const;
export const poolParam = (key: string) => key.split("/")[0] === "QQQ" ? "QQQ-SPY" : key.split("/")[0];

export function usd(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  const s = a >= 1e9 ? `$${(a / 1e9).toFixed(digits)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(digits)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(digits)}k` : `$${a.toFixed(2)}`;
  return x < 0 ? `−${s}` : s;
}
export const bps = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)} bp`);
export const ratio = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "–" : x >= 10 ? x.toFixed(0) : x.toFixed(2));
export const num = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "–" : Math.round(x).toLocaleString("en-US"));
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const REGIME_LABEL: Record<string, string> = {
  REGULAR: "Regular session", EXTENDED: "Pre / post market", OVERNIGHT: "Overnight", WEEKEND_DARK: "Weekend dark window", HOLIDAY: "Market holiday",
};
