/**
 * Config refusals: every unsafe combination refuses to start with a ConfigRefusedError. The
 * environment is always synthetic (never process.env).
 */

import { readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import {
  assertConfigWithinOnchainCaps,
  assertRpcChainId,
  assertSignerBinding,
  DESK_ENV_KEYS,
  describeConfig,
  effectiveRerangeLimits,
  guardLimitsFrom,
  isLoopbackUrl,
  loadConfig,
  loadWatchdogConfig,
  redactRpcUrl,
  scrubRpcUrl,
  WATCHDOG_ENV_KEYS,
} from "../../src/config.js";
import { ConfigRefusedError, type LaneCaps } from "../../src/types.js";
import { ANVIL_KEY_0, OPERATOR, OWNER } from "../helpers/fakes.js";

const KEK = Buffer.alloc(32, 7).toString("base64");
const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123";
const LIVE_DYNAMIC = {
  DRY_RUN: "false",
  DESK_ARM: "1",
  DYNAMIC_ENVIRONMENT_ID: "env-123",
  DYNAMIC_API_KEY: "dyn_abc",
  DESK_VAULT_KEK_B64: KEK,
};
const M2_CAPS: LaneCaps = {
  maxDeployUsd6: 60_000_000n,
  turnoverUsd6PerDay: 150_000_000n,
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

const refuses = (env: Record<string, string>, pattern: RegExp) => {
  expect(() => loadConfig(env)).toThrow(ConfigRefusedError);
  expect(() => loadConfig(env)).toThrow(pattern);
};

describe("defaults are safe", () => {
  it("an empty env is dry-run, disarmed, advisory, paper HL, identity overlay, chain 4663", () => {
    const cfg = loadConfig({});
    expect(cfg.safety).toMatchObject({
      dryRun: true,
      armed: false,
      defaultMode: "advisory",
      senseMock: false,
    });
    expect(cfg.hl.mode).toBe("paper");
    expect(cfg.capabilities.llm).toBe(false);
    expect(cfg.chainId).toBe(4663);
    expect(cfg.signer.kind).toBe("dynamic-delegated");
    expect(cfg.limits.maxActionCents).toBe(6000);
    expect(cfg.limits.dailyTurnoverCents).toBe(15_000);
    expect(cfg.limits.gasReserveWei).toBe(10n ** 15n);
    expect(cfg.timing.deadlineSec).toBe(45);
    expect(cfg.llm.baseURL).toBe("https://llm.bankr.bot");
  });

  it("treats empty strings as unset, so a copied .env.example is inert", () => {
    const cfg = loadConfig({ DRY_RUN: "", DESK_ARM: "", RH_RPC_URL: "", TELEGRAM_BOT_TOKEN: " " });
    expect(cfg.safety.dryRun).toBe(true);
    expect(cfg.capabilities.telegram).toBe(false);
  });
});

describe("strict safety enums", () => {
  for (const [key, bad] of [
    ["DRY_RUN", "flase"],
    ["DRY_RUN", "TRUE"],
    ["DRY_RUN", "0"],
    ["DESK_ARM", "yes"],
    ["DESK_ARM", "true"],
    ["HL_ARM", "on"],
    ["DESK_OVERLAY", "true"],
    ["DESK_MODE", "auto"],
    ["SIGNER_KIND", "owner"],
  ] as const) {
    it(`${key}=${bad} fails loudly instead of coercing`, () =>
      refuses({ [key]: bad }, /invalid environment/));
  }
});

describe("refusals", () => {
  it("half-armed on 4663: DRY_RUN=false without DESK_ARM=1", () =>
    refuses({ DRY_RUN: "false" }, /DESK_ARM=1/));

  it("a local signer with a remote RPC (proof 18)", () => {
    refuses(
      { SIGNER_KIND: "local", LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0, RH_RPC_URL: ALCHEMY },
      /loopback/,
    );
    refuses({ SIGNER_KIND: "local", LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0 }, /loopback/); // default RPC is remote
  });

  it("a local signer against anvil is fine, even armed", () => {
    const cfg = loadConfig({
      SIGNER_KIND: "local",
      LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0,
      RH_RPC_URL: "http://127.0.0.1:8546",
      DRY_RUN: "false",
      DESK_ARM: "1",
    });
    expect(cfg.signer.kind).toBe("local");
  });

  it("a raw key sitting next to a remote RPC, whatever the signer kind", () =>
    refuses({ LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0, RH_RPC_URL: ALCHEMY }, /Remove it/));

  it("SIGNER_KIND=local without its key", () =>
    refuses({ SIGNER_KIND: "local", RH_RPC_URL: "http://localhost:8545" }, /requires/));

  it("another chain id against a remote RPC (the arm rule can't be sidestepped)", () =>
    refuses({ CHAIN_ID: "31337", RH_RPC_URL: ALCHEMY }, /loopback/));

  it("a live Dynamic signer without its credentials or the vault KEK", () => {
    refuses({ DRY_RUN: "false", DESK_ARM: "1" }, /DYNAMIC_ENVIRONMENT_ID/);
    refuses({ ...LIVE_DYNAMIC, DESK_VAULT_KEK_B64: "" }, /DESK_VAULT_KEK_B64/);
    expect(loadConfig(LIVE_DYNAMIC).capabilities).toMatchObject({ dynamic: true, vault: true });
  });

  it("a live server-wallet signer without its wallet address", () =>
    refuses({ ...LIVE_DYNAMIC, SIGNER_KIND: "dynamic-server" }, /DYNAMIC_SERVER_WALLET_ADDRESS/));

  it("a KEK that is not 32 bytes", () =>
    refuses({ DESK_VAULT_KEK_B64: Buffer.alloc(16).toString("base64") }, /32 bytes/));

  it("a mock sensor driving a live signer", () =>
    refuses({ ...LIVE_DYNAMIC, DESK_SENSE_MOCK: "1" }, /mock snapshot/));

  it("live HL without arm and keys", () => {
    refuses({ HL_MODE: "live" }, /HL_ARM=1/);
    refuses({ HL_MODE: "live", HL_ARM: "1" }, /HL_AGENT_PRIVATE_KEY/);
  });

  it("autopilot without a cancel window", () =>
    refuses({ DESK_MODE: "autopilot" }, /CANCEL_WINDOW/));

  it("inconsistent limits", () => {
    refuses(
      { DESK_MAX_ACTION_USD: "200", DESK_DAILY_TURNOVER_USD: "150" },
      /exceeds DESK_DAILY_TURNOVER_USD/,
    );
    refuses({ DESK_RERANGES_PER_HOUR: "30", DESK_RERANGES_PER_DAY: "24" }, /PER_HOUR/);
    refuses({ DESK_FEE_FLOOR_GWEI: "5", DESK_MAX_FEE_GWEI: "2" }, /FLOOR/);
    refuses({ DESK_DEADLINE_SEC: "90" }, /invalid environment/);
    refuses({ DESK_MIN_RERANGE_INTERVAL_SEC: "30" }, /invalid environment/);
  });
});

describe("startup hooks", () => {
  it("config caps above the on-chain caps refuse to start (proof 21)", () => {
    const cfg = loadConfig({});
    expect(() => assertConfigWithinOnchainCaps(cfg, M2_CAPS)).not.toThrow();
    expect(() =>
      assertConfigWithinOnchainCaps(cfg, { ...M2_CAPS, maxDeployUsd6: 59_999_999n }),
    ).toThrow(/maxDeployUsd6/);
    expect(() =>
      assertConfigWithinOnchainCaps(cfg, { ...M2_CAPS, turnoverUsd6PerDay: 100_000_000n }),
    ).toThrow(/turnoverUsd6PerDay/);
    // DESK_DEADLINE_SEC is clamped to a tightened maxDeadlineAhead (the owner's instant safety
    // move must not keep the lane out of the loop); only a cap with no valid window refuses.
    expect(() =>
      assertConfigWithinOnchainCaps(cfg, { ...M2_CAPS, maxDeadlineAhead: 30 }),
    ).not.toThrow();
    expect(() => assertConfigWithinOnchainCaps(cfg, { ...M2_CAPS, maxDeadlineAhead: 4 })).toThrow(
      /maxDeadlineAhead/,
    );
    expect(() => assertConfigWithinOnchainCaps(cfg, { ...M2_CAPS, maxTickDelta: 5 })).toThrow(
      /maxTickDelta/,
    );
  });

  it("the signer is never the owner, and must be the operator (proof 22)", () => {
    expect(() => assertSignerBinding(OPERATOR, { operator: OPERATOR, owner: OWNER })).not.toThrow();
    expect(() => assertSignerBinding(OWNER, { operator: OWNER, owner: OWNER })).toThrow(/OWNER/);
    expect(() => assertSignerBinding(OWNER, { operator: OPERATOR, owner: OWNER })).toThrow(
      ConfigRefusedError,
    );
    expect(() =>
      assertSignerBinding(OPERATOR.toUpperCase().replace("0X", "0x") as `0x${string}`, {
        operator: OPERATOR,
        owner: OWNER,
      }),
    ).not.toThrow();
    expect(() =>
      assertSignerBinding(OPERATOR, {
        operator: OWNER,
        owner: "0x4444444444444444444444444444444444444444",
      }),
    ).toThrow(/not the lane's on-chain operator/);
  });

  it("the RPC must be the configured chain", () => {
    const cfg = loadConfig({});
    expect(() => assertRpcChainId(cfg, 4663)).not.toThrow();
    expect(() => assertRpcChainId(cfg, 1)).toThrow(/chainId 1/);
  });

  it("guard limits are the stricter of config and chain", () => {
    const cfg = loadConfig({
      DESK_MAX_ACTION_USD: "50",
      DESK_RERANGES_PER_HOUR: "6",
      DESK_MIN_RERANGE_INTERVAL_SEC: "120",
    });
    const limits = guardLimitsFrom(cfg, M2_CAPS);
    expect(limits.maxActionCents).toBe(5000);
    expect(limits.dailyTurnoverCents).toBe(15_000);
    expect(limits.deadlineMaxAheadSec).toBe(60);
    expect(effectiveRerangeLimits(cfg, M2_CAPS)).toEqual({
      perHour: 4,
      perDay: 24,
      minIntervalSec: 300,
    });
  });
});

describe("secrets never reach logs", () => {
  it("elides key-bearing RPC paths", () => {
    expect(redactRpcUrl(ALCHEMY)).toBe("https://robinhood-mainnet.g.alchemy.com/…");
    expect(redactRpcUrl("https://rpc.mainnet.chain.robinhood.com")).toBe(
      "https://rpc.mainnet.chain.robinhood.com",
    );
    expect(scrubRpcUrl(`fetch failed: ${ALCHEMY} (HTTP 500)`, ALCHEMY)).not.toContain(
      "SECRETKEY123",
    );
    expect(scrubRpcUrl("POST /v2/SECRETKEY123 failed", ALCHEMY)).not.toContain("SECRETKEY123");
  });

  it("describeConfig carries no secret values", () => {
    const cfg = loadConfig({
      ...LIVE_DYNAMIC,
      RH_RPC_URL: ALCHEMY,
      BANKR_LLM_API_KEY: "bk_supersecret",
      TELEGRAM_BOT_TOKEN: "123:telegramsecret",
      TELEGRAM_CHAT_ID: "42",
      DYNAMIC_WEBHOOK_SECRET: "whsec_0123456789abcdef",
      DELTADESK_API_KEY: "premiumsecret",
    });
    const banner = describeConfig(cfg).join("\n");
    for (const secret of [
      "SECRETKEY123",
      "bk_supersecret",
      "telegramsecret",
      "dyn_abc",
      KEK,
      "whsec_0123456789abcdef",
      "premiumsecret",
    ]) {
      expect(banner).not.toContain(secret);
    }
  });

  it("recognises loopback hosts only", () => {
    for (const u of [
      "http://127.0.0.1:8545",
      "http://localhost:8545",
      "http://[::1]:8545",
      "http://127.1.2.3",
    ]) {
      expect(isLoopbackUrl(u), u).toBe(true);
    }
    for (const u of [
      "https://rpc.mainnet.chain.robinhood.com",
      "http://10.0.0.1",
      "http://localhost.evil.com",
      "nonsense",
    ]) {
      expect(isLoopbackUrl(u), u).toBe(false);
    }
  });

  it("normalises an escaped PEM", () => {
    const cfg = loadConfig({
      DYNAMIC_RSA_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });
    expect(cfg.dynamic.rsaPrivateKeyPem).toContain("\nabc\n");
  });
});

describe("watchdog config", () => {
  it("defaults to dry-run and refuses to hold operator secrets", () => {
    expect(loadWatchdogConfig({}).dryRun).toBe(true);
    expect(() => loadWatchdogConfig({ DESK_VAULT_KEK_B64: KEK })).toThrow(/GUARDIAN key only/);
    expect(() => loadWatchdogConfig({ DYNAMIC_API_KEY: "dyn_abc" })).toThrow(ConfigRefusedError);
  });

  it("refuses to go live without arm and the guardian key", () => {
    expect(() => loadWatchdogConfig({ WATCHDOG_DRY_RUN: "false" })).toThrow(/WATCHDOG_ARM=1/);
    expect(() => loadWatchdogConfig({ WATCHDOG_DRY_RUN: "false", WATCHDOG_ARM: "1" })).toThrow(
      /GUARDIAN_PRIVATE_KEY/,
    );
    const live = {
      WATCHDOG_DRY_RUN: "false",
      WATCHDOG_ARM: "1",
      WATCHDOG_GUARDIAN_PRIVATE_KEY: ANVIL_KEY_0,
      DESK_LANE_A: OPERATOR,
    };
    // Live without the agent: every operator action unverifiable, and /health reads as down.
    expect(() => loadWatchdogConfig(live)).toThrow(/requires WATCHDOG_AGENT_URL/);
    const cfg = loadWatchdogConfig({
      ...live,
      WATCHDOG_AGENT_URL: "http://desk-agent:8080",
      WATCHDOG_AGENT_KEY: "a".repeat(32),
    });
    expect(cfg.lanes).toEqual([OPERATOR]);
    expect(cfg.thresholds.deadManMs).toBe(15 * 60_000);
    expect(cfg.thresholds.unverifiedMaxMs).toBe(15 * 60_000);
    expect(loadWatchdogConfig({ WATCHDOG_UNVERIFIED_MIN: "5" }).thresholds.unverifiedMaxMs).toBe(
      5 * 60_000,
    );
    expect(() => loadWatchdogConfig({ WATCHDOG_UNVERIFIED_MIN: "0" })).toThrow(ConfigRefusedError);
  });
});

describe("WATCHDOG_AGENT_KEY: the watchdog's own shared secret for the cross-check route", () => {
  const KEY = "a".repeat(16) + "b".repeat(16);

  it("agent: unset leaves the route off; short, padded or equal to the web's key is refused", () => {
    expect(loadConfig({}).http.watchdogKey).toBeUndefined();
    expect(loadConfig({ WATCHDOG_AGENT_KEY: "" }).http.watchdogKey).toBeUndefined();
    expect(loadConfig({ WATCHDOG_AGENT_KEY: KEY }).http.watchdogKey).toBe(KEY);
    expect(() => loadConfig({ WATCHDOG_AGENT_KEY: "short-key-0123456789" })).toThrow(
      /WATCHDOG_AGENT_KEY must be at least 32 characters/,
    );
    expect(() => loadConfig({ WATCHDOG_AGENT_KEY: ` ${KEY}` })).toThrow(/surrounding whitespace/);
    expect(() => loadConfig({ WATCHDOG_AGENT_KEY: KEY, DESK_AGENT_API_KEY: KEY })).toThrow(
      /WATCHDOG_AGENT_KEY equals DESK_AGENT_API_KEY/,
    );
  });

  it("watchdog: an agent URL needs the key; a short key is refused", () => {
    expect(() => loadWatchdogConfig({ WATCHDOG_AGENT_URL: "http://desk-agent:8080" })).toThrow(
      /WATCHDOG_AGENT_URL requires WATCHDOG_AGENT_KEY/,
    );
    expect(() =>
      loadWatchdogConfig({
        WATCHDOG_AGENT_URL: "http://desk-agent:8080",
        WATCHDOG_AGENT_KEY: "",
      }),
    ).toThrow(/requires WATCHDOG_AGENT_KEY/);
    expect(() =>
      loadWatchdogConfig({ WATCHDOG_AGENT_URL: "http://desk-agent:8080", WATCHDOG_AGENT_KEY: "x" }),
    ).toThrow(/at least 32 characters/);
    const cfg = loadWatchdogConfig({
      WATCHDOG_AGENT_URL: "http://desk-agent:8080",
      WATCHDOG_AGENT_KEY: KEY,
    });
    expect(cfg).toMatchObject({ agentUrl: "http://desk-agent:8080", agentKey: KEY });
    expect(loadWatchdogConfig({}).agentKey).toBeUndefined();
  });
});

describe("watchdog Telegram: its own bot, never the agent's", () => {
  it("refuses the agent's token as the watchdog's (two getUpdates pollers steal updates)", () => {
    expect(() =>
      loadWatchdogConfig({ TELEGRAM_BOT_TOKEN: "123:abc", WATCHDOG_TELEGRAM_BOT_TOKEN: "123:abc" }),
    ).toThrow(/separate bot/);
  });

  it("listens for /pause only on its own bot; with only the agent's token it just sends alerts", () => {
    const shared = loadWatchdogConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" });
    expect(shared.telegram).toEqual({ botToken: "123:abc", chatId: "42", listen: false });
    const own = loadWatchdogConfig({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "42",
      WATCHDOG_TELEGRAM_BOT_TOKEN: "456:def",
    });
    expect(own.telegram).toEqual({ botToken: "456:def", chatId: "42", listen: true });
    expect(loadWatchdogConfig({}).telegram.listen).toBe(false);
  });
});

describe(".env.example", () => {
  const example = parseDotenv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));

  it("loads as a safe, inert configuration for both services", () => {
    const cfg = loadConfig(example);
    expect(cfg.safety).toMatchObject({ dryRun: true, armed: false, defaultMode: "advisory" });
    expect(cfg.capabilities).toMatchObject({
      dynamic: false,
      vault: false,
      telegram: false,
      llm: false,
      hlLive: false,
    });
    expect(loadWatchdogConfig(example).dryRun).toBe(true);
  });

  it("documents exactly the variables the schemas read (plus the fork-test knobs)", () => {
    const documented = new Set(Object.keys(example));
    const read = new Set([
      ...DESK_ENV_KEYS,
      ...WATCHDOG_ENV_KEYS,
      "FORK_RPC_URL",
      "FORK_BLOCK_NUMBER",
      "FORK_ANVIL_PORT",
    ]);
    expect([...read].filter((k) => !documented.has(k))).toEqual([]);
    expect([...documented].filter((k) => !read.has(k))).toEqual([]);
  });
});
