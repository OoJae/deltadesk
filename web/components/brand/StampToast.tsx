"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { MARK_DELTA } from "./mark-data";

export type StampKind = "signed" | "approved" | "submitted" | "revoked" | "recorded";

export type StampInput = {
  /** What happened, from the user's side: "Delegation signed", "Rerange approved". */
  title: string;
  /** The stamp's word. Default from `kind`. */
  kind?: StampKind;
  /** One line of detail: amounts, lane, block. */
  detail?: ReactNode;
  /** A record identifier shown as the stamp's red serial: a tx hash or decision id (shortened for you). */
  serial?: string;
  /** Link to the record (explorer). Opens in a new tab. */
  href?: string;
  /** ms before it lifts. Default 5200. 0 = stays until dismissed. */
  duration?: number;
};

type Stamp = StampInput & { id: number; leaving: boolean };

type StampApi = {
  /** Press an engraved stamp onto the page. Returns its id. Announced politely to screen readers. */
  stamp: (s: StampInput) => number;
  dismiss: (id: number) => void;
};

const Ctx = createContext<StampApi | null>(null);

const WORD: Record<StampKind, string> = { signed: "SIGNED", approved: "APPROVED", submitted: "SUBMITTED", revoked: "REVOKED", recorded: "RECORDED" };

/** Mount once near the root (app/layout.tsx does). */
export function StampProvider({ children }: { children: ReactNode }) {
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    setStamps((xs) => xs.filter((x) => x.id !== id));
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      setStamps((xs) => xs.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.set(id, setTimeout(() => remove(id), reduce ? 0 : 360));
    },
    [remove],
  );

  const stamp = useCallback(
    (s: StampInput) => {
      const id = ++seq.current;
      setStamps((xs) => [...xs.slice(-2), { ...s, id, leaving: false }]);
      const duration = s.duration ?? 5200;
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((x) => clearTimeout(x));
  }, []);

  const api = useMemo(() => ({ stamp, dismiss }), [stamp, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[80] flex flex-col items-center gap-3 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
      >
        {stamps.map((s) => (
          <StampCard key={s.id} s={s} onDismiss={() => dismiss(s.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** `const { stamp } = useStamp(); stamp({ kind: "signed", title: "Delegation signed", serial: txHash })` */
export function useStamp(): StampApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useStamp() needs <StampProvider> above it (app/layout.tsx mounts one).");
  return api;
}

function shortId(x: string) {
  return x.length > 14 ? `${x.slice(0, 6)}…${x.slice(-4)}` : x;
}

function StampCard({ s, onDismiss }: { s: Stamp; onDismiss: () => void }) {
  const word = WORD[s.kind ?? "recorded"];
  return (
    <div className="pointer-events-auto flex w-full max-w-[27rem] items-center gap-4 border border-rule-strong bg-vault-2 py-3 pr-3 pl-3 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]">
      <div className={s.leaving ? "dd-stamp-exit" : "dd-stamp-enter"} style={{ transformOrigin: "50% 50%" }}>
        <StampMark word={word} serial={s.serial ? shortId(s.serial) : undefined} size={92} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[0.95rem] leading-snug font-medium text-paper">{s.title}</p>
        {s.detail != null ? <div className="mt-0.5 font-mono text-[0.75rem] leading-snug text-paper-dim">{s.detail}</div> : null}
        {s.href ? (
          <a href={s.href} target="_blank" rel="noreferrer" className="mt-1 inline-block font-mono text-[0.72rem] tracking-[0.06em] text-paper-dim underline decoration-rule-strong underline-offset-4 hover:text-paper">
            VIEW RECORD ↗
          </a>
        ) : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="self-start p-1.5 font-mono text-[0.9rem] leading-none text-paper-mute hover:text-paper">
        ×
      </button>
    </div>
  );
}

/** The engraved stamp itself: double ring, the word on the upper arc, the record's serial in red on the lower arc. */
export function StampMark({ word, serial, size = 76 }: { word: string; serial?: string; size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const top = `stamp-top-${uid}`;
  const bottom = `stamp-bottom-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="block text-paper">
      <defs>
        <path id={top} d="M15 50 a35 35 0 1 1 70 0" />
        <path id={bottom} d="M11.5 50 a38.5 38.5 0 0 0 77 0" />
      </defs>
      <g fill="none" stroke="currentColor">
        <circle cx="50" cy="50" r="47.5" strokeWidth="1.6" />
        <circle cx="50" cy="50" r="44" strokeWidth="0.6" strokeDasharray="1.2 1.6" />
        <circle cx="50" cy="50" r="25" strokeWidth="0.8" />
      </g>
      <text fill="currentColor" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.22em", fontWeight: 500 }}>
        <textPath href={`#${top}`} startOffset="50%" textAnchor="middle">
          {word}
        </textPath>
      </text>
      {serial ? (
        <text fill="var(--serial)" style={{ fontFamily: "var(--font-mono)", fontSize: 7.8, letterSpacing: "0.04em", fontWeight: 500 }}>
          <textPath href={`#${bottom}`} startOffset="50%" textAnchor="middle">
            {`N° ${serial}`}
          </textPath>
        </text>
      ) : null}
      <g transform="translate(35.6 34) scale(0.9)" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="miter">
        {MARK_DELTA.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}
