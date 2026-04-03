/**
 * config.js
 *
 * Single source of truth for all tuneable constants.
 * Override any value via environment variables where noted.
 */

/** Maximum number of Gmail messages fetched per run. */
const _maxMsg = parseInt(process.env.MAX_MESSAGES ?? "10", 10);
export const MAX_MESSAGES = Number.isFinite(_maxMsg) && _maxMsg > 0 ? _maxMsg : 10;

/** Minimum Levenshtein similarity (0–1) to accept a physician name match. */
const _simThr = parseFloat(process.env.SIMILARITY_THRESHOLD ?? "0.6");
export const SIMILARITY_THRESHOLD = Number.isFinite(_simThr) && _simThr >= 0 && _simThr <= 1 ? _simThr : 0.6;

/** Maximum characters of compact row JSON sent to Claude. */
export const MAX_ROW_JSON_CHARS = 8_000;

/** Max tokens in Claude's response (name + date + score fits easily in 512). */
export const CLAUDE_MAX_TOKENS = 512;

/** Maximum rows fetched from Supabase per table query. */
export const SUPABASE_ROW_LIMIT = 1_000;

/** Milliseconds before a Telegram API call is aborted. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * Whether to send error/alert reply emails back to the original sender.
 * Set to false to suppress all alert replies (e.g. during testing).
 * Resume by setting back to true.
 */
export const SEND_ERROR_REPLIES = true;

/** Gmail senders to skip entirely (comma-separated in env, or hardcoded default). */
export const SKIP_SENDERS = new Set(
  (process.env.SKIP_SENDERS ?? "sakhonmso@gmail.com,p4pskh@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Relay senders: messages FROM these addresses are not skipped outright.
 * Instead the pipeline searches the thread for an xlsx from the original sender.
 * Must be a subset of SKIP_SENDERS (or independently listed).
 */
export const THREAD_RELAY_SENDERS = new Set(
  (process.env.THREAD_RELAY_SENDERS ?? "sakhonmso@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
