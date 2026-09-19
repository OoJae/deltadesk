"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Hash } from "viem";
import { describeError } from "@/lib/desk/tx";

/**
 * Polls `fn` every `ms` while `enabled`. Keeps the last good value on a failed refetch (no flash), and exposes the
 * latest error separately so the UI can dim instead of blanking.
 */
export function usePoll<T>(fn: (() => Promise<T>) | null, ms: number, key: string) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  const lastKey = useRef(key);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(undefined);
      setError(null);
    }
    if (!fnRef.current) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const f = fnRef.current;
      if (!f) return;
      try {
        const v = await f();
        if (!stop) {
          setData(v);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(describeError(e));
      }
      if (!stop) timer = setTimeout(run, ms);
    };
    run();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, ms, tick, fn === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, refresh };
}

export type TxState =
  | { phase: "idle" }
  | { phase: "working"; note: string }
  | { phase: "sent"; hash: Hash }
  | { phase: "done"; hash?: Hash; note?: string }
  | { phase: "error"; error: string; hash?: Hash };

/**
 * One in-flight action at a time. `run` passes `onHash` (surface the tx link while it confirms) and `done(note)` (the
 * message shown once it succeeds).
 */
export function useAction() {
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const busy = state.phase === "working" || state.phase === "sent";
  const run = useCallback(async <R,>(note: string, fn: (onHash: (h: Hash) => void, done: (note: string) => void) => Promise<R>): Promise<R | undefined> => {
    let hash: Hash | undefined;
    let doneNote: string | undefined;
    setState({ phase: "working", note });
    try {
      const r = await fn(
        (h) => {
          hash = h;
          setState({ phase: "sent", hash: h });
        },
        (n) => {
          doneNote = n;
        },
      );
      setState({ phase: "done", hash, note: doneNote });
      return r;
    } catch (e) {
      setState({ phase: "error", error: describeError(e), hash });
      return undefined;
    }
  }, []);
  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, busy, run, reset };
}

/** True once `ms` have passed while `waiting` stays true (for "this is taking too long" hints). */
export function useSlow(waiting: boolean, ms = 12_000) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [waiting, ms]);
  return waiting && expired;
}

export const DYNAMIC_SLOW_HINT =
  "Dynamic has not loaded. Check NEXT_PUBLIC_DYNAMIC_ENV_ID and that this site's origin is allowed (CORS) in the Dynamic dashboard.";

// Per-viewer convenience storage (wizard progress, the pinned Vault). localStorage when it works, an in-memory map when
// it doesn't (private mode, blocked site data), so the UI never depends on it.
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function readStored(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v != null) return v;
  } catch {
    /* storage unavailable */
  }
  return memory.get(key) ?? null;
}

export function writeStored(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the in-memory copy lasts for this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

export function useStoredString(key: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (key ? readStored(key) : null),
    () => null,
  );
}

/**
 * A JSON object in per-viewer storage, merged over `initial` (pass a module-level constant). `update` is a no-op while
 * `key` is null.
 */
export function useStoredState<T extends object>(key: string | null, initial: T) {
  const raw = useStoredString(key);
  const value = useMemo<T>(() => parseStored(raw, initial), [raw, initial]);
  const update = useCallback(
    (patch: Partial<T> | ((v: T) => T)) => {
      if (!key) return;
      const cur = parseStored(readStored(key), initial);
      const next = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
      writeStored(key, JSON.stringify(next));
    },
    [key, initial],
  );
  return [value, update] as const;
}

function parseStored<T extends object>(raw: string | null, initial: T): T {
  if (!raw) return initial;
  try {
    return { ...initial, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return initial;
  }
}
