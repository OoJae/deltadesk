// Console display helpers (client and server safe).

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (addr: string) => `${EXPLORER}/address/${addr}`;
export const short = (h: string, head = 6, tail = 4) => (h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);

/** IDeskTypes.Action by index (append-only on-chain). */
export const LANE_ACTION_NAMES = [
  "RERANGE", "REDUCE", "COLLECT", "EXIT_ALL", "WITHDRAW", "WITHDRAW_POSITION", "PAUSE", "UNPAUSE", "SIGNAL",
  "SET_OPERATOR", "SET_CAPS", "SET_CLOSED_UNTIL", "SET_GUARDIAN",
] as const;

/** Meta.regime codes (0 = unknown) and Meta.gatesMask bits, as the agent writes them. */
export const REGIME_BY_CODE = ["UNKNOWN", "REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"] as const;
export const GATE_ORDER = ["CLOSED", "HALT", "CORP-ACTION", "STALE-REF", "REOPEN-GUARD", "BOUND-PINNED", "WRAPPER-PREMIUM", "EVENT"] as const;
export const gatesOfMask = (mask: number) => GATE_ORDER.filter((_, i) => (mask & (1 << i)) !== 0);

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "Sat, Sep 12, 14:05 ET". */
export const etTime = (ms: number) => `${ET.format(new Date(ms))} ET`;

export function ago(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86_400).toFixed(1)} d`;
}
