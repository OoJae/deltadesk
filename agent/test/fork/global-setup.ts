/**
 * Starts anvil forked from Robinhood Chain and deploys the desk with contracts/script/Deploy.s.sol,
 * or records why the fork suites must skip (FORK_RPC_URL unset, anvil or forge missing).
 *
 * FORK_RPC_URL can carry a provider key: it is passed to anvil only and never printed. Forge never
 * sees it (it talks to the local anvil). The deploy runs in a temporary copy of contracts/ (sources
 * and scripts copied, libraries symlinked) so out/, cache/, broadcast/ and the deployment record
 * never land in the contracts package. test/fork/MockFeed.sol is compiled alongside.
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
import type { TestProject } from "vitest/node";
import { Fork } from "./kit.js";

declare module "vitest" {
  export interface ProvidedContext {
    forkRpcUrl: string | null;
    forkSkipReason: string | null;
    forkFactory: string | null;
    forkFeedCode: string | null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(here, "../../../contracts");
/** anvil account #9: the fork deployer (loopback only). */
const DEPLOYER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

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

function freePort(): Promise<number> {
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

/**
 * Latency and archive status of the fork upstream. anvil reads every untouched slot AT THE FORK
 * BLOCK from it: a non-archive node (the public Robinhood RPC keeps roughly 10 minutes of state)
 * stops answering those reads once the fork block ages out, so the whole run must fit that window.
 */
async function upstreamHealth(url: string): Promise<string> {
  const call = async (method: string, params: unknown[]) => {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    return { ms: Date.now() - t0, result: body.result, error: body.error?.message ?? null };
  };
  try {
    const head = await call("eth_blockNumber", []);
    const latest = Number(head.result);
    // ~100 ms blocks: 20 000 blocks is about half an hour of history.
    const old = await call("eth_getStorageAt", [
      "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
      "0x4",
      `0x${Math.max(0, latest - 20_000).toString(16)}`,
    ]);
    const archive = old.error === null;
    return `${head.ms} ms per request; ${archive ? "serves 30 min old state (archive)" : `NOT an archive node (${old.error?.slice(0, 40)}…): the run must finish before the fork block ages out of its state window (about 10 min on the public RPC)`}`;
  } catch (err) {
    return `health probe failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const has = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

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

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  const skip = (reason: string) => {
    project.provide("forkRpcUrl", null);
    project.provide("forkSkipReason", reason);
    project.provide("forkFactory", null);
    project.provide("forkFeedCode", null);
    console.warn(`[fork] skipping fork suites: ${reason}`);
  };

  const forkUrl = process.env.FORK_RPC_URL;
  if (forkUrl === undefined || forkUrl === "") {
    skip("FORK_RPC_URL is not set");
    return undefined;
  }
  if (!has("anvil")) {
    skip("anvil is not installed");
    return undefined;
  }
  if (!has("forge")) {
    skip("forge is not installed");
    return undefined;
  }

  // Report what the upstream can do before depending on it (the key stays out of every message).
  const health = await upstreamHealth(forkUrl);
  console.warn(`[fork] upstream: ${health}`);

  const port = process.env.FORK_ANVIL_PORT ? Number(process.env.FORK_ANVIL_PORT) : await freePort();
  // --hardfork cancun (the contracts' evm_version): anvil's default hardfork adds an EIP-2935
  // block-hash write to every mined block, a fresh upstream storage read per block. A non-archive
  // upstream (the public RPC) stops serving the fork block's state after a while, and every block
  // would then fail. Cold state is still read from upstream at first touch (see kit.ts warm()).
  const args = ["--fork-url", forkUrl, "--port", String(port), "--silent", "--hardfork", "cancun"];
  // No local rate limit: the kit prefetches cold state with parallel reads (upstream 429s are retried).
  args.push("--retries", "8", "--timeout", "60000", "--no-rate-limit");
  if (process.env.FORK_BLOCK_NUMBER)
    args.push("--fork-block-number", process.env.FORK_BLOCK_NUMBER);
  const child: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  if (!(await waitForRpc(url, child, 90_000))) {
    child.kill("SIGKILL");
    skip(`anvil did not come up on port ${port} within 90 s (fork RPC unreachable?)`);
    return undefined;
  }

  const staged = stageContracts();
  const teardown = async () => {
    child.kill("SIGTERM");
    rmSync(staged, { recursive: true, force: true });
  };
  try {
    // The broadcaster stays the factory admin on the fork; no FOUNDRY_* override may redirect output.
    const env: NodeJS.ProcessEnv = { FOUNDRY_PROFILE: "default" };
    for (const [k, v] of Object.entries(process.env))
      if (!k.startsWith("FOUNDRY_") && k !== "DESK_ADMIN" && k !== "DEPLOYMENTS_FILE") env[k] = v;
    env.DEPLOYMENTS_FILE = "deployments/4663-fork.json";
    run("forge", ["build"], staged, env);
    run(
      "forge",
      [
        "script",
        "script/Deploy.s.sol",
        "--rpc-url",
        url,
        "--broadcast",
        "--private-key",
        DEPLOYER_KEY,
      ],
      staged,
      env,
    );
    const record = JSON.parse(
      readFileSync(join(staged, "deployments", "4663-fork.json"), "utf8"),
    ) as {
      factory: string;
      chainId: number;
    };
    if (record.chainId !== 4663) throw new Error(`fork chain id ${record.chainId}, expected 4663`);
    const artifact = JSON.parse(
      readFileSync(join(staged, "out", "MockFeed.sol", "MockFeed.json"), "utf8"),
    ) as { deployedBytecode: { object: string } };
    // Pull the pool state the suites will touch into anvil's cache, in parallel, once.
    const fork = new Fork(url);
    const t0 = Date.now();
    const radius = Number(process.env.FORK_PREFETCH_RADIUS ?? 500);
    const n = radius > 0 ? await fork.prefetchPool((await fork.slot0()).tick, radius) : 0;
    console.warn(`[fork] prefetched ${n} pool slots in ${Math.round((Date.now() - t0) / 1000)} s`);
    project.provide("forkRpcUrl", url);
    project.provide("forkSkipReason", null);
    project.provide("forkFactory", record.factory.toLowerCase());
    project.provide("forkFeedCode", artifact.deployedBytecode.object);
    console.warn(`[fork] anvil on :${port}, factory ${record.factory}`);
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}
