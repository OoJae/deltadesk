"use client";

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { addressUrl, txUrl } from "@/lib/desk/chain";
import { short } from "@/lib/desk/format";
import type { TxState } from "./hooks";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";
const TONE: Record<Tone, { color: string; icon: string }> = {
  good: { color: "var(--good)", icon: "✓" },
  warning: { color: "var(--warning)", icon: "!" },
  serious: { color: "var(--serious)", icon: "!" },
  critical: { color: "var(--critical)", icon: "✕" },
  neutral: { color: "var(--axis)", icon: "·" },
};

/** Status is never color alone: an icon disc plus a text label. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black" style={{ background: t.color }} aria-hidden>
        {t.icon}
      </span>
      <span>{children}</span>
    </span>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--ring)] px-3 py-1 text-sm font-semibold">
      <span className="h-2 w-2 rounded-full" style={{ background: TONE[tone].color }} aria-hidden />
      {children}
    </span>
  );
}

type BtnKind = "primary" | "secondary" | "danger" | "ghost";
const BTN: Record<BtnKind, string> = {
  primary: "bg-[var(--accent)] text-white hover:opacity-90",
  secondary: "border border-[var(--ring)] bg-surface-2 text-ink hover:bg-[var(--grid)]",
  danger: "border border-[var(--critical)] bg-surface-1 text-[var(--critical)] hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
};

export function Btn({ kind = "secondary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind }) {
  return (
    <button
      type="button"
      {...p}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${BTN[kind]} ${className}`}
    />
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
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
      <a href={addressUrl(address)} target="_blank" rel="noreferrer" className={`font-mono text-sm text-ink hover:underline ${full ? "break-all" : ""}`} title={address}>
        {full ? address : short(address)}
      </a>
      <CopyButton text={address} />
    </span>
  );
}

export function TxLine({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  const link = (h?: string) =>
    h ? (
      <a className="font-mono underline" href={txUrl(h)} target="_blank" rel="noreferrer">
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

/** Same-ramp meter: accent fill on a lighter accent track; `tone` switches the fill to a status color near a limit. */
export function Meter({ value, max, tone, label }: { value: number; max: number; tone?: Tone; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  const fill = tone && tone !== "neutral" && tone !== "good" ? TONE[tone].color : "var(--accent)";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--div-pos-1)]" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: fill }} />
    </div>
  );
}

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card space-y-4 p-5 ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className="card flex gap-3 p-4 text-sm" style={{ borderColor: tone === "neutral" ? undefined : TONE[tone].color }}>
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-black" style={{ background: TONE[tone].color }} aria-hidden>
        {TONE[tone].icon}
      </span>
      <div className="min-w-0 space-y-1">
        <div className="font-semibold">{title}</div>
        {children && <div className="text-ink-2">{children}</div>}
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
    <div className="space-y-2 rounded-lg border border-[var(--ring)] bg-surface-2 p-3">
      <p className="text-sm text-ink-2">{confirm}</p>
      <div className="flex gap-2">
        <Btn
          kind={kind === "secondary" ? "primary" : kind}
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
