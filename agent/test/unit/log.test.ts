/**
 * pino redaction is enforced: secret-bearing field names are censored at every depth the agent
 * logs them, and non-secret fields survive.
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createLogger, REDACTED, SECRET_KEYS } from "../../src/log.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ destination: stream, level: "debug" }), lines };
}

describe("log redaction", () => {
  it("censors every secret key at depths 0 to 3", () => {
    const { logger, lines } = capture();
    for (const key of SECRET_KEYS) {
      const v = `secret-${key}-value`;
      logger.info(
        { [key]: v, a: { [key]: v }, a2: { b: { [key]: v } }, a3: { b: { c: { [key]: v } } } },
        "probe",
      );
    }
    const out = lines.join("");
    for (const key of SECRET_KEYS) expect(out, key).not.toContain(`secret-${key}-value`);
    expect(out).toContain(REDACTED);
  });

  it("censors auth headers, including dashed names", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        headers: {
          authorization: "Bearer jwt-secret",
          "x-deltadesk-key": "premium-secret",
          "x-dynamic-signature-256": "sha256=ok",
        },
        req: { headers: { authorization: "Bearer jwt-secret-2", cookie: "sid=cookie-secret" } },
      },
      "request",
    );
    const out = lines.join("");
    for (const s of ["jwt-secret", "premium-secret", "jwt-secret-2", "cookie-secret"])
      expect(out).not.toContain(s);
    expect(out).toContain("sha256=ok"); // a signature is not a secret
  });

  it("logging the whole AppConfig leaks nothing", () => {
    const { logger, lines } = capture();
    const cfg = loadConfig({
      RH_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/ALCHEMYSECRET",
      DYNAMIC_API_KEY: "dyn_secret",
      DYNAMIC_WEBHOOK_SECRET: "whsec_0123456789abcdef_secret",
      DYNAMIC_RSA_PRIVATE_KEY_PEM:
        "-----BEGIN PRIVATE KEY-----\\nRSASECRET\\n-----END PRIVATE KEY-----",
      DESK_VAULT_KEK_B64: Buffer.alloc(32, 9).toString("base64"),
      BANKR_LLM_API_KEY: "bk_secret",
      TELEGRAM_BOT_TOKEN: "123:tgsecret",
      DELTADESK_API_KEY: "premium_secret",
      DESK_AGENT_API_KEY: "agent-key-secret-0123456789",
    });
    logger.info({ config: cfg }, "config");
    const out = lines.join("");
    for (const s of [
      "ALCHEMYSECRET",
      "dyn_secret",
      "whsec_0123456789abcdef_secret",
      "RSASECRET",
      Buffer.alloc(32, 9).toString("base64"),
      "bk_secret",
      "tgsecret",
      "premium_secret",
      "agent-key-secret-0123456789",
    ]) {
      expect(out, s).not.toContain(s);
    }
    expect(out).toContain('"chainId":4663');
  });

  it("keeps ordinary fields", () => {
    const { logger, lines } = capture();
    logger.info({ decisionId: "01K5", lane: "A", txHash: "0xabc" }, "ok");
    expect(lines.join("")).toContain('"txHash":"0xabc"');
  });
});
