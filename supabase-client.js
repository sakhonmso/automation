/**
 * supabase-client.js
 *
 * Looks up a physician name in the Supabase table matching the given date key.
 * Table name = date value, e.g. "2569_03"
 * Columns used: "firstname" and "lastname" (concatenated with a space)
 *
 * Returns "matched" if the name exists in the table, "not matched" otherwise.
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

/**
 * Check whether a physician name exists in the Supabase table for the given date.
 *
 * @param {string} name  First + last name, e.g. "สมชาย ใจดี"
 * @param {string} date  Table name / date key, e.g. "2569_03"
 * @returns {Promise<"matched" | "not matched">}
 */
export async function checkNameInSupabase(name, date) {
  // Guard: if Claude could not determine the date, the table won't exist
  if (!date || date === "0000_00" || date.startsWith("0000") || date.endsWith("_00")) {
    return "not matched";
  }

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(date)
    .select("firstname, lastname");

  if (error) {
    throw new Error(`Supabase error querying table "${date}": ${error.message}`);
  }

  if (!data || data.length === 0) {
    return "not matched";
  }

  // Normalise: trim, collapse ALL Unicode whitespace including zero-width spaces
  // (\u200b common in Thai text copied from web/PDF) and non-breaking variants
  const normaliseName = (s) =>
    String(s ?? "")
      .replace(/[\s\u00a0\u200b\u202f\u2009\u3000\ufeff]+/g, " ")
      .trim()
      .toLowerCase();

  const targetName = normaliseName(name);

  const found = data.some((row) => {
    const full = normaliseName(`${row.firstname ?? ""} ${row.lastname ?? ""}`);
    return full === targetName;
  });

  return found ? "matched" : "not matched";
}