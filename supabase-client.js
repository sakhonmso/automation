/**
 * supabase-client.js
 *
 * Exports:
 *   matchName(name, date)       — fuzzy-match physician name in Supabase table,
 *                                 returns { matchedName, index, similarity } or null
 *   saveScore(date, index, score) — write score (float8) to the matched row
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ── Singleton client ───────────────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
  _supabase = createClient(url, key);
  return _supabase;
}

// ── Text normaliser ────────────────────────────────────────────────────────
const normalise = (s) =>
  String(s ?? "")
    .replace(/[\s\u00a0\u200b\u202f\u2009\u3000\ufeff]+/g, " ")
    .trim()
    .toLowerCase();

// ── Levenshtein distance ───────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Similarity score 0–1 between two name strings.
 * 1.0 = exact match, 0 = completely different.
 * Also awards partial credit when all tokens of the shorter name appear in the longer.
 */
function similarity(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (na === nb) return 1.0;

  // Token overlap bonus — handles missing last name
  const tokA = na.split(" ").filter(Boolean);
  const tokB = nb.split(" ").filter(Boolean);
  const shorter = tokA.length <= tokB.length ? tokA : tokB;
  const longer  = tokA.length <= tokB.length ? tokB : tokA;
  const allMatch = shorter.every((t) => longer.includes(t));
  if (allMatch && shorter.length > 0) return 0.9;

  // Levenshtein-based similarity
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ── Exports ────────────────────────────────────────────────────────────────

/**
 * Fuzzy-match a physician name against all rows in the date table.
 * Returns the best match above the similarity threshold, or null.
 *
 * @param {string} name   Physician name from Claude, e.g. "สมชาย ใจดี"
 * @param {string} date   Table name, e.g. "2569_02"
 * @param {number} [threshold=0.6]  Minimum similarity to accept (0–1)
 * @returns {Promise<{ matchedName: string, index: number|string, similarity: number } | null>}
 */
export async function matchName(name, date, threshold = 0.6) {
  if (!date || date.startsWith("0000") || date.endsWith("_00")) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(date)
    .select("index, firstname, lastname");

  if (error) throw new Error(`Supabase query error on table "${date}": ${error.message}`);
  if (!data || data.length === 0) return null;

  let best = null;

  for (const row of data) {
    const fullName = `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim();
    const sim = similarity(name, fullName);
    if (sim > (best?.similarity ?? -1)) {
      best = { matchedName: fullName, index: row.index, similarity: sim };
    }
  }

  if (!best || best.similarity < threshold) return null;
  return best;
}

/**
 * Update the score column for a specific row identified by its primary key.
 *
 * @param {string}        date   Table name, e.g. "2569_02"
 * @param {number|string} index  Primary key value (column "index")
 * @param {number}        score  Score to save (float8)
 */
export async function saveScore(date, index, score) {
  if (!date || date.startsWith("0000") || date.endsWith("_00")) {
    throw new Error(`Cannot save score — invalid date key: "${date}"`);
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from(date)
    .update({ score })
    .eq("index", index);

  if (error) throw new Error(`Supabase update error on table "${date}": ${error.message}`);
}