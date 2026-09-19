import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRsaKeyPair, publicPathFor, writeRsaKeyPair } from "../../../scripts/gen-rsa.js";
import { NVDA_USDG_POOL } from "../../../src/addresses.js";
import {
  createDynamicWebhookHandler,
  signDynamicPayload,
} from "../../../src/http/dynamic-webhook.js";
import { createHttpApp, healthView, startHttpServer } from "../../../src/http/server.js";
import { silentLogger } from "../../../src/log.js";
import { createVault } from "../../../src/signer/vault.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import { deskRow, FakeChain, LANE, T0 } from "../executor/_fixtures.js";

function tick(atMs: number) {
  return {
    laneAddress: LANE,
    atMs,
    blockNumber: null,
    blockTs: null,
    poolTick: null,
    sqrtPriceX96: null,
    poolMid: null,
    hlMid: null,
    k: null,
    kSource: null,
    fairValue: null,
    gapBps: null,
    refTick: null,
    bandTicks: null,
    fenceCode: null,
    regime: "REGULAR" as const,
    reopenKind: null,
    sessionDate: "2026-09-21",
    gatesMask: 0,
    activeGatesJson: "[]",
    riskMode: "normal" as const,
    sourcesJson: "{}",
  };
}

describe("GET /health", () => {
  it("reports last tick age, lock and pending executions; ok only when fresh and locked", () => {
    const db = memDb();
    const clock = fixedClock(T0);
    const view = () => healthView({ db, clock, staleTickMs: 60_000, lockStaleMs: 60_000 });
    expect(view()).toEqual({
      ok: false,
      lastTickAgeMs: null,
      lockHeld: false,
      pendingExecutions: 0,
      nowMs: T0,
    });
    db.insertDesk(deskRow());
    db.insertTick(tick(T0 - 4_000));
    db.acquireDaemonLock({ ownerId: "a", pid: 1, host: "h" }, T0 - 1_000, 60_000);
    expect(view()).toMatchObject({ ok: true, lastTickAgeMs: 4_000, lockHeld: true });
    clock.advance(120_000);
    expect(view()).toMatchObject({ ok: false, lockHeld: false });
  });

  it("is public (no agent key) while the desk API is not", async () => {
    const db = memDb();
    const app = createHttpApp({
      health: () =>
        healthView({ db, clock: fixedClock(T0), staleTickMs: 60_000, lockStaleMs: 60_000 }),
      webhook: null,
      desks: null,
      logger: silentLogger,
    });
    const r = await app.request("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, pendingExecutions: 0 });
    expect((await app.request("/desks", { method: "POST" })).status).toBe(503);
    expect((await app.request("/webhooks/dynamic", { method: "POST", body: "{}" })).status).toBe(
      503,
    );
    expect((await app.request("/nope")).status).toBe(404);
  });
});

describe("route scoping", () => {
  it("with the desk API mounted and an agent key set, /health and the webhook stay reachable", async () => {
    const db = memDb();
    const secret = "whsec_scope_test_0123456789";
    const app = createHttpApp({
      health: () =>
        healthView({ db, clock: fixedClock(T0), staleTickMs: 60_000, lockStaleMs: 60_000 }),
      webhook: createDynamicWebhookHandler({
        db,
        secret,
        environmentId: undefined,
        rsaPrivateKeyPem: () => "",
        vault: createVault({ kekB64: Buffer.alloc(32, 2).toString("base64"), kekId: "k1" }),
        clock: fixedClock(T0),
        logger: silentLogger,
      }),
      desks: {
        db,
        chain: new FakeChain(),
        jwt: null,
        agentApiKey: "agent-key-0123456789abcdefghij",
        chainId: 4663,
        factoryAddress: undefined,
        allowedPools: [NVDA_USDG_POOL.address],
        signerKind: "dynamic-delegated",
        ownOperators: [],
        serverWalletAddress: undefined,
        defaultMode: "advisory",
        cancelWindowMs: 0,
        clock: fixedClock(T0),
        logger: silentLogger,
      },
      logger: silentLogger,
    });
    expect((await app.request("/health")).status).toBe(200);
    const raw = '{"eventId":"e","eventName":"ping","data":{}}';
    expect(
      (
        await app.request("/webhooks/dynamic", {
          method: "POST",
          body: raw,
          headers: { "x-dynamic-signature-256": signDynamicPayload(raw, secret) },
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/desks", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request(`/desks/${LANE}/status`)).status).toBe(401);
    expect(
      (
        await app.request(`/desks/${LANE}/status`, {
          headers: { "x-desk-agent-key": "agent-key-0123456789abcdefghij" },
        })
      ).status,
    ).toBe(503);
  });
});

describe("POST /webhooks/dynamic through the server", () => {
  it("verifies the HMAC over the RAW bytes and caps the body at 64 KB", async () => {
    const db = memDb();
    const secret = "whsec_server_test_0123456789";
    const app = createHttpApp({
      health: () => healthView({ db, clock: fixedClock(T0), staleTickMs: 1, lockStaleMs: 1 }),
      webhook: createDynamicWebhookHandler({
        db,
        secret,
        environmentId: undefined,
        rsaPrivateKeyPem: () => "",
        vault: createVault({ kekB64: Buffer.alloc(32, 1).toString("base64"), kekId: "k1" }),
        clock: fixedClock(T0),
        logger: silentLogger,
      }),
      desks: null,
      logger: silentLogger,
    });
    // Whitespace matters: the HMAC is over the exact bytes, never a re-serialisation.
    const raw = '{ "eventId": "evt-1", "eventName": "ping", "data": {} }';
    const ok = await app.request("/webhooks/dynamic", {
      method: "POST",
      body: raw,
      headers: { "x-dynamic-signature-256": `sha256=${signDynamicPayload(raw, secret)}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ignored: "ping" });
    const bad = await app.request("/webhooks/dynamic", {
      method: "POST",
      body: raw.replace(" ", ""),
      headers: { "x-dynamic-signature-256": signDynamicPayload(raw, secret) },
    });
    expect(bad.status).toBe(401);
    const big = "x".repeat(64 * 1024 + 10);
    const tooBig = await app.request("/webhooks/dynamic", {
      method: "POST",
      body: big,
      headers: {
        "content-length": String(big.length),
        "x-dynamic-signature-256": signDynamicPayload(big, secret),
      },
    });
    expect(tooBig.status).toBe(413);
  });

  it("serves over a real socket and closes", async () => {
    const app = createHttpApp({
      health: () => ({
        ok: true,
        lastTickAgeMs: 0,
        lockHeld: true,
        pendingExecutions: 0,
        nowMs: 1,
      }),
      webhook: null,
      desks: null,
      logger: silentLogger,
    });
    const handle = await startHttpServer(app, { port: 0, host: "127.0.0.1" });
    try {
      const r = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(await r.json()).toMatchObject({ ok: true });
    } finally {
      await handle.close();
    }
  });
});

describe("scripts/gen-rsa", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes a 0600 private key, a public key, and refuses to overwrite without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-rsa-"));
    dirs.push(dir);
    const out = join(dir, "k.pem");
    const { publicKeyPem, publicPath } = writeRsaKeyPair(out, false, 2048);
    expect(publicPath).toBe(publicPathFor(out));
    expect(readFileSync(out, "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(() => writeRsaKeyPair(out, false, 2048)).toThrow(/refusing to overwrite/);
    expect(existsSync(publicPath)).toBe(true);
  });

  it("defaults to RSA-4096", () => {
    const { publicKeyPem } = generateRsaKeyPair();
    const der = Buffer.from(publicKeyPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    expect(der.length).toBeGreaterThan(540); // a 4096-bit SPKI is ~550 bytes (2048-bit is ~294)
  }, 30_000);
});

describe("startHttpServer", () => {
  it("rejects when the port is already taken", async () => {
    const app = createHttpApp({
      health: () => ({
        ok: true,
        lastTickAgeMs: 0,
        lockHeld: true,
        pendingExecutions: 0,
        nowMs: 1,
      }),
      webhook: null,
      desks: null,
      logger: silentLogger,
    });
    const first = await startHttpServer(app, { port: 0, host: "127.0.0.1" });
    try {
      await expect(startHttpServer(app, { port: first.port, host: "127.0.0.1" })).rejects.toThrow(
        /EADDRINUSE/,
      );
    } finally {
      await first.close();
    }
  });
});
