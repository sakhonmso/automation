/**
 * config.js
 *
 * Single source of truth for all tuneable constants.
 * Override any value via environment variables where noted.
 */

/** Maximum number of Gmail messages fetched per run. */
export const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES ?? "10", 10);

/** Minimum Levenshtein similarity (0–1) to accept a physician name match. */
export const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD ?? "0.6");

/** Maximum characters of compact row JSON sent to Claude. */
export const MAX_ROW_JSON_CHARS = 8_000;

/** Max tokens in Claude's response (name + date + score fits easily in 512). */
export const CLAUDE_MAX_TOKENS = 512;

/** Maximum rows fetched from Supabase per table query. */
export const SUPABASE_ROW_LIMIT = 1_000;

/** Milliseconds before a Telegram API call is aborted. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/** Gmail senders to skip entirely (comma-separated in env, or hardcoded default). */
export const SKIP_SENDERS = new Set(
  (process.env.SKIP_SENDERS ?? "sakhonmso@gmail.com,p4pskh@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
