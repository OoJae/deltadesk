/**
 * Telegram: outbound notifications, approval buttons, and an inbound callback listener.
 *
 * SAFETY PROPERTIES
 * - Never throws into the control loop: every network failure (throw or non-2xx) is caught, logged
 *   with the bot token redacted, and the promise resolves.
 * - The bot token never reaches a log line, even inside upstream error text.
 * - Unconfigured → a no-op notifier that logs the would-send text at debug and never touches fetch.
 * - Inbound: only callbacks from the configured chat count, only "approve:<ULID>" / "deny:<ULID>"
 *   are understood, and an answer applies only to a pending, unexpired approval (db-enforced).
 *   Telegram can approve or deny a decision; it has no path to anything else. A listener without
 *   `respond` (the watchdog's) leaves approval callbacks unanswered instead of calling them late.
 * - One getUpdates poller per bot: Telegram hands each update to whoever polls, so the agent and
 *   the watchdog must use separate bots (config refuses a shared token).
 */

import type { ApprovalChannel, DeskLogger, DeskNotification, Notifier } from "../types.js";
import { approvalKeyboard, parseApprovalCallback, renderNotification } from "./render.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramConfig {
  botToken: string | undefined;
  chatId: string | undefined;
  explorerUrl: string;
}

export interface TelegramApi {
  sendMessage(text: string, opts?: { replyMarkup?: unknown }): Promise<boolean>;
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  answerCallback(callbackQueryId: string, text: string): Promise<void>;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from?: { id: number; username?: string };
    data?: string;
    message?: { chat?: { id: number | string } };
  };
  message?: {
    text?: string;
    chat?: { id: number | string };
    from?: { id: number; username?: string };
  };
}

/** The raw Bot API client; every method swallows failures (logs, returns a neutral value). */
export function createTelegramApi(
  token: string,
  chatId: string,
  logger: Pick<DeskLogger, "warn" | "debug">,
  fetchImpl: typeof fetch = fetch,
): TelegramApi {
  const base = `${TELEGRAM_API_BASE}/bot${token}`;
  const redact = (s: string): string => s.split(token).join("[redacted]");

  async function call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    try {
      const res = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn(
          { method, status: res.status, body: redact(text).slice(0, 500) },
          "telegram call failed (non-2xx)",
        );
        return null;
      }
      return (await res.json()) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ method, error: redact(message) }, "telegram call threw; continuing");
      return null;
    }
  }

  return {
    async sendMessage(text, opts = {}) {
      const r = await call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(opts.replyMarkup === undefined ? {} : { reply_markup: opts.replyMarkup }),
      });
      return r !== null;
    },
    async getUpdates(offset, timeoutSec) {
      const r = (await call(
        "getUpdates",
        { offset, timeout: timeoutSec, allowed_updates: ["callback_query", "message"] },
        (timeoutSec + 10) * 1000,
      )) as { ok?: boolean; result?: TelegramUpdate[] } | null;
      return r?.ok === true && Array.isArray(r.result) ? r.result : [];
    },
    async answerCallback(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },
  };
}

export function createTelegramNotifier(
  cfg: TelegramConfig,
  logger: Pick<DeskLogger, "warn" | "debug">,
  fetchImpl: typeof fetch = fetch,
): Notifier {
  const render = (n: DeskNotification) => renderNotification(n, { explorerUrl: cfg.explorerUrl });
  if (cfg.botToken === undefined || cfg.chatId === undefined) {
    return {
      async notify(n) {
        logger.debug(
          { kind: n.kind, decisionId: n.decisionId, text: render(n) },
          "telegram not configured; would send",
        );
      },
    };
  }
  const api = createTelegramApi(cfg.botToken, cfg.chatId, logger, fetchImpl);
  return {
    async notify(n) {
      const replyMarkup =
        n.approval === undefined ? undefined : approvalKeyboard(n.approval.decisionId);
      const ok = await api.sendMessage(render(n), { replyMarkup });
      if (ok)
        logger.debug({ kind: n.kind, decisionId: n.decisionId }, "telegram notification sent");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Inbound: approval buttons (and, for the watchdog, commands)

export interface TelegramListenerDeps {
  api: TelegramApi;
  chatId: string;
  /**
   * Approve/deny a pending decision (db.respondApproval). Returns whether it applied. Absent: this
   * listener takes no approvals (the watchdog), so approval callbacks are ignored.
   */
  respond?: (
    decisionId: string,
    approve: boolean,
    channel: ApprovalChannel,
    by: string | null,
  ) => boolean;
  /** Optional plain-text command handler (the watchdog's "/pause <lane>"). */
  onCommand?: (text: string, by: string | null) => Promise<string | null>;
  logger: Pick<DeskLogger, "warn" | "debug" | "info">;
  pollTimeoutSec?: number;
}

export interface TelegramListener {
  /** Process one getUpdates batch; returns the next offset. */
  pollOnce(offset: number): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createTelegramListener(deps: TelegramListenerDeps): TelegramListener {
  const timeoutSec = deps.pollTimeoutSec ?? 25;
  let stopping = false;
  let loop: Promise<void> | null = null;
  const fromChat = (id: number | string | undefined) =>
    id !== undefined && String(id) === deps.chatId;

  async function pollOnce(offset: number): Promise<number> {
    const updates = await deps.api.getUpdates(offset, timeoutSec);
    let next = offset;
    for (const u of updates) {
      next = Math.max(next, u.update_id + 1);
      const cb = u.callback_query;
      if (cb !== undefined) {
        const by = cb.from?.username ?? (cb.from?.id === undefined ? null : String(cb.from.id));
        if (!fromChat(cb.message?.chat?.id)) {
          deps.logger.warn(
            { updateId: u.update_id },
            "telegram callback from an unknown chat; ignored",
          );
          continue;
        }
        const parsed = parseApprovalCallback(cb.data ?? "");
        if (parsed === null) {
          await deps.api.answerCallback(cb.id, "Unknown action");
          continue;
        }
        if (deps.respond === undefined) {
          deps.logger.warn(
            { updateId: u.update_id, decisionId: parsed.decisionId },
            "approval callback on a bot that takes no approvals; ignored (is the agent's bot shared?)",
          );
          continue;
        }
        const applied = deps.respond(parsed.decisionId, parsed.approve, "telegram", by);
        await deps.api.answerCallback(
          cb.id,
          applied
            ? parsed.approve
              ? "Approved"
              : "Denied"
            : "Too late: this decision is no longer pending",
        );
        deps.logger.info(
          { decisionId: parsed.decisionId, approve: parsed.approve, applied, by },
          "telegram approval answer",
        );
        continue;
      }
      const msg = u.message;
      if (msg?.text !== undefined && deps.onCommand !== undefined && fromChat(msg.chat?.id)) {
        const by = msg.from?.username ?? (msg.from?.id === undefined ? null : String(msg.from.id));
        const reply = await deps.onCommand(msg.text, by);
        if (reply !== null) await deps.api.sendMessage(reply);
      }
    }
    return next;
  }

  return {
    pollOnce,
    start() {
      if (loop !== null) return;
      loop = (async () => {
        let offset = 0;
        while (!stopping) {
          try {
            offset = await pollOnce(offset);
          } catch (err) {
            deps.logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "telegram poll failed",
            );
            await new Promise((r) => setTimeout(r, 5_000));
          }
        }
      })();
    },
    async stop() {
      stopping = true;
      await loop;
    },
  };
}
