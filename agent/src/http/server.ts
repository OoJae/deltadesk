/**
 * The desk-agent HTTP server (Hono on @hono/node-server):
 *
 *   GET  /health               last tick age, daemon lock, pending executions (public: no secrets;
 *                              the watchdog's dead-man switch reads it). Always 200; `ok` says it.
 *   POST /webhooks/dynamic     Dynamic delegated access (http/dynamic-webhook.ts), raw body ≤ 64 KB.
 *   /desks…, /delegations/:operator, /operator-address
 *                              the web API (http/desks.ts).
 *   GET  /lanes/:lane/actions/:decisionId
 *                              the watchdog's cross-check (http/watchdog-api.ts): x-watchdog-key
 *                              (WATCHDOG_AGENT_KEY) only; 503 while the key is not configured.
 *
 * Unknown routes are 404 JSON; unexpected errors are 500 JSON without stack traces.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
  Address,
  Clock,
  DeskDb,
  DeskLogger,
  HealthView,
  HttpServerHandle,
  WebhookHandler,
} from "../types.js";
import { createDeskRoutes, type DeskApiDeps } from "./desks.js";
import { MAX_WEBHOOK_BYTES } from "./dynamic-webhook.js";
import { createWatchdogRoutes, type WatchdogApiDeps } from "./watchdog-api.js";

export type { HealthView, HttpServerHandle } from "../types.js";

export interface HealthDeps {
  db: Pick<DeskDb, "lockStatus" | "listDesks" | "lastTick" | "pendingExecutionsCount">;
  clock: Clock;
  /** Lanes from config that may not be registered desks (their ticks still count). */
  extraLanes?: readonly Address[];
  /** The newest tick older than this makes `ok` false. */
  staleTickMs: number;
  lockStaleMs: number;
}

export function healthView(deps: HealthDeps): HealthView {
  const now = deps.clock.now();
  const lock = deps.db.lockStatus();
  const lockHeld = lock !== null && now - lock.heartbeatMs <= deps.lockStaleMs;
  const lanes = new Set<string>([
    ...deps.db.listDesks().map((d) => d.laneAddress.toLowerCase()),
    ...(deps.extraLanes ?? []).map((a) => a.toLowerCase()),
  ]);
  let newest: number | null = null;
  for (const lane of lanes) {
    const t = deps.db.lastTick(lane as Address);
    if (t !== null && (newest === null || t.atMs > newest)) newest = t.atMs;
  }
  const lastTickAgeMs = newest === null ? null : now - newest;
  return {
    ok: lockHeld && lastTickAgeMs !== null && lastTickAgeMs <= deps.staleTickMs,
    lastTickAgeMs,
    lockHeld,
    pendingExecutions: deps.db.pendingExecutionsCount(),
    nowMs: now,
  };
}

export interface HttpAppDeps {
  health: () => HealthView;
  webhook: WebhookHandler | null;
  desks: DeskApiDeps | null;
  /** The watchdog's cross-check route; absent (or without a key): 503. */
  watchdog?: WatchdogApiDeps | undefined;
  logger: DeskLogger;
}

export function createHttpApp(deps: HttpAppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json(deps.health()));

  app.post(
    "/webhooks/dynamic",
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
    async (c) => {
      if (deps.webhook === null) return c.json({ error: "webhook not configured" }, 503);
      const raw = new Uint8Array(await c.req.arrayBuffer());
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const r = await deps.webhook.handle(raw, headers);
      return c.json(r.body, r.status);
    },
  );

  if (deps.desks !== null) {
    app.route("/", createDeskRoutes(deps.desks));
  } else {
    app.all("/desks/*", (c) => c.json({ error: "desk API not configured" }, 503));
    app.post("/desks", (c) => c.json({ error: "desk API not configured" }, 503));
    app.all("/delegations/*", (c) => c.json({ error: "desk API not configured" }, 503));
  }

  if (deps.watchdog !== undefined) {
    app.route("/", createWatchdogRoutes(deps.watchdog));
  } else {
    app.all("/lanes/*", (c) =>
      c.json({ error: "watchdog API not configured (WATCHDOG_AGENT_KEY)" }, 503),
    );
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    deps.logger.error({ error: err instanceof Error ? err.message : String(err) }, "http error");
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}

export function startHttpServer(
  app: Hono,
  opts: { port: number; host: string },
): Promise<HttpServerHandle> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
      server.off("error", reject);
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
    // A taken port must fail startup loudly, not hang it.
    server.once("error", reject);
  });
}
