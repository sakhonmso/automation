/**
 * telegram.js
 *
 * Sends a message to a Telegram chat via the Bot API.
 * Requires in .env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat/group/channel ID
 */

import { TELEGRAM_TIMEOUT_MS } from "./config.js";

const BASE = "https://api.telegram.org";

function getConfig() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  }
  return { token, chatId };
}

/**
 * Send a plain-text or Markdown message to Telegram.
 *
 * @param {string} text         Message text (supports MarkdownV2)
 * @param {object} [opts]
 * @param {string} [opts.parseMode]  "MarkdownV2" | "HTML" | undefined
 */
export async function sendTelegram(text, { parseMode } = {}) {
  const { token, chatId } = getConfig();

  // Guard against null/undefined — avoids TypeError on .length and .slice
  const safeText = String(text ?? "");

  if (safeText.length > 4096) {
    console.warn(`Telegram message truncated: ${safeText.length} → 4096 chars`);
  }
  const body = {
    chat_id : chatId,
    text    : safeText.slice(0, 4096),   // Telegram hard limit
    ...(parseMode ? { parse_mode: parseMode } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${BASE}/bot${token}/sendMessage`, {
      method  : "POST",
      headers : { "Content-Type": "application/json" },
      body    : JSON.stringify(body),
      signal  : controller.signal,
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`Telegram API error: ${json.description ?? JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format a result object as a readable Telegram message.
 *
 * @param {object} result  { name, date, score, matchedName, similarity, saved }
 * @param {string} filename  Source xlsx filename
 * @returns {string}
 */
export function formatResultMessage(result, filename) {
  const sim  = result.similarity != null
    ? ` (${(result.similarity * 100).toFixed(0)}% match)`
    : "";
  const saved = result.saved ? "✅ Score saved to DB" : "⚠️ Score NOT saved";

  // Plain text mode (no parseMode) — do NOT use *markdown* as it renders literally
  return [
    `📋 P4P Workload Report`,
    ``,
    `👤 Name     : ${result.name ?? "—"}`,
    `🔗 Matched  : ${result.matchedName ?? "—"}${sim}`,
    `📅 Date     : ${result.date ?? "—"}`,
    `🏅 Score    : ${result.score ?? "—"}`,
    `💾 ${saved}`,
    ``,
    `📎 File: ${filename ?? "(unknown)"}`,
  ].join("\n");
}

/**
 * Format an error as a Telegram message.
 */
export function formatErrorMessage(error, filename) {
  return [
    `❌ P4P Processing Error`,
    ``,
    `📎 File : ${filename ?? "(unknown)"}`,
    `💬 Error: ${error ?? "unknown error"}`,
  ].join("\n");
}
