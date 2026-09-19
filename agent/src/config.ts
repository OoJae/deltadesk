/**
 * Single source of truth: env parsing, safety flags, limits, capabilities, and the startup refusals.
 *
 * SAFETY INVARIANTS ENFORCED HERE
 * - DRY_RUN / DESK_ARM / HL_ARM / DESK_OVERLAY are strict enums: a typo fails loudly, never arms.
 * - Refuses to start half-armed on 4663 (DRY_RUN=false requires DESK_ARM=1).
 * - A raw operator key (SIGNER_KIND=local) is refused unless the RPC is loopback (anvil / fork), and
 *   any chain other than 4663 is refused unless the RPC is loopback (so the arm rule can't be dodged).
 * - A live signer never pairs with a mock sensor, and a live Dynamic signer needs its credentials and
 *   the vault KEK up front: capabilities fall back to mocks only while DRY_RUN holds.
 * - The config caps must sit inside the lane's on-chain caps (assertConfigWithinOnchainCaps), and the
 *   signer must be the lane's operator and never its owner (assertSignerBinding): startup hooks.
 * - Secrets live in AppConfig but never in describeConfig(); log.ts redacts their field names.
 */

import { z } from "zod";
import { CHAIN_ID_4663 } from "./addresses.js";
import {
  type Address,
  ConfigRefusedError,
  type DeskMode,
  type GuardLimits,
  type HlMode,
  type LaneCaps,
  type SignerKind,
  type StrategyParams,
  type WatchdogThresholds,
} from "./types.js";
import { parseUnits, usd6ToCentsFloor, usdToCents } from "./units.js";

// ---------------------------------------------------------------------------------------------
// Constants (not env-driven)

export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const DEFAULT_EXPLORER_URL = "https://explorer.mainnet.chain.robinhood.com";
export const DEFAULT_DELTADESK_API_URL = "https://core-production-512e.up.railway.app";
export const DEFAULT_BANKR_LLM_BASE_URL = "https://llm.bankr.bot";
/** Overlay model (off in M2). Override with DESK_LLM_MODEL if the gateway names it differently. */
export const DEFAULT_LLM_MODEL = "claude-opus-5";
export const DEFAULT_HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
export const DEFAULT_HL_INFO_URL = "https://api.hyperliquid.xyz/info";
export const DEFAULT_RH_API_URL = "https://api.robinhood.com/rhj";
export const DEFAULT_DB_PATH = "data/desk.sqlite";
export const DEFAULT_APPROVAL_DIR = "data/approvals";

export function dynamicJwksUrl(environmentId: string): string {
  return `https://app.dynamic.xyz/api/v0/sdk/${environmentId}/.well-known/jwks`;
}

/** Lane A strategy v0 (docs/m2-design-agent.md "Strategy"). */
export const STRATEGY_DEFAULTS: StrategyParams = {
  straddleMaxGapBps: 25,
  halfWidthTicks: 100,
  tickSpacing: 10,
  innerFraction: 0.6,
  outsideTicksToTrigger: 2,
  hurdleMultiple: 2,
  jitterMaxMs: 20_000,
  rerangeGasUnits: 1_200_000n,
  maxTickDelta: 10,
};

export const TIMING = {
  /** Guard snapshot-provenance: snapshot age ≤ 3 s. */
  snapshotMaxAgeMs: 3_000,
  /** Guard simulation-ok: eth_call at a block no more than 20 blocks old. */
  simMaxBlockAge: 20,
  /** Guard deadline-sane: now + 5 ≤ deadline ≤ now + 60. */
  deadlineMinAheadSec: 5,
  deadlineMaxAheadSec: 60,
  receiptPollMs: 250,
  receiptTimeoutMs: 15_000,
  signTimeoutMs: 15_000,
  tickRetentionMs: 14 * 24 * 3_600_000,
  /** Daemon lock: heartbeat on its own timer (not the tick), stale after 60 s. */
  lockHeartbeatMs: 5_000,
  lockStaleMs: 60_000,
  /** LaneAction reconciliation reads up to latest − 20 blocks. */
  reconcileConfirmations: 20,
} as const;

// ---------------------------------------------------------------------------------------------
// Env schema

/** Empty strings are absent, so a copied-but-unfilled .env.example is inert. */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const def = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema);

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");
const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key");
const decimalSchema = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal");
const flag01 = z.enum(["0", "1"]);
/** WATCHDOG_AGENT_KEY: a dedicated shared secret, e.g. `openssl rand -hex 32`. */
const watchdogKeySchema = z
  .string()
  .min(32, "WATCHDOG_AGENT_KEY must be at least 32 characters")
  .refine((s) => s.trim() === s, "WATCHDOG_AGENT_KEY must not carry surrounding whitespace");
const boolStr = z.enum(["true", "false"]);

const EnvSchema = z.object({
  // chain
  CHAIN_ID: def(z.coerce.number().int().positive().default(CHAIN_ID_4663)),
  RH_RPC_URL: opt(z.url()),
  RH_RPC_FALLBACK_URL: opt(z.url()),
  EXPLORER_URL: def(z.url().default(DEFAULT_EXPLORER_URL)),
  // desk contracts
  DESK_FACTORY_ADDRESS: opt(addressSchema),
  DESK_LANE_A: opt(addressSchema),
  DESK_LANE_B: opt(addressSchema),
  // signer
  SIGNER_KIND: def(
    z.enum(["local", "dynamic-delegated", "dynamic-server"]).default("dynamic-delegated"),
  ),
  LOCAL_SIGNER_PRIVATE_KEY: opt(privateKeySchema),
  // Dynamic
  DYNAMIC_ENVIRONMENT_ID: opt(z.string().min(1)),
  DYNAMIC_API_KEY: opt(z.string().min(1)),
  DYNAMIC_WEBHOOK_SECRET: opt(z.string().min(16)),
  DYNAMIC_RSA_PRIVATE_KEY_PEM: opt(z.string().includes("PRIVATE KEY")),
  DYNAMIC_RSA_PRIVATE_KEY_PATH: opt(z.string().min(1)),
  DYNAMIC_JWKS_URL: opt(z.url()),
  DYNAMIC_BASE_API_URL: opt(z.url()),
  DYNAMIC_SERVER_WALLET_ADDRESS: opt(addressSchema),
  // vault
  DESK_VAULT_KEK_B64: opt(z.string().min(1)),
  DESK_VAULT_KEK_ID: def(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default("k1"),
  ),
  // LLM (Bankr gateway, Anthropic protocol)
  BANKR_LLM_API_KEY: opt(z.string().min(1)),
  BANKR_LLM_BASE_URL: def(z.url().default(DEFAULT_BANKR_LLM_BASE_URL)),
  DESK_LLM_MODEL: opt(z.string().min(1)),
  DESK_OVERLAY: def(flag01.default("0")),
  // Telegram
  TELEGRAM_BOT_TOKEN: opt(z.string().min(1)),
  TELEGRAM_CHAT_ID: opt(z.string().min(1)),
  // DeltaDesk engine API
  DELTADESK_API_URL: def(z.url().default(DEFAULT_DELTADESK_API_URL)),
  DELTADESK_API_KEY: opt(z.string().min(1)),
  DESK_BASIS_TTL_SEC: def(z.coerce.number().int().min(30).default(600)),
  // Robinhood
  RH_API_URL: def(z.url().default(DEFAULT_RH_API_URL)),
  // Hyperliquid
  HL_MODE: def(z.enum(["paper", "live"]).default("paper")),
  HL_ARM: def(flag01.default("0")),
  HL_WS_URL: def(z.url().default(DEFAULT_HL_WS_URL)),
  HL_INFO_URL: def(z.url().default(DEFAULT_HL_INFO_URL)),
  HL_ACCOUNT_ADDRESS: opt(addressSchema),
  HL_AGENT_PRIVATE_KEY: opt(privateKeySchema),
  // safety (SAFETY-CRITICAL strict enums: "flase" / "yes" / "TRUE" must fail, never coerce)
  DESK_ARM: def(flag01.default("0")),
  DRY_RUN: def(boolStr.default("true")),
  DESK_MODE: def(z.enum(["advisory", "copilot", "autopilot"]).default("advisory")),
  DESK_SENSE_MOCK: def(flag01.default("0")),
  // limits
  DESK_MAX_ACTION_USD: def(z.coerce.number().positive().default(60)),
  DESK_DAILY_TURNOVER_USD: def(z.coerce.number().positive().default(150)),
  DESK_GAS_RESERVE_ETH: def(decimalSchema.default("0.001")),
  DESK_MAX_FEE_GWEI: def(decimalSchema.default("2")),
  DESK_FEE_FLOOR_GWEI: def(decimalSchema.default("0.02")),
  DESK_MAX_GAS_USD: def(z.coerce.number().positive().default(2)),
  DESK_RERANGES_PER_HOUR: def(z.coerce.number().int().min(0).default(4)),
  DESK_RERANGES_PER_DAY: def(z.coerce.number().int().min(0).default(24)),
  DESK_MIN_RERANGE_INTERVAL_SEC: def(z.coerce.number().int().min(60).default(300)),
  DESK_DEADLINE_SEC: def(z.coerce.number().int().min(10).max(60).default(45)),
  // timing
  DESK_TICK_SEC: def(z.coerce.number().int().min(1).max(60).default(5)),
  DESK_RECONCILE_SEC: def(z.coerce.number().int().min(5).default(30)),
  DESK_APPROVAL_WINDOW_SEC: def(z.coerce.number().int().min(10).max(900).default(120)),
  DESK_CANCEL_WINDOW_SEC: def(z.coerce.number().int().min(0).max(900).default(0)),
  // gate signals: one delegated signal(Meta) LaneAction per regime / gate change
  DESK_SIGNAL_GATES: def(flag01.default("1")),
  DESK_SIGNAL_AUTO: def(flag01.default("0")),
  DESK_SIGNAL_MAX_PER_HOUR: def(z.coerce.number().int().min(0).max(60).default(6)),
  DESK_SIGNAL_MIN_DWELL_SEC: def(z.coerce.number().int().min(0).max(3_600).default(60)),
  // runtime
  DESK_DB_PATH: def(z.string().min(1).default(DEFAULT_DB_PATH)),
  DESK_APPROVAL_DIR: def(z.string().min(1).default(DEFAULT_APPROVAL_DIR)),
  PORT: def(z.coerce.number().int().min(1).max(65535).default(8080)),
  DESK_HTTP_HOST: def(z.string().min(1).default("0.0.0.0")),
  DESK_AGENT_API_KEY: opt(z.string().min(24)),
  // The watchdog's own shared secret for GET /lanes/:lane/actions/:decisionId (never the web's key).
  WATCHDOG_AGENT_KEY: opt(watchdogKeySchema),
  LOG_LEVEL: def(z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info")),
});

export type DeskEnv = z.infer<typeof EnvSchema>;

/** Every variable the agent reads (the .env.example test keeps the two in sync). */
export const DESK_ENV_KEYS: readonly string[] = Object.keys(EnvSchema.shape);

// ---------------------------------------------------------------------------------------------
// AppConfig

export interface Capabilities {
  /** Live chain/HL/RH reads (vs the mock sensor). */
  liveSense: boolean;
  /** LLM overlay (off in M2 unless DESK_OVERLAY=1 and a Bankr key is set). */
  llm: boolean;
  telegram: boolean;
  /** Dynamic server API reachable (environment id + API token). */
  dynamic: boolean;
  /** Vault KEK present (delegated credentials can be stored and opened). */
  vault: boolean;
  /** Dynamic webhook can verify (HMAC secret) and decrypt (RSA key) and store (vault). */
  webhook: boolean;
  /** Dynamic JWT verification for the web API. */
  webAuth: boolean;
  /** Premium engine API (k from /basis); otherwise the self-computed fallback. */
  engineApi: boolean;
  hlLive: boolean;
}

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrl: string | undefined;
  explorerUrl: string;
  factoryAddress: Address | undefined;
  lanes: { A: Address | undefined; B: Address | undefined };
  signer: {
    kind: SignerKind;
    localPrivateKey: `0x${string}` | undefined;
    serverWalletAddress: Address | undefined;
  };
  dynamic: {
    environmentId: string | undefined;
    apiKey: string | undefined;
    webhookSecret: string | undefined;
    rsaPrivateKeyPem: string | undefined;
    rsaPrivateKeyPath: string | undefined;
    jwksUrl: string | undefined;
    baseApiUrl: string | undefined;
  };
  vault: { kekB64: string | undefined; kekId: string };
  llm: { apiKey: string | undefined; baseURL: string; model: string; overlayEnabled: boolean };
  telegram: { botToken: string | undefined; chatId: string | undefined };
  engine: { apiUrl: string; apiKey: string | undefined; basisTtlMs: number };
  rh: { apiUrl: string };
  hl: {
    mode: HlMode;
    armed: boolean;
    wsUrl: string;
    infoUrl: string;
    accountAddress: Address | undefined;
    agentPrivateKey: `0x${string}` | undefined;
  };
  safety: { armed: boolean; dryRun: boolean; defaultMode: DeskMode; senseMock: boolean };
  limits: {
    maxActionCents: number;
    dailyTurnoverCents: number;
    gasReserveWei: bigint;
    maxFeePerGasWei: bigint;
    feeFloorWei: bigint;
    maxGasCents: number;
  };
  reranges: { perHour: number; perDay: number; minIntervalSec: number };
  /**
   * Gate signals (agent/README.md "Gate signals"): `enabled` DESK_SIGNAL_GATES; `auto`
   * DESK_SIGNAL_AUTO (copilot signals skip the human approval: they are neutral); at most
   * `maxPerHour` signed signals per lane per rolling hour; a state younger than `minDwellMs` is
   * never announced (except the lane's first).
   */
  signal: { enabled: boolean; auto: boolean; maxPerHour: number; minDwellMs: number };
  timing: typeof TIMING & {
    tickMs: number;
    reconcileMs: number;
    approvalWindowMs: number;
    cancelWindowMs: number;
    deadlineSec: number;
  };
  strategy: StrategyParams;
  paths: { dbPath: string; approvalDir: string };
  http: {
    port: number;
    host: string;
    agentApiKey: string | undefined;
    /** WATCHDOG_AGENT_KEY: authenticates the watchdog's cross-check route (unset: route off). */
    watchdogKey: string | undefined;
  };
  logLevel: DeskEnv["LOG_LEVEL"];
  capabilities: Capabilities;
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Loopback hosts: localhost, 127.0.0.0/8, ::1. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Render an RPC endpoint for logs with the path elided: provider URLs carry the API key as a path
 * segment (`https://robinhood-mainnet.g.alchemy.com/v2/<KEY>`), so the raw URL is a secret.
 */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" && u.search === "" ? u.origin : `${u.origin}/…`;
  } catch {
    return "[unparseable-url]";
  }
}

/** Scrub an RPC URL (and its key-bearing path) out of arbitrary error text. */
export function scrubRpcUrl(text: string, rpcUrl: string): string {
  if (rpcUrl === "") return text;
  let out = text.split(rpcUrl).join(redactRpcUrl(rpcUrl));
  try {
    const path = new URL(rpcUrl).pathname;
    if (path.length > 1) out = out.split(path).join("/…");
  } catch {
    /* unparseable: the whole-URL replacement above is the best we can do */
  }
  return out;
}

function kekBytes(b64: string): number {
  return Buffer.from(b64, "base64").length;
}

/** PEMs in env vars usually arrive with literal "\n". */
function normalisePem(pem: string | undefined): string | undefined {
  return pem?.includes("\\n") ? pem.replaceAll("\\n", "\n") : pem;
}

function refuse(message: string): never {
  throw new ConfigRefusedError(message);
}

// ---------------------------------------------------------------------------------------------
// loadConfig

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigRefusedError(`invalid environment: ${issues}`);
  }
  const e = parsed.data;

  const dryRun = e.DRY_RUN === "true";
  const armed = e.DESK_ARM === "1";
  const senseMock = e.DESK_SENSE_MOCK === "1";
  const rpcUrl = e.RH_RPC_URL ?? DEFAULT_RPC_URL;
  const loopback = isLoopbackUrl(rpcUrl);

  // Half-armed on mainnet: the belt; the guard's arm-flag rule is the suspenders.
  if (e.CHAIN_ID === CHAIN_ID_4663 && !dryRun && !armed) {
    refuse(
      "CHAIN_ID=4663 with DRY_RUN=false requires DESK_ARM=1. Keep DRY_RUN=true or arm explicitly.",
    );
  }
  // Another chain id against a remote RPC would sidestep the 4663 arm rule.
  if (e.CHAIN_ID !== CHAIN_ID_4663 && !loopback) {
    refuse(
      `CHAIN_ID=${e.CHAIN_ID} is only allowed against a loopback RPC (anvil / fork), got ${redactRpcUrl(rpcUrl)}.`,
    );
  }
  if (e.RH_RPC_FALLBACK_URL !== undefined && isLoopbackUrl(e.RH_RPC_FALLBACK_URL) !== loopback) {
    refuse("RH_RPC_FALLBACK_URL must be on the same side (loopback or remote) as RH_RPC_URL.");
  }

  // A raw operator key only ever signs against a local fork.
  if (e.SIGNER_KIND === "local") {
    if (!loopback) {
      refuse(
        `SIGNER_KIND=local needs a loopback RPC (anvil / fork); RH_RPC_URL is ${redactRpcUrl(rpcUrl)}.`,
      );
    }
    if (e.LOCAL_SIGNER_PRIVATE_KEY === undefined)
      refuse("SIGNER_KIND=local requires LOCAL_SIGNER_PRIVATE_KEY.");
  } else if (e.LOCAL_SIGNER_PRIVATE_KEY !== undefined && !loopback) {
    refuse(
      "LOCAL_SIGNER_PRIVATE_KEY is set next to a remote RPC. Remove it: the operator signs through Dynamic.",
    );
  }

  // Never pair a mock sensor with a live signer: a fabricated snapshot must not move real money.
  if (!dryRun && senseMock)
    refuse("DESK_SENSE_MOCK=1 with DRY_RUN=false: a mock snapshot must never drive a live signer.");

  if (e.DESK_VAULT_KEK_B64 !== undefined && kekBytes(e.DESK_VAULT_KEK_B64) !== 32) {
    refuse("DESK_VAULT_KEK_B64 must decode to exactly 32 bytes (AES-256).");
  }
  const dynamicReady = e.DYNAMIC_ENVIRONMENT_ID !== undefined && e.DYNAMIC_API_KEY !== undefined;
  const vaultReady = e.DESK_VAULT_KEK_B64 !== undefined;
  if (!dryRun && e.SIGNER_KIND === "dynamic-delegated" && !(dynamicReady && vaultReady)) {
    refuse(
      "SIGNER_KIND=dynamic-delegated with DRY_RUN=false requires DYNAMIC_ENVIRONMENT_ID, DYNAMIC_API_KEY and DESK_VAULT_KEK_B64.",
    );
  }
  if (
    !dryRun &&
    e.SIGNER_KIND === "dynamic-server" &&
    !(dynamicReady && vaultReady && e.DYNAMIC_SERVER_WALLET_ADDRESS)
  ) {
    refuse(
      "SIGNER_KIND=dynamic-server with DRY_RUN=false requires DYNAMIC_ENVIRONMENT_ID, DYNAMIC_API_KEY, DESK_VAULT_KEK_B64 and DYNAMIC_SERVER_WALLET_ADDRESS.",
    );
  }

  // The live HL path stays behind HL_MODE=live + HL_ARM=1 (unused in M2).
  if (
    e.HL_MODE === "live" &&
    (e.HL_ARM !== "1" || !e.HL_AGENT_PRIVATE_KEY || !e.HL_ACCOUNT_ADDRESS)
  ) {
    refuse("HL_MODE=live requires HL_ARM=1, HL_AGENT_PRIVATE_KEY and HL_ACCOUNT_ADDRESS.");
  }
  if (e.DESK_MODE === "autopilot" && e.DESK_CANCEL_WINDOW_SEC === 0) {
    refuse(
      "DESK_MODE=autopilot requires DESK_CANCEL_WINDOW_SEC > 0 (the human's chance to stop it).",
    );
  }
  if (e.DESK_MAX_ACTION_USD > e.DESK_DAILY_TURNOVER_USD) {
    refuse(
      `DESK_MAX_ACTION_USD (${e.DESK_MAX_ACTION_USD}) exceeds DESK_DAILY_TURNOVER_USD (${e.DESK_DAILY_TURNOVER_USD}).`,
    );
  }
  if (e.DESK_RERANGES_PER_HOUR > e.DESK_RERANGES_PER_DAY) {
    refuse("DESK_RERANGES_PER_HOUR exceeds DESK_RERANGES_PER_DAY.");
  }
  const maxFeePerGasWei = parseUnits(e.DESK_MAX_FEE_GWEI, 9);
  const feeFloorWei = parseUnits(e.DESK_FEE_FLOOR_GWEI, 9);
  if (feeFloorWei > maxFeePerGasWei) refuse("DESK_FEE_FLOOR_GWEI exceeds DESK_MAX_FEE_GWEI.");
  if (e.WATCHDOG_AGENT_KEY !== undefined && e.WATCHDOG_AGENT_KEY === e.DESK_AGENT_API_KEY) {
    refuse(
      "WATCHDOG_AGENT_KEY equals DESK_AGENT_API_KEY: the watchdog's key must be its own (the web must never be able to vouch for an action).",
    );
  }
  const rsaPem = normalisePem(e.DYNAMIC_RSA_PRIVATE_KEY_PEM);

  const capabilities: Capabilities = {
    liveSense: !senseMock,
    llm: e.DESK_OVERLAY === "1" && e.BANKR_LLM_API_KEY !== undefined,
    telegram: e.TELEGRAM_BOT_TOKEN !== undefined && e.TELEGRAM_CHAT_ID !== undefined,
    dynamic: dynamicReady,
    vault: vaultReady,
    webhook:
      e.DYNAMIC_WEBHOOK_SECRET !== undefined &&
      (rsaPem !== undefined || e.DYNAMIC_RSA_PRIVATE_KEY_PATH !== undefined) &&
      vaultReady,
    webAuth: e.DYNAMIC_ENVIRONMENT_ID !== undefined,
    engineApi: e.DELTADESK_API_KEY !== undefined,
    hlLive: e.HL_MODE === "live",
  };

  return {
    chainId: e.CHAIN_ID,
    rpcUrl,
    rpcFallbackUrl: e.RH_RPC_FALLBACK_URL,
    explorerUrl: e.EXPLORER_URL,
    factoryAddress: e.DESK_FACTORY_ADDRESS as Address | undefined,
    lanes: { A: e.DESK_LANE_A as Address | undefined, B: e.DESK_LANE_B as Address | undefined },
    signer: {
      kind: e.SIGNER_KIND,
      localPrivateKey: e.LOCAL_SIGNER_PRIVATE_KEY as `0x${string}` | undefined,
      serverWalletAddress: e.DYNAMIC_SERVER_WALLET_ADDRESS as Address | undefined,
    },
    dynamic: {
      environmentId: e.DYNAMIC_ENVIRONMENT_ID,
      apiKey: e.DYNAMIC_API_KEY,
      webhookSecret: e.DYNAMIC_WEBHOOK_SECRET,
      rsaPrivateKeyPem: rsaPem,
      rsaPrivateKeyPath: e.DYNAMIC_RSA_PRIVATE_KEY_PATH,
      jwksUrl:
        e.DYNAMIC_JWKS_URL ??
        (e.DYNAMIC_ENVIRONMENT_ID === undefined
          ? undefined
          : dynamicJwksUrl(e.DYNAMIC_ENVIRONMENT_ID)),
      baseApiUrl: e.DYNAMIC_BASE_API_URL,
    },
    vault: { kekB64: e.DESK_VAULT_KEK_B64, kekId: e.DESK_VAULT_KEK_ID },
    llm: {
      apiKey: e.BANKR_LLM_API_KEY,
      baseURL: e.BANKR_LLM_BASE_URL,
      model: e.DESK_LLM_MODEL ?? DEFAULT_LLM_MODEL,
      overlayEnabled: e.DESK_OVERLAY === "1",
    },
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID },
    engine: {
      apiUrl: e.DELTADESK_API_URL,
      apiKey: e.DELTADESK_API_KEY,
      basisTtlMs: e.DESK_BASIS_TTL_SEC * 1000,
    },
    rh: { apiUrl: e.RH_API_URL },
    hl: {
      mode: e.HL_MODE,
      armed: e.HL_ARM === "1",
      wsUrl: e.HL_WS_URL,
      infoUrl: e.HL_INFO_URL,
      accountAddress: e.HL_ACCOUNT_ADDRESS as Address | undefined,
      agentPrivateKey: e.HL_AGENT_PRIVATE_KEY as `0x${string}` | undefined,
    },
    safety: { armed, dryRun, defaultMode: e.DESK_MODE, senseMock },
    limits: {
      maxActionCents: usdToCents(e.DESK_MAX_ACTION_USD),
      dailyTurnoverCents: usdToCents(e.DESK_DAILY_TURNOVER_USD),
      gasReserveWei: parseUnits(e.DESK_GAS_RESERVE_ETH, 18),
      maxFeePerGasWei,
      feeFloorWei,
      maxGasCents: usdToCents(e.DESK_MAX_GAS_USD),
    },
    reranges: {
      perHour: e.DESK_RERANGES_PER_HOUR,
      perDay: e.DESK_RERANGES_PER_DAY,
      minIntervalSec: e.DESK_MIN_RERANGE_INTERVAL_SEC,
    },
    signal: {
      enabled: e.DESK_SIGNAL_GATES === "1",
      auto: e.DESK_SIGNAL_AUTO === "1",
      maxPerHour: e.DESK_SIGNAL_MAX_PER_HOUR,
      minDwellMs: e.DESK_SIGNAL_MIN_DWELL_SEC * 1000,
    },
    timing: {
      ...TIMING,
      tickMs: e.DESK_TICK_SEC * 1000,
      reconcileMs: e.DESK_RECONCILE_SEC * 1000,
      approvalWindowMs: e.DESK_APPROVAL_WINDOW_SEC * 1000,
      cancelWindowMs: e.DESK_CANCEL_WINDOW_SEC * 1000,
      deadlineSec: e.DESK_DEADLINE_SEC,
    },
    strategy: { ...STRATEGY_DEFAULTS },
    paths: { dbPath: e.DESK_DB_PATH, approvalDir: e.DESK_APPROVAL_DIR },
    http: {
      port: e.PORT,
      host: e.DESK_HTTP_HOST,
      agentApiKey: e.DESK_AGENT_API_KEY,
      watchdogKey: e.WATCHDOG_AGENT_KEY,
    },
    logLevel: e.LOG_LEVEL,
    capabilities,
  };
}

// ---------------------------------------------------------------------------------------------
// Startup hooks (need chain state, so they run after the first read, before the loop starts)

/** The RPC must be the chain the config says it is. */
export function assertRpcChainId(cfg: AppConfig, rpcChainId: number): void {
  if (rpcChainId !== cfg.chainId) {
    refuse(
      `RPC ${redactRpcUrl(cfg.rpcUrl)} reports chainId ${rpcChainId}, config says ${cfg.chainId}.`,
    );
  }
}

/**
 * The agent's own caps must sit inside the lane's on-chain caps: a config cap above the contract's
 * would only turn into reverts, and signals a config written for a different lane.
 */
export function assertConfigWithinOnchainCaps(cfg: AppConfig, caps: LaneCaps): void {
  const problems: string[] = [];
  const onchainMaxCents = usd6ToCentsFloor(caps.maxDeployUsd6);
  const onchainTurnoverCents = usd6ToCentsFloor(caps.turnoverUsd6PerDay);
  if (cfg.limits.maxActionCents > onchainMaxCents) {
    problems.push(
      `DESK_MAX_ACTION_USD ${cfg.limits.maxActionCents / 100} > on-chain maxDeployUsd6 $${onchainMaxCents / 100}`,
    );
  }
  if (cfg.limits.dailyTurnoverCents > onchainTurnoverCents) {
    problems.push(
      `DESK_DAILY_TURNOVER_USD ${cfg.limits.dailyTurnoverCents / 100} > on-chain turnoverUsd6PerDay $${onchainTurnoverCents / 100}`,
    );
  }
  // DESK_DEADLINE_SEC is clamped to the on-chain maxDeadlineAhead (the owner may tighten it
  // instantly, and that must not lock the agent out of an exit); only a cap that leaves no valid
  // deadline at all is refused.
  if (caps.maxDeadlineAhead < cfg.timing.deadlineMinAheadSec) {
    problems.push(
      `on-chain maxDeadlineAhead ${caps.maxDeadlineAhead} s leaves no valid deadline (minimum ${cfg.timing.deadlineMinAheadSec} s ahead)`,
    );
  }
  if (cfg.strategy.maxTickDelta > caps.maxTickDelta) {
    problems.push(
      `strategy maxTickDelta ${cfg.strategy.maxTickDelta} > on-chain maxTickDelta ${caps.maxTickDelta}`,
    );
  }
  if (problems.length > 0)
    refuse(`config caps exceed the lane's on-chain caps: ${problems.join("; ")}.`);
}

/** The signer must be the lane's operator, and never its owner (the Vault is never delegated). */
export function assertSignerBinding(
  signer: Address,
  lane: { operator: Address; owner: Address },
): void {
  const s = signer.toLowerCase();
  if (s === lane.owner.toLowerCase())
    refuse(`the signer ${signer} is the lane OWNER; the agent only ever signs as the operator.`);
  if (s !== lane.operator.toLowerCase())
    refuse(`the signer ${signer} is not the lane's on-chain operator ${lane.operator}.`);
}

/** The stricter of the agent's and the contract's rerange limits. */
export function effectiveRerangeLimits(
  cfg: AppConfig,
  caps: LaneCaps,
): { perHour: number; perDay: number; minIntervalSec: number } {
  return {
    perHour: Math.min(cfg.reranges.perHour, caps.reranges1h),
    perDay: Math.min(cfg.reranges.perDay, caps.reranges24h),
    minIntervalSec: Math.max(cfg.reranges.minIntervalSec, caps.minRerangeInterval),
  };
}

/** The guard's static limits: config values clamped by the lane's on-chain caps. */
export function guardLimitsFrom(cfg: AppConfig, caps: LaneCaps): GuardLimits {
  return {
    chainId: cfg.chainId,
    tickSpacing: cfg.strategy.tickSpacing,
    maxActionCents: Math.min(cfg.limits.maxActionCents, usd6ToCentsFloor(caps.maxDeployUsd6)),
    dailyTurnoverCents: Math.min(
      cfg.limits.dailyTurnoverCents,
      usd6ToCentsFloor(caps.turnoverUsd6PerDay),
    ),
    gasReserveWei: cfg.limits.gasReserveWei,
    maxSnapshotAgeMs: cfg.timing.snapshotMaxAgeMs,
    maxSimBlockAge: cfg.timing.simMaxBlockAge,
    deadlineMinAheadSec: cfg.timing.deadlineMinAheadSec,
    deadlineMaxAheadSec: Math.min(cfg.timing.deadlineMaxAheadSec, caps.maxDeadlineAhead),
    hurdleMultiple: cfg.strategy.hurdleMultiple,
    agentReranges: effectiveRerangeLimits(cfg, caps),
  };
}

/** A banner safe to log: capabilities and flags, no secrets, RPC path elided. */
export function describeConfig(cfg: AppConfig): string[] {
  const c = cfg.capabilities;
  return [
    `chain ${cfg.chainId} via ${redactRpcUrl(cfg.rpcUrl)}`,
    `lanes A=${cfg.lanes.A ?? "(db)"} B=${cfg.lanes.B ?? "(db)"}`,
    `signer ${cfg.signer.kind}`,
    `sense ${c.liveSense ? "LIVE" : "MOCK"}`,
    `overlay ${c.llm ? `LLM ${cfg.llm.model} @ ${redactRpcUrl(cfg.llm.baseURL)}` : "identity"}`,
    `dynamic ${c.dynamic ? "on" : "off"} · vault ${c.vault ? "on" : "off"} · webhook ${c.webhook ? "on" : "off"}`,
    `alerts ${c.telegram ? "Telegram" : "log-only"}`,
    `HL ${cfg.hl.mode}${cfg.hl.armed ? " ARMED" : ""}`,
    `default mode ${cfg.safety.defaultMode.toUpperCase()}`,
    `DRY_RUN ${cfg.safety.dryRun ? "ON" : "off"} · DESK_ARM ${cfg.safety.armed ? "1" : "0"}`,
    `caps $${cfg.limits.maxActionCents / 100}/action · $${cfg.limits.dailyTurnoverCents / 100}/24h`,
    cfg.signal.enabled
      ? `gate signals ON (≤ ${cfg.signal.maxPerHour}/h/lane, dwell ${cfg.signal.minDwellMs / 1000} s, ${cfg.signal.auto ? "auto" : "copilot asks"})`
      : "gate signals off",
  ];
}

// ---------------------------------------------------------------------------------------------
// Watchdog (separate process, GUARDIAN key only)

const WatchdogEnvSchema = z.object({
  CHAIN_ID: def(z.coerce.number().int().positive().default(CHAIN_ID_4663)),
  RH_RPC_URL: opt(z.url()),
  DESK_LANE_A: opt(addressSchema),
  DESK_LANE_B: opt(addressSchema),
  WATCHDOG_GUARDIAN_PRIVATE_KEY: opt(privateKeySchema),
  WATCHDOG_AGENT_URL: opt(z.url()),
  WATCHDOG_AGENT_KEY: opt(watchdogKeySchema),
  WATCHDOG_ARM: def(flag01.default("0")),
  WATCHDOG_DRY_RUN: def(boolStr.default("true")),
  WATCHDOG_INTERVAL_SEC: def(z.coerce.number().int().min(5).default(30)),
  WATCHDOG_NAV_DROP_PCT: def(z.coerce.number().positive().max(100).default(3)),
  WATCHDOG_REVERT_STREAK: def(z.coerce.number().int().min(1).default(3)),
  WATCHDOG_RERANGE_HEADROOM: def(z.coerce.number().int().min(0).default(1)),
  WATCHDOG_DEADMAN_MIN: def(z.coerce.number().int().min(1).default(15)),
  // An operator action unverified this long while the agent is down → pause (once per action).
  WATCHDOG_UNVERIFIED_MIN: def(z.coerce.number().int().min(1).default(15)),
  WATCHDOG_OPERATOR_RESERVE_ETH: def(decimalSchema.default("0.001")),
  // The watchdog's OWN bot: it long-polls getUpdates for /pause, and two pollers on one bot steal
  // each other's updates (the agent's approve/deny buttons included).
  WATCHDOG_TELEGRAM_BOT_TOKEN: opt(z.string().min(1)),
  WATCHDOG_TELEGRAM_CHAT_ID: opt(z.string().min(1)),
  // The agent's bot: send-only here (alerts), never polled by the watchdog.
  TELEGRAM_BOT_TOKEN: opt(z.string().min(1)),
  TELEGRAM_CHAT_ID: opt(z.string().min(1)),
  EXPLORER_URL: def(z.url().default(DEFAULT_EXPLORER_URL)),
  LOG_LEVEL: def(z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info")),
  // Present only to refuse them: the watchdog must never hold operator secrets.
  LOCAL_SIGNER_PRIVATE_KEY: opt(z.string()),
  DESK_VAULT_KEK_B64: opt(z.string()),
  DYNAMIC_API_KEY: opt(z.string()),
});

/** Every variable the watchdog reads. */
export const WATCHDOG_ENV_KEYS: readonly string[] = Object.keys(WatchdogEnvSchema.shape);

export interface WatchdogConfig {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  lanes: Address[];
  guardianPrivateKey: `0x${string}` | undefined;
  agentUrl: string | undefined;
  /** x-watchdog-key for the agent's GET /lanes/:lane/actions/:decisionId (required with agentUrl). */
  agentKey: string | undefined;
  armed: boolean;
  dryRun: boolean;
  intervalMs: number;
  thresholds: WatchdogThresholds;
  /**
   * Alerts go out on the watchdog's own bot, else on the agent's (sending is safe to share).
   * `listen` (the /pause command listener) is on only with the watchdog's OWN bot token.
   */
  telegram: { botToken: string | undefined; chatId: string | undefined; listen: boolean };
  logLevel: DeskEnv["LOG_LEVEL"];
}

export function loadWatchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const parsed = WatchdogEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigRefusedError(`invalid watchdog environment: ${issues}`);
  }
  const e = parsed.data;
  const rpcUrl = e.RH_RPC_URL ?? DEFAULT_RPC_URL;
  const loopback = isLoopbackUrl(rpcUrl);
  const dryRun = e.WATCHDOG_DRY_RUN === "true";
  const armed = e.WATCHDOG_ARM === "1";

  if (!loopback && (e.LOCAL_SIGNER_PRIVATE_KEY || e.DESK_VAULT_KEK_B64 || e.DYNAMIC_API_KEY)) {
    refuse(
      "the watchdog holds the GUARDIAN key only; remove LOCAL_SIGNER_PRIVATE_KEY / DESK_VAULT_KEK_B64 / DYNAMIC_API_KEY from its env.",
    );
  }
  if (e.CHAIN_ID !== CHAIN_ID_4663 && !loopback) {
    refuse(`CHAIN_ID=${e.CHAIN_ID} is only allowed against a loopback RPC.`);
  }
  if (!dryRun && !armed) refuse("WATCHDOG_DRY_RUN=false requires WATCHDOG_ARM=1.");
  // Every operator LaneAction is cross-checked with the agent: an agent URL without the key would
  // turn every one of them into an unverifiable action.
  if (e.WATCHDOG_AGENT_URL !== undefined && e.WATCHDOG_AGENT_KEY === undefined) {
    refuse(
      "WATCHDOG_AGENT_URL requires WATCHDOG_AGENT_KEY (≥ 32 chars, the same value as the agent's): the watchdog cross-checks every operator LaneAction with the agent.",
    );
  }
  if (!dryRun && e.WATCHDOG_GUARDIAN_PRIVATE_KEY === undefined) {
    refuse("WATCHDOG_DRY_RUN=false requires WATCHDOG_GUARDIAN_PRIVATE_KEY.");
  }
  // Live without the agent: no operator action could ever be verified, and its /health would read
  // as down (the dead-man switch would pause and exit at every scheduled action).
  if (!dryRun && e.WATCHDOG_AGENT_URL === undefined) {
    refuse(
      "WATCHDOG_DRY_RUN=false requires WATCHDOG_AGENT_URL (and WATCHDOG_AGENT_KEY): the watchdog cross-checks every operator LaneAction with the agent and reads its /health.",
    );
  }
  if (
    e.WATCHDOG_TELEGRAM_BOT_TOKEN !== undefined &&
    e.WATCHDOG_TELEGRAM_BOT_TOKEN === e.TELEGRAM_BOT_TOKEN
  ) {
    refuse(
      "WATCHDOG_TELEGRAM_BOT_TOKEN is the agent's TELEGRAM_BOT_TOKEN: two getUpdates pollers on one bot swallow each other's approvals and /pause. Create a separate bot for the watchdog.",
    );
  }
  const ownBot = e.WATCHDOG_TELEGRAM_BOT_TOKEN !== undefined;
  const chatId = e.WATCHDOG_TELEGRAM_CHAT_ID ?? e.TELEGRAM_CHAT_ID;

  return {
    chainId: e.CHAIN_ID,
    rpcUrl,
    explorerUrl: e.EXPLORER_URL,
    lanes: [e.DESK_LANE_A, e.DESK_LANE_B].filter((a): a is string => a !== undefined) as Address[],
    guardianPrivateKey: e.WATCHDOG_GUARDIAN_PRIVATE_KEY as `0x${string}` | undefined,
    agentUrl: e.WATCHDOG_AGENT_URL,
    agentKey: e.WATCHDOG_AGENT_KEY,
    armed,
    dryRun,
    intervalMs: e.WATCHDOG_INTERVAL_SEC * 1000,
    thresholds: {
      navDropPct: e.WATCHDOG_NAV_DROP_PCT,
      revertStreak: e.WATCHDOG_REVERT_STREAK,
      rerangeHeadroom: e.WATCHDOG_RERANGE_HEADROOM,
      operatorReserveWei: parseUnits(e.WATCHDOG_OPERATOR_RESERVE_ETH, 18),
      deadManMs: e.WATCHDOG_DEADMAN_MIN * 60_000,
      unverifiedMaxMs: e.WATCHDOG_UNVERIFIED_MIN * 60_000,
    },
    telegram: {
      botToken: e.WATCHDOG_TELEGRAM_BOT_TOKEN ?? e.TELEGRAM_BOT_TOKEN,
      chatId,
      listen: ownBot && chatId !== undefined,
    },
    logLevel: e.LOG_LEVEL,
  };
}

// ---------------------------------------------------------------------------------------------

let cached: AppConfig | undefined;

/** Lazy singleton for the daemon and scripts. Loads .env once (never in tests). */
export async function getConfig(): Promise<AppConfig> {
  if (!cached) {
    const { config: loadDotenv } = await import("dotenv");
    loadDotenv({ quiet: true });
    cached = loadConfig(process.env);
  }
  return cached;
}
