/**
 * supabase-client.js
 *
 * Exports:
 *   matchName(name, date)       — fuzzy-match physician name in Supabase table,
 *                                 returns { matchedName, index, similarity } or null
 *   saveScore(date, index, score) — write score (float8) to the matched row
 */

import { createClient } from "@supabase/supabase-js";
import { SIMILARITY_THRESHOLD, SUPABASE_ROW_LIMIT } from "./config.js";

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
export const normalise = (s) =>
  String(s ?? "")
    .replace(/[\s\u00a0\u200b\u202f\u2009\u3000\ufeff]+/g, " ")
    .trim()
    .toLowerCase();

// ── Levenshtein distance ───────────────────────────────────────────────────
export function levenshtein(a, b) {
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
export function similarity(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (na === nb) return 1.0;

  // Token overlap bonus — handles missing last name
  const tokA = na.split(" ").filter(Boolean);
  const tokB = nb.split(" ").filter(Boolean);
  const shorter = tokA.length <= tokB.length ? tokA : tokB;
  const longer  = tokA.length <= tokB.length ? tokB : tokA;
  // A token matches if it's an exact hit OR a prefix of a longer token (min 3 chars).
  // This handles abbreviated lastnames in filenames, e.g. "หยิบ" → "หยิบทรงศิริกุล".
  const tokenMatches = (t) =>
    longer.includes(t) || (t.length >= 3 && longer.some((l) => l.startsWith(t)));
  const allMatch = shorter.every(tokenMatches);
  // Require ≥ 2 tokens to avoid a single first-name token matching any physician
  // with the same first name but a different last name (false-positive at 0.9).
  if (allMatch && shorter.length >= 2) return 0.9;

  // Levenshtein-based similarity
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ── Date validator ─────────────────────────────────────────────────────────
/**
 * Returns true only for well-formed date keys: BE year 2400–2700, month 01–12.
 * Catches "0000_01", "2569_13", "9999_99", etc.
 */
export function isValidDate(date) {
  if (!date) return false;
  const m = date.match(/^(\d{4})_(\d{2})$/);
  if (!m) return false;
  const yr = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  return yr >= 2400 && yr <= 2700 && mo >= 1 && mo <= 12;
}

// ── Exports ────────────────────────────────────────────────────────────────

/**
 * Fuzzy-match a physician name against all rows in the date table.
 * Returns the best match above the similarity threshold, or null.
 *
 * @param {string} name   Physician name from Claude, e.g. "สมชาย ใจดี"
 * @param {string} date   Table name, e.g. "2569_02"
 * @param {number} [threshold=0.6]  Minimum similarity to accept (0–1)
 * @returns {Promise<{ matchedName: string, prefix: string, index: number|string, similarity: number } | null>}
 */
export async function matchName(name, date, threshold = SIMILARITY_THRESHOLD) {
  if (!isValidDate(date)) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(date)
    .select("index, firstname, lastname, prefix, department")
    .limit(SUPABASE_ROW_LIMIT);

  if (error) throw new Error(`Supabase query error on table "${date}": ${error.message}`);
  if (!data || data.length === 0) return null;

  // ── Single-token (firstname-only) fast path ──────────────────────────────
  // When the extracted name is a single token (no last name supplied), check
  // whether exactly one row shares that first name.  If unambiguous, auto-
  // assign the last name from the database record.
  //   • Exactly 1 row matches → safe to use (unique firstname in this table)
  //   • 2+ rows match         → ambiguous, return null (safer than wrong match)
  //   • 0 rows match          → fall through to Levenshtein
  const normName = normalise(name);
  const tokens   = normName.split(" ").filter(Boolean);
  if (tokens.length === 1) {
    const hits = data.filter((row) => normalise(row.firstname ?? "") === normName);
    if (hits.length === 1) {
      const row      = hits[0];
      const fullName = `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim();
      console.log(`│        🔤  Single-token firstname match: "${normName}" → "${fullName}" (unique)`);
      return {
        matchedName: fullName,
        prefix     : row.prefix     ?? "",
        department : row.department ?? "",
        index      : row.index,
        similarity : 0.95, // high-confidence — unique firstname in this table
      };
    }
    if (hits.length > 1) {
      console.warn(`│        ⚠️  Single-token "${normName}" matches ${hits.length} rows — ambiguous, skipping`);
      return null;
    }
    // 0 exact firstname matches → fall through to Levenshtein
  }

  // ── Normal fuzzy matching ──────────────────────────────────────────────────
  let best = null;

  for (const row of data) {
    const fullName = `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim();
    const sim = similarity(name, fullName);
    if (sim > (best?.similarity ?? -1)) {
      best = {
        matchedName: fullName,
        prefix     : row.prefix      ?? "",
        department : row.department  ?? "",
        index      : row.index,
        similarity : sim,
      };
      if (sim === 1.0) break; // exact match — no need to scan remaining rows
    }
  }

  if (!best || best.similarity < threshold) return null;
  return best;
}

/**
 * Log a successful P4P submission to the p4p_submissions table.
 * Uses ON CONFLICT DO NOTHING so re-processing the same email never overwrites
 * the first (earliest) submission row for a given physician + work month.
 */
export async function logSubmission({ physicianName, department, workMonth, submittedAt, threadId, filename }) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("p4p_submissions")
    .upsert(
      {
        physician_name: physicianName,
        department    : department ?? null,
        work_month    : workMonth,
        submitted_at  : submittedAt,
        thread_id     : threadId  ?? null,
        filename      : filename  ?? null,
      },
      { onConflict: "physician_name,work_month", ignoreDuplicates: true }
    );
  if (error) throw new Error(`p4p_submissions insert error: ${error.message}`);
}

/**
 * Update the score column for a specific row identified by its primary key.
 *
 * @param {string}        date   Table name, e.g. "2569_02"
 * @param {number|string} index  Primary key value (column "index")
 * @param {number}        score  Score to save (float8)
 */
export async function saveScore(date, index, score, submittedAt) {
  if (!isValidDate(date)) {
    throw new Error(`Cannot save score — invalid date key: "${date}"`);
  }
  if (index === null || index === undefined) {
    throw new Error(`Cannot save score — index is ${index}`);
  }
  if (!Number.isFinite(score)) {
    throw new Error(`Cannot save score — value is not a finite number: ${score}`);
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from(date)
    .update({ score, submitted_at: submittedAt })
    .eq("index", index);

  if (error) throw new Error(`Supabase update error on table "${date}": ${error.message}`);
}

