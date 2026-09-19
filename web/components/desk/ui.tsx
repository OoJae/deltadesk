"use client";

// The desk's small UI vocabulary, drawn with the brand kit (components/brand): ledger panels, mono addresses, status
// marks that are never colour alone, and the kit's Button. Destructive owner actions get the "void" treatment: a
// critical hairline over an engraver's cancellation hatch, so they read as different in form, not only in colour.
import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/brand/Button";
import { hatchTileSvg, svgDataUri } from "@/components/brand/geometry";
import { Label } from "@/components/brand/Label";
import { LedgerPanel } from "@/components/brand/LedgerPanel";
import { addressUrl, txUrl } from "@/lib/desk/chain";
import { short } from "@/lib/desk/format";
import type { TxState } from "./hooks";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";
const TONE: Record<Tone, { color: string; hex: string; icon: string }> = {
  good: { color: "var(--good)", hex: "#0ca30c", icon: "✓" },
  warning: { color: "var(--warning)", hex: "#fab219", icon: "!" },
  serious: { color: "var(--serious)", hex: "#ec835a", icon: "!" },
  critical: { color: "var(--critical)", hex: "#d03b3b", icon: "✕" },
  neutral: { color: "var(--paper-mute)", hex: "#8f8a7c", icon: "·" },
};

/** An engraver's cancellation hatch in a status colour (the "void" mark on a cancelled certificate). */
const hatch = (hex: string, opacity: number, gap = 5) => svgDataUri(hatchTileSvg({ color: hex, gap, angle: 135, width: 0.7, opacity })); // already url("…")
const VOID_HATCH = hatch(TONE.critical.hex, 0.42);
const VOID_HATCH_STRONG = hatch(TONE.critical.hex, 0.7, 4);

/** The status mark: a filled disc with a glyph (neutral is a hollow ring), always next to a text label. */
export function StatusIcon({ tone, size = 16, className = "" }: { tone: Tone; size?: number; className?: string }) {
  const t = TONE[tone];
  if (tone === "neutral")
    return (
      <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full border border-paper-mute ${className}`} style={{ width: size, height: size }}>
        <span className="h-1 w-1 rounded-full bg-paper-mute" />
      </span>
    );
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-mono font-medium leading-none text-vault ${className}`}
      style={{ width: size, height: size, background: t.color, fontSize: Math.round(size * 0.62) }}
    >
      {t.icon}
    </span>
  );
}

/** Status is never colour alone: an icon disc plus a text label. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-2 text-[0.9rem] leading-snug text-paper">
      <StatusIcon tone={tone} className="mt-[2px]" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** A stamped status tag for the lane header (mono small caps, hairline frame). */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="label inline-flex items-center gap-2 border border-rule-strong py-1.5 pr-3 pl-2 text-paper">
      <StatusIcon tone={tone} size={14} />
      {children}
    </span>
  );
}

type BtnKind = "primary" | "secondary" | "danger" | "ghost";

/**
 * The desk's button, on the kit's Button (press = scale .97 + guilloché sheen, focus = serial ring).
 * primary: serial fill, the one action of a step · secondary: hairline · ghost: underlined text ·
 * danger: critical hairline over a cancellation hatch (Pause, Exit all, Revoke). `strong` doubles the danger mark for the
 * final confirmation.
 */
export function Btn({
  kind = "secondary",
  size = "md",
  strong = false,
  className = "",
  style,
  children,
  ...p
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & { kind?: BtnKind; size?: "sm" | "md"; strong?: boolean; className?: string; children: ReactNode }) {
  if (kind === "danger")
    return (
      <Button
        {...p}
        variant="ghost"
        size={size}
        className={`text-paper ${strong ? "shadow-[inset_0_0_0_2px_var(--critical)]" : "shadow-[inset_0_0_0_1px_var(--critical)] hover:shadow-[inset_0_0_0_2px_var(--critical)]"} ${className}`}
        style={{ backgroundImage: strong ? VOID_HATCH_STRONG : VOID_HATCH, ...style }}
      >
        {children}
      </Button>
    );
  const variant = kind === "primary" ? "primary" : kind === "secondary" ? "ghost" : "link";
  return (
    <Button {...p} variant={variant} size={size} className={`${variant === "link" ? "min-h-10 text-[0.9rem]" : ""} ${className}`} style={style}>
      {children}
    </Button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="label shrink-0 px-1.5 py-1 text-paper-mute transition-colors hover:text-paper"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** Address chip: short form, copy, explorer link. `full` shows the whole address (for addresses users must paste). */
export function Addr({ address, full = false }: { address: string; full?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <a
        href={addressUrl(address)}
        target="_blank"
        rel="noreferrer"
        className={`font-mono text-[0.85rem] text-paper underline decoration-transparent underline-offset-4 transition-colors hover:decoration-rule-strong ${full ? "break-all" : ""}`}
        title={address}
      >
        {full ? address : short(address)}
      </a>
      <CopyButton text={address} />
    </span>
  );
}

/** A certificate blank: a mono label over the value it holds (an address to paste, a balance). */
export function Field({ label, aside, children, className = "" }: { label: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`space-y-2 border border-rule bg-vault px-3.5 py-3 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label as="div">{label}</Label>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** A certificate blank: the label, a dotted leader, and the value typed onto the line (use inside a <dl>). */
export function Blank({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-end gap-3">
      <dt className="label shrink-0 pb-1 text-paper-mute">{label}</dt>
      <dd className="flex min-w-0 flex-1 justify-end border-b border-dotted border-rule-strong pb-1">{children}</dd>
    </div>
  );
}

/** A blank not filled in yet ("sign in", "step 4"). */
export function Pending({ children }: { children: ReactNode }) {
  return <span className="text-sm italic text-paper-mute">{children}</span>;
}

/** A folded ledger panel (native <details>): mono label, title, and a + that turns to × when open. */
export function Disclosure({ title, label, children }: { title: ReactNode; label?: ReactNode; children: ReactNode }) {
  return (
    <details className="group border border-rule bg-vault-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-vault-3 md:px-6 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 space-y-1">
          {label != null && <Label className="block">{label}</Label>}
          <span className="block text-[1.05rem] font-medium leading-snug text-paper md:text-[1.15rem]">{title}</span>
        </span>
        <span aria-hidden className="font-mono text-[1.2rem] leading-none text-paper-mute transition-transform duration-300 ease-out group-open:rotate-45">
          +
        </span>
      </summary>
      <div className="border-t border-rule px-5 py-5 md:px-6">{children}</div>
    </details>
  );
}

export function TxLine({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  const link = (h?: string) =>
    h ? (
      <a className="font-mono text-[0.85em] underline decoration-rule-strong underline-offset-4 hover:decoration-paper" href={txUrl(h)} target="_blank" rel="noreferrer">
        {short(h)}
      </a>
    ) : null;
  return (
    <div className="text-sm" role="status" aria-live="polite">
      {state.phase === "working" && <Status tone="neutral">{state.note}</Status>}
      {state.phase === "sent" && <Status tone="neutral">Sent {link(state.hash)}, waiting for confirmation…</Status>}
      {state.phase === "done" && <Status tone="good">{state.note ?? "Confirmed"} {link(state.hash)}</Status>}
      {state.phase === "error" && (
        <Status tone="critical">
          {state.error} {link(state.hash)}
        </Status>
      )}
    </div>
  );
}

/** An engraved gauge: paper ink on a hairline track; `tone` switches the ink to a status colour near a limit. */
export function Meter({ value, max, tone, label }: { value: number; max: number; tone?: Tone; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  const fill = tone && tone !== "neutral" && tone !== "good" ? TONE[tone].color : "var(--paper-dim)";
  return (
    <div className="relative h-1 w-full bg-rule" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: fill }} />
    </div>
  );
}

/** A ledger panel (the kit's LedgerPanel): `title` in Instrument Sans, `aside` on the right of the head. `bodyClassName` replaces the default `space-y-4`. */
export function Card({
  title,
  label,
  aside,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: ReactNode;
  label?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <LedgerPanel title={title} label={label} actions={aside} className={className} bodyClassName={bodyClassName || "space-y-4"}>
      {children}
    </LedgerPanel>
  );
}

/** A small mono caption for a panel head ("desk-agent · refreshes every 5 s"). */
export function Aside({ children }: { children: ReactNode }) {
  return <Label>{children}</Label>;
}

/** A notice: status mark, title and body, with the tone's hatch engraved down its margin. */
export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  const t = TONE[tone];
  return (
    <div className="relative flex gap-3.5 border bg-vault-2 py-4 pr-4 pl-6 text-sm md:pr-5" style={{ borderColor: tone === "neutral" ? "var(--rule)" : t.color }}>
      {tone !== "neutral" && <span aria-hidden className="absolute inset-y-0 left-0 w-2 border-r" style={{ backgroundImage: hatch(t.hex, 0.75, 4), borderColor: t.color } as CSSProperties} />}
      <StatusIcon tone={tone} size={18} className="mt-[1px]" />
      <div className="min-w-0 space-y-1.5">
        <div className="text-[0.95rem] font-medium leading-snug text-paper">{title}</div>
        {children && <div className="leading-relaxed text-paper-dim [&_strong]:font-medium [&_strong]:text-paper">{children}</div>}
      </div>
    </div>
  );
}

/** Two-step confirm for irreversible owner actions: first click arms, second click runs. */
export function ConfirmButton({ label, confirm, kind = "secondary", disabled, onConfirm }: { label: string; confirm: string; kind?: BtnKind; disabled?: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed)
    return (
      <Btn kind={kind} disabled={disabled} onClick={() => setArmed(true)} className="w-full">
        {label}
      </Btn>
    );
  return (
    <div
      className="animate-[dd-rise_0.5s_var(--ease-out)_both] space-y-3 border bg-vault p-3.5"
      style={{ borderColor: kind === "danger" ? "var(--critical)" : "var(--rule-strong)" }}
    >
      <p className="text-sm leading-relaxed text-paper-dim">{confirm}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Btn
          kind={kind === "secondary" ? "primary" : kind}
          strong={kind === "danger"}
          disabled={disabled}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          Confirm {label.toLowerCase()}
        </Btn>
        <Btn kind="ghost" onClick={() => setArmed(false)}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}
