import { describe, expect, it } from "vitest";
import {
  approvalKeyboard,
  escapeHtml,
  parseApprovalCallback,
  renderNotification,
  txUrl,
} from "../../src/notify/render.js";
import {
  createTelegramApi,
  createTelegramListener,
  createTelegramNotifier,
  type TelegramApi,
  type TelegramUpdate,
} from "../../src/notify/telegram.js";
import type { DeskNotification } from "../../src/types.js";
import { recordingLogger } from "../helpers/fakes.js";

const TOKEN = "123456:SECRET-bot-token";
const ULID = "01K5HZ3N8QW0000000000000AA";
const note = (partial: Partial<DeskNotification> = {}): DeskNotification => ({
  kind: "decision",
  severity: "info",
  lane: "A",
  laneAddress: null,
  title: "rerange <proposed> & waiting",
  ...partial,
});

describe("render", () => {
  it("escapes model- and user-influenced text", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    const text = renderNotification(
      note({
        lines: ["gap <5 bp"],
        txHash: `0x${"ab".repeat(32)}`,
        dryRun: true,
        decisionId: ULID,
      }),
      {
        explorerUrl: "https://explorer.test/",
      },
    );
    expect(text).toContain("rerange &lt;proposed&gt; &amp; waiting");
    expect(text).toContain("gap &lt;5 bp");
    expect(text).toContain(`https://explorer.test/tx/0x${"ab".repeat(32)}`);
    expect(text).toContain("DRY_RUN");
    expect(txUrl("https://e.test", "0x01")).toBe("https://e.test/tx/0x01");
  });

  it("builds and parses approval callbacks, rejecting anything else", () => {
    const kb = approvalKeyboard(ULID);
    const [approve, deny] = kb.inline_keyboard[0] ?? [];
    expect(parseApprovalCallback(approve?.callback_data ?? "")).toEqual({
      decisionId: ULID,
      approve: true,
    });
    expect(parseApprovalCallback(deny?.callback_data ?? "")).toEqual({
      decisionId: ULID,
      approve: false,
    });
    expect(Buffer.byteLength(approve?.callback_data ?? "")).toBeLessThanOrEqual(64);
    for (const bad of [
      "approve:",
      `unpause:${ULID}`,
      "approve:../../etc",
      `approve:${ULID}x`,
      "withdraw:all",
    ]) {
      expect(parseApprovalCallback(bad), bad).toBeNull();
    }
  });
});

describe("notifier", () => {
  it("unconfigured: never touches the network", async () => {
    let called = false;
    const logger = recordingLogger();
    const n = createTelegramNotifier(
      { botToken: undefined, chatId: undefined, explorerUrl: "https://e.test" },
      logger,
      (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    );
    await n.notify(note());
    expect(called).toBe(false);
    expect(logger.records.some((r) => r.msg?.includes("would send"))).toBe(true);
  });

  it("posts HTML with approve/deny buttons for approval requests", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const n = createTelegramNotifier(
      { botToken: TOKEN, chatId: "42", explorerUrl: "https://e.test" },
      recordingLogger(),
      fetchImpl,
    );
    await n.notify(
      note({ kind: "approval-request", approval: { decisionId: ULID, windowSec: 120 } }),
    );
    expect(urls[0]).toContain("/sendMessage");
    expect(bodies[0]).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
    expect(JSON.stringify(bodies[0]?.reply_markup)).toContain(`approve:${ULID}`);
  });

  it("never throws and never logs the token, on non-2xx or on a throw", async () => {
    const logger = recordingLogger();
    const non2xx = createTelegramNotifier(
      { botToken: TOKEN, chatId: "42", explorerUrl: "https://e.test" },
      logger,
      (async () =>
        new Response(`bad request for bot${TOKEN}`, { status: 400 })) as unknown as typeof fetch,
    );
    await expect(non2xx.notify(note())).resolves.toBeUndefined();
    const throwing = createTelegramNotifier(
      { botToken: TOKEN, chatId: "42", explorerUrl: "https://e.test" },
      logger,
      (async () => {
        throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
      }) as unknown as typeof fetch,
    );
    await expect(throwing.notify(note())).resolves.toBeUndefined();
    const logged = JSON.stringify(logger.records);
    expect(logged).not.toContain("SECRET-bot-token");
    expect(logged).toContain("[redacted]");
  });
});

describe("listener", () => {
  function fakeApi(updates: TelegramUpdate[]) {
    const answers: string[] = [];
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (text) => {
        sent.push(text);
        return true;
      },
      getUpdates: async () => updates,
      answerCallback: async (_id, text) => {
        answers.push(text);
      },
    };
    return { api, answers, sent };
  }
  const cb = (id: number, data: string, chat: number | string = 42): TelegramUpdate => ({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: 7, username: "alice" },
      data,
      message: { chat: { id: chat } },
    },
  });

  it("applies approvals only from the configured chat and only for well-formed data", async () => {
    const responses: Array<[string, boolean, string, string | null]> = [];
    const { api, answers } = fakeApi([
      cb(10, `approve:${ULID}`),
      cb(11, `deny:${ULID}`, 666),
      cb(12, "unpause:lane"),
    ]);
    const listener = createTelegramListener({
      api,
      chatId: "42",
      respond: (id, approve, channel, by) => {
        responses.push([id, approve, channel, by]);
        return true;
      },
      logger: recordingLogger(),
    });
    expect(await listener.pollOnce(0)).toBe(13);
    expect(responses).toEqual([[ULID, true, "telegram", "alice"]]);
    expect(answers).toEqual(["Approved", "Unknown action"]);
  });

  it("says so when the decision is no longer pending", async () => {
    const { api, answers } = fakeApi([cb(1, `approve:${ULID}`)]);
    const listener = createTelegramListener({
      api,
      chatId: "42",
      respond: () => false,
      logger: recordingLogger(),
    });
    await listener.pollOnce(0);
    expect(answers[0]).toContain("no longer pending");
  });

  it("routes chat commands (watchdog pause) only from the configured chat", async () => {
    const { api, sent } = fakeApi([
      { update_id: 1, message: { text: "/pause A", chat: { id: 42 }, from: { id: 7 } } },
      { update_id: 2, message: { text: "/pause A", chat: { id: 99 }, from: { id: 8 } } },
    ]);
    const commands: string[] = [];
    const listener = createTelegramListener({
      api,
      chatId: "42",
      respond: () => false,
      onCommand: async (text) => {
        commands.push(text);
        return "pausing lane A";
      },
      logger: recordingLogger(),
    });
    await listener.pollOnce(0);
    expect(commands).toEqual(["/pause A"]);
    expect(sent).toEqual(["pausing lane A"]);
  });

  it("a listener without `respond` (the watchdog's) ignores approval callbacks: no late 'Too late'", async () => {
    const { api, answers } = fakeApi([cb(1, `approve:${ULID}`)]);
    const logger = recordingLogger();
    const listener = createTelegramListener({ api, chatId: "42", logger });
    expect(await listener.pollOnce(0)).toBe(2);
    expect(answers).toEqual([]);
    expect(JSON.stringify(logger.records)).toContain("takes no approvals");
  });

  it("the raw API returns [] on a failed getUpdates", async () => {
    const api = createTelegramApi(
      TOKEN,
      "42",
      recordingLogger(),
      (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
    );
    expect(await api.getUpdates(0, 0)).toEqual([]);
  });
});
