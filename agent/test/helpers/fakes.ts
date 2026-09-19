/**
 * Shared test doubles. No network, no timers, no real secrets: ever. Configs are built from a
 * synthetic env, never from process.env.
 */

import { type AppConfig, loadConfig } from "../../src/config.js";
import { type DeskDbHandle, openDb } from "../../src/state/db.js";
import type { Address, Clock, DeskLogger, LlmClient, LlmRequest } from "../../src/types.js";

export const LANE: Address = "0x1111111111111111111111111111111111111111";
export const OWNER: Address = "0x2222222222222222222222222222222222222222";
export const OPERATOR: Address = "0x3333333333333333333333333333333333333333";
/** A well-known anvil key (account #0); only ever used against loopback RPCs. */
export const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** Default: Mon 2026-09-21 14:00 UTC (10:00 ET, regular session). */
export function fixedClock(startMs = Date.UTC(2026, 8, 21, 14, 0, 0)): TestClock {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export function makeTestConfig(
  env: Record<string, string> = {},
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return { ...loadConfig({ ...env }), ...overrides };
}

export function memDb(): DeskDbHandle {
  return openDb(":memory:");
}

/** Queue-scripted LLM double; records every call. */
export class FakeLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  private readonly queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLlmClient: response queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  obj: unknown;
  msg: string | undefined;
}

export function recordingLogger(records: LogRecord[] = []): DeskLogger & { records: LogRecord[] } {
  const make = (): DeskLogger & { records: LogRecord[] } => ({
    records,
    child: () => make(),
    debug: (obj, msg) => records.push({ level: "debug", obj, msg }),
    info: (obj, msg) => records.push({ level: "info", obj, msg }),
    warn: (obj, msg) => records.push({ level: "warn", obj, msg }),
    error: (obj, msg) => records.push({ level: "error", obj, msg }),
  });
  return make();
}
