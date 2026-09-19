/**
 * pino logger with enforced redaction.
 *
 * Every field name that can carry a secret (private keys, Dynamic key shares and wallet API keys,
 * the vault KEK/DEK, webhook secrets, RSA keys, bot tokens, bearer headers, key-bearing RPC URLs) is
 * censored at the top level and up to three levels deep, including inside `config`, `err` and
 * request `headers`. test/unit/log.test.ts enforces the list: adding a secret-bearing field
 * anywhere means adding its name here.
 */

import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import type { DeskLogger } from "./types.js";

/** Field names whose VALUES are secret wherever they appear. */
export const SECRET_KEYS = [
  "privateKey",
  "localPrivateKey",
  "agentPrivateKey",
  "guardianPrivateKey",
  "keyShare",
  "keyShares",
  "externalServerKeyShares",
  "decryptedDelegatedShare",
  "walletApiKey",
  "decryptedWalletApiKey",
  "apiKey",
  "agentApiKey",
  "kek",
  "kekB64",
  "dek",
  "plaintext",
  "secret",
  "webhookSecret",
  "rsaPrivateKeyPem",
  "privateKeyPem",
  "botToken",
  "token",
  "accessToken",
  "jwt",
  "authorization",
  "cookie",
  "password",
  "mnemonic",
  "rpcUrl",
  "rpcFallbackUrl",
] as const;

/** Header names (bracket notation: they contain dashes). */
const SECRET_HEADERS = [
  "authorization",
  "cookie",
  "x-deltadesk-key",
  "x-api-key",
  "x-desk-agent-key",
] as const;

export const REDACTED = "[redacted]";

function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const k of SECRET_KEYS) {
    paths.push(k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`);
  }
  for (const h of SECRET_HEADERS) {
    paths.push(`headers["${h}"]`, `*.headers["${h}"]`, `*.*.headers["${h}"]`);
  }
  return paths;
}

export const REDACT_PATHS: readonly string[] = buildRedactPaths();

export interface CreateLoggerOptions {
  level?: LoggerOptions["level"];
  service?: string;
  /** Pretty-print to a TTY (dev). Ignored when a destination is given. */
  pretty?: boolean;
  /** Custom sink (tests capture output here). */
  destination?: DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger & DeskLogger {
  const options: LoggerOptions = {
    level: opts.level ?? "info",
    base: { service: opts.service ?? "desk-agent" },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
  };
  if (opts.destination !== undefined) {
    return pino(options, opts.destination) as Logger & DeskLogger;
  }
  if (opts.pretty === true) {
    return pino({
      ...options,
      transport: { target: "pino-pretty", options: { colorize: true } },
    }) as Logger & DeskLogger;
  }
  return pino(options) as Logger & DeskLogger;
}

/** A logger that drops everything (tests, scripts that want silence). */
export const silentLogger: DeskLogger = {
  child: () => silentLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
