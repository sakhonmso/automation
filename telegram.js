/**
 * telegram.js
 *
 * Sends a message to a Telegram chat via the Bot API.
 * Requires in .env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat/group/channel ID
 */

import "dotenv/config";

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

  const body = {
    chat_id : chatId,
    text    : text.slice(0, 4096),   // Telegram hard limit
    ...(parseMode ? { parse_mode: parseMode } : {}),
  };

  const res = await fetch(`${BASE}/bot${token}/sendMessage`, {
    method  : "POST",
    headers : { "Content-Type": "application/json" },
    body    : JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram API error: ${json.description ?? JSON.stringify(json)}`);
  }
  return json;
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

  return [
    `📋 *P4P Workload Report*`,
    ``,
    `👤 Name     : ${result.name}`,
    `🔗 Matched  : ${result.matchedName ?? "—"}${sim}`,
    `📅 Date     : ${result.date}`,
    `🏅 Score    : ${result.score}`,
    `💾 ${saved}`,
    ``,
    `📎 File: ${filename}`,
  ].join("\n");
}

/**
 * Format an error as a Telegram message.
 */
export function formatErrorMessage(error, filename) {
  return [
    `❌ *P4P Processing Error*`,
    ``,
    `📎 File : ${filename}`,
    `💬 Error: ${error}`,
  ].join("\n");
}