// Native addon smoke test (Docker build + `docker run … node scripts/native-check.mjs`).
//
// The desk-agent loads two native addons, both glibc builds on Linux:
//   better-sqlite3                 the SQLite store (every decision, execution and signed byte)
//   @dynamic-labs-wallet/node      the Dynamic MPC executor, a Neon (Rust) addon shipped as
//                                  internal/node/native/libmpc_executor_<os>_<arch>_nodejs.node,
//                                  loaded eagerly by the package itself: the delegated signer and
//                                  the webhook's decryption both need it
// (@dynamic-labs-wallet/node-evm is imported too: it is what the signer calls, on top of the addon.)
//
// Each one is loaded AND exercised offline (a SQLite query; the addon's initKeygen, which draws a
// fresh local MPC keypair, prints nothing of it and needs no network). Then it prints every `.node`
// file the process actually mapped (process.report sharedObjects) and, on Linux, the newest GLIBC
// symbol version each one needs. Exits 1 on any failure: a build or a boot must never get past an
// addon that did not land for this platform.
//
// Plain .mjs (no tsx) so the Docker deps stage can run it before the sources are copied.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function glibcNeeds(file) {
  if (process.platform !== "linux") return null;
  const text = readFileSync(file).toString("latin1");
  const versions = [...new Set(text.match(/GLIBC_\d+\.\d+(\.\d+)?/g) ?? [])];
  const key = (v) => v.slice(6).split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  return versions.at(-1) ?? "none";
}

try {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  const { v } = db.prepare("select sqlite_version() as v").get();
  db.close();
  console.log(`better-sqlite3: ok (SQLite ${v})`);

  await import("@dynamic-labs-wallet/node");
  await import("@dynamic-labs-wallet/node-evm");
  const pkg = dirname(require.resolve("@dynamic-labs-wallet/node/package.json"));
  const { NodeNativeSdk } = require(join(pkg, "internal", "node", "native.cjs"));
  const k = await NodeNativeSdk.initKeygen();
  if (typeof k?.pubkey !== "string" || k.pubkey.length < 32)
    throw new Error("the Dynamic MPC addon loaded but initKeygen returned no keypair");
  console.log("@dynamic-labs-wallet/node + node-evm: ok (MPC addon initKeygen answered offline)");

  const loaded = process.report
    .getReport()
    .sharedObjects.filter((f) => f.endsWith(".node"))
    .sort();
  if (!loaded.some((f) => f.includes("better_sqlite3") || f.includes("better-sqlite3")))
    throw new Error("better-sqlite3's .node file is not mapped");
  if (!loaded.some((f) => /libmpc_executor_.+_nodejs\.node$/.test(f)))
    throw new Error("the Dynamic libmpc_executor .node file is not mapped");
  console.log(`platform: ${process.platform}/${process.arch}, node ${process.version}`);
  for (const f of loaded) {
    const need = glibcNeeds(f);
    console.log(`loaded: ${f}${need === null ? "" : ` (needs up to ${need})`}`);
  }
} catch (err) {
  console.error(`native addon check FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
