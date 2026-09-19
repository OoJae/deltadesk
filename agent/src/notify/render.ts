/**
 * Render a DeskNotification as Telegram HTML. Pure: no I/O, no secrets. User- and model-influenced
 * text (titles, lines, reasons) is HTML-escaped; parse mode HTML avoids MarkdownV2 escaping traps.
 */

import type { DeskNotification, Hex, NotifySeverity } from "../types.js";

/** Escape the characters Telegram's HTML parse mode cares about (ampersand first). */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function txUrl(explorerUrl: string, txHash: Hex): string {
  return `${explorerUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

export function addressUrl(explorerUrl: string, address: string): string {
  return `${explorerUrl.replace(/\/$/, "")}/address/${address}`;
}

const SEVERITY_MARK: Readonly<Record<NotifySeverity, string>> = {
  info: "ℹ️",
  warn: "⚠️",
  critical: "🚨",
};

export interface RenderOptions {
  explorerUrl: string;
}

export function renderNotification(n: DeskNotification, opts: RenderOptions): string {
  const lane = n.lane === null ? "" : ` lane ${n.lane}`;
  const lines: string[] = [
    `${SEVERITY_MARK[n.severity]} <b>DeltaDesk${lane}</b> · ${escapeHtml(n.title)}`,
  ];
  for (const line of n.lines ?? []) lines.push(escapeHtml(line));
  if (n.approval !== undefined) {
    lines.push(`Approve within ${n.approval.windowSec}s, or it is declined.`);
  }
  if (n.txHash !== undefined) lines.push(`tx: ${txUrl(opts.explorerUrl, n.txHash)}`);
  if (n.decisionId !== undefined) lines.push(`decision <code>${escapeHtml(n.decisionId)}</code>`);
  if (n.dryRun === true) lines.push("DRY_RUN: no transaction sent");
  return lines.join("\n");
}

/** Inline keyboard for an approval request; callback data is "approve:<id>" / "deny:<id>" (≤ 64 bytes). */
export function approvalKeyboard(decisionId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `approve:${decisionId}` },
        { text: "Deny", callback_data: `deny:${decisionId}` },
      ],
    ],
  };
}

/** Parse approval callback data; anything else is null. */
export function parseApprovalCallback(
  data: string,
): { decisionId: string; approve: boolean } | null {
  const m = /^(approve|deny):([0-9A-HJKMNP-TV-Z]{26})$/.exec(data);
  if (m === null) return null;
  return { decisionId: m[2] as string, approve: m[1] === "approve" };
}
