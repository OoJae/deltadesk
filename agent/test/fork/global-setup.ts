/**
 * Starts anvil forked from Robinhood Chain and deploys the desk with contracts/script/Deploy.s.sol
 * (anvil.ts: from a temporary copy of contracts/, so nothing is written there), or records why the
 * fork suites must skip (FORK_RPC_URL unset, anvil or forge missing).
 *
 * FORK_RPC_URL can carry a provider key: it is passed to anvil only and never printed.
 */

import type { TestProject } from "vitest/node";
import { cupsFromEnv, has, launchFork } from "./anvil.js";

declare module "vitest" {
  export interface ProvidedContext {
    forkRpcUrl: string | null;
    forkSkipReason: string | null;
    forkFactory: string | null;
    forkFeedCode: string | null;
    /** The staged, built contracts copy (a suite launching its own pinned fork reuses it). */
    forkStagedDir: string | null;
  }
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

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  const skip = (reason: string) => {
    project.provide("forkRpcUrl", null);
    project.provide("forkSkipReason", reason);
    project.provide("forkFactory", null);
    project.provide("forkFeedCode", null);
    project.provide("forkStagedDir", null);
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

  let fork: Awaited<ReturnType<typeof launchFork>>;
  try {
    fork = await launchFork({
      forkUrl,
      blockNumber: process.env.FORK_BLOCK_NUMBER,
      port: process.env.FORK_ANVIL_PORT ? Number(process.env.FORK_ANVIL_PORT) : undefined,
      prefetchRadius: Number(process.env.FORK_PREFETCH_RADIUS ?? 500),
      computeUnitsPerSecond: cupsFromEnv(),
    });
  } catch (err) {
    if (err instanceof Error && /did not come up/.test(err.message)) {
      skip(err.message);
      return undefined;
    }
    throw err;
  }
  project.provide("forkRpcUrl", fork.url);
  project.provide("forkSkipReason", null);
  project.provide("forkFactory", fork.factory);
  project.provide("forkFeedCode", fork.feedCode);
  project.provide("forkStagedDir", fork.stagedDir);
  console.warn(`[fork] anvil on ${fork.url}, factory ${fork.factory}`);
  return () => fork.stop();
}
