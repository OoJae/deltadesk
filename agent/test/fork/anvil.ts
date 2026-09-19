/**
 * One anvil fork of Robinhood Chain with the desk deployed by contracts/script/Deploy.s.sol, from a
 * temporary copy of contracts/ (sources and scripts copied, libraries symlinked) so out/, cache/,
 * broadcast/ and the deployment record never land in the contracts package; test/fork/MockFeed.sol
 * is compiled alongside. Used by global-setup.ts (the shared fork) and by a suite that needs its own
 * pinned block (weekend.test.ts).
 *
 * The upstream URL can carry a provider key: it is passed to anvil only and never printed. Forge
 * never sees it (it talks to the local anvil).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "../../src/types.js";
import { Fork } from "./kit.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(here, "../../../contracts");
/** anvil account #9: the fork deployer (loopback only). */
const DEPLOYER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

export interface LaunchedFork {
  url: string;
  factory: Address;
  /** MockFeed runtime bytecode (the kit installs it over the Chainlink proxies when told to). */
  feedCode: Hex;
  /** The staged contracts copy (built): another launch can reuse it and skip `forge build`. */
  stagedDir: string;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  forkUrl: string;
  /** Pin (needs an archive upstream); omitted: the upstream's latest block. */
  blockNumber?: string | number | undefined;
  port?: number | undefined;
  /** Pool ticks around the current one to pull into anvil's cache up front (0: none). */
  prefetchRadius: number;
  /** A staged, built contracts copy to reuse (not removed by stop()). */
  stagedDir?: string | undefined;
  /** anvil --compute-units-per-second (FORK_ANVIL_CUPS); undefined: --no-rate-limit. */
  computeUnitsPerSecond?: number | undefined;
}

/** FORK_ANVIL_CUPS from the environment, if set. */
export function cupsFromEnv(): number | undefined {
  const v = process.env.FORK_ANVIL_CUPS;
  return v === undefined || v === "" ? undefined : Number(v);
}

export const has = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

async function waitForRpc(url: string, child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0)
    throw new Error(`${cmd} ${args[0]} failed (${r.status}):\n${out.slice(-4000)}`);
  return out;
}

/** An isolated copy of the contracts project with the test feed added. */
function stageContracts(): string {
  const dir = mkdtempSync(join(tmpdir(), "deltadesk-fork-"));
  cpSync(join(CONTRACTS, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(CONTRACTS, "script"), join(dir, "script"), { recursive: true });
  cpSync(join(CONTRACTS, "foundry.toml"), join(dir, "foundry.toml"));
  cpSync(join(CONTRACTS, "remappings.txt"), join(dir, "remappings.txt"));
  symlinkSync(join(CONTRACTS, "lib"), join(dir, "lib"));
  if (existsSync(join(CONTRACTS, "node_modules")))
    symlinkSync(join(CONTRACTS, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "src", "fork-e2e"), { recursive: true });
  cpSync(join(here, "MockFeed.sol"), join(dir, "src", "fork-e2e", "MockFeed.sol"));
  mkdirSync(join(dir, "deployments"), { recursive: true });
  return dir;
}

/** Start anvil over the upstream, deploy the desk, optionally prefetch the pool state. */
export async function launchFork(o: LaunchOptions): Promise<LaunchedFork> {
  const port = o.port ?? (await freePort());
  // --hardfork cancun (the contracts' evm_version): anvil's default hardfork adds an EIP-2935
  // block-hash write to every mined block, a fresh upstream storage read per block. A non-archive
  // upstream (the public RPC) stops serving the fork block's state after a while, and every block
  // would then fail. Cold state is still read from upstream at first touch (see kit.ts warm()).
  const args = [
    "--fork-url",
    o.forkUrl,
    "--port",
    String(port),
    "--silent",
    "--hardfork",
    "cancun",
  ];
  // Upstream pacing: FORK_ANVIL_CUPS caps anvil's compute units per second (be gentle on a key
  // another campaign shares) with a longer 429 backoff; unset, no local rate limit (the kit
  // prefetches cold state with parallel reads). Upstream 429s are retried with backoff either way.
  args.push("--retries", "8", "--timeout", "60000");
  if (o.computeUnitsPerSecond !== undefined)
    args.push(
      "--compute-units-per-second",
      String(o.computeUnitsPerSecond),
      "--fork-retry-backoff",
      "2000",
    );
  else args.push("--no-rate-limit");
  if (o.blockNumber !== undefined && String(o.blockNumber) !== "")
    args.push("--fork-block-number", String(o.blockNumber));
  const child: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  if (!(await waitForRpc(url, child, 90_000))) {
    child.kill("SIGKILL");
    throw new Error(`anvil did not come up on port ${port} within 90 s (fork RPC unreachable?)`);
  }

  const ownStage = o.stagedDir === undefined;
  const staged = o.stagedDir ?? stageContracts();
  const stop = async () => {
    child.kill("SIGTERM");
    if (ownStage) rmSync(staged, { recursive: true, force: true });
  };
  try {
    // The broadcaster stays the factory admin on the fork; no FOUNDRY_* override may redirect output.
    const env: NodeJS.ProcessEnv = { FOUNDRY_PROFILE: "default" };
    for (const [k, v] of Object.entries(process.env))
      if (!k.startsWith("FOUNDRY_") && k !== "DESK_ADMIN" && k !== "DEPLOYMENTS_FILE") env[k] = v;
    env.DEPLOYMENTS_FILE = "deployments/4663-fork.json";
    if (ownStage) run("forge", ["build"], staged, env);
    // Legacy transactions at a fixed price: forge's EIP-1559 estimate asks eth_feeHistory over
    // blocks that, on a fork pinned in the past, anvil forwards upstream (Alchemy's 4663 endpoint
    // answers "metadata is not found" for them).
    run(
      "forge",
      [
        "script",
        "script/Deploy.s.sol",
        "--rpc-url",
        url,
        "--broadcast",
        "--legacy",
        "--with-gas-price",
        "2000000000",
        "--private-key",
        DEPLOYER_KEY,
      ],
      staged,
      env,
    );
    const record = JSON.parse(
      readFileSync(join(staged, "deployments", "4663-fork.json"), "utf8"),
    ) as { factory: string; chainId: number };
    if (record.chainId !== 4663) throw new Error(`fork chain id ${record.chainId}, expected 4663`);
    const artifact = JSON.parse(
      readFileSync(join(staged, "out", "MockFeed.sol", "MockFeed.json"), "utf8"),
    ) as { deployedBytecode: { object: string } };
    if (o.prefetchRadius > 0) {
      // Pull the pool state the suites will touch into anvil's cache, in parallel, once.
      const fork = new Fork(url);
      const t0 = Date.now();
      const n = await fork.prefetchPool((await fork.slot0()).tick, o.prefetchRadius);
      console.warn(
        `[fork] prefetched ${n} pool slots in ${Math.round((Date.now() - t0) / 1000)} s`,
      );
    }
    return {
      url,
      factory: record.factory.toLowerCase() as Address,
      feedCode: artifact.deployedBytecode.object as Hex,
      stagedDir: staged,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
