/**
 * claude-analyst.js
 *
 * Uses Anthropic Claude Messages API.
 * Set ANTHROPIC_API_KEY in .env
 *
 * Export: analyseJson
 *   Returns { name, date, score } from a physician workload Excel sheet.
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

// ── Singleton client ───────────────────────────────────────────────────────
let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Strip markdown code fences Claude occasionally wraps around JSON */
function stripFences(str) {
  return str
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ── JS-side BE year resolver ───────────────────────────────────────────────
// Resolves the BE year from text before sending to Claude — removes all
// arithmetic from Claude's responsibility entirely.

/**
 * Extract and convert any year expression to a 4-digit BE year.
 * Searches in priority order: filename → subject → body (most → least reliable).
 * Returns null if no year found.
 */
function resolveBeYear(filename, subject, body) {
  // Try each source independently, highest confidence first.
  // This prevents a day number in the body (e.g. "วันที่ 28") from
  // being misread as a short CE year (28 → 2028 → BE 2571).
  const sources = [
    filename ?? "",
    subject  ?? "",
    body     ?? "",
  ];

  for (const t of sources) {
    // 1. Full BE year: 25xx (2500–2599)
    const mFullBE = t.match(/\b(25\d{2})\b/);
    if (mFullBE) return parseInt(mFullBE[1], 10);

    // 2. Full CE year: 20xx (2000–2099)
    const mFullCE = t.match(/\b(20\d{2})\b/);
    if (mFullCE) return parseInt(mFullCE[1], 10) + 543;

    // 3. 2-digit 43–99 → short BE (e.g. 69 → 2569).
    //    Negative lookbehind avoids matching last 2 digits of a 4-digit number.
    const mShortBE = t.match(/(?<!\d)\b([4-9]\d)\b(?!\d)/);
    if (mShortBE) return 2500 + parseInt(mShortBE[1], 10);

    // 4. 2-digit 00–42 → short CE (e.g. 26 → 2026 → BE 2569).
    //    Only applied per-source so body day numbers don't pollute filename results.
    //    Skip if this source is the body (too noisy — day numbers are common).
    if (t !== body) {
      const mShortCE = t.match(/(?<!\d)\b([0-3]\d)\b(?!\d)/);
      if (mShortCE) return 2000 + parseInt(mShortCE[1], 10) + 543;
    }
  }

  return null;
}

// Labels that only appear as grand-total row markers — safe to search ALL columns
const GRAND_TOTAL_LABELS = [
  "รวมแต้มทั้งหมด", "รวมคะแนนทั้งหมด", "รวมทั้งสิ้น", "ยอดรวมทั้งหมด",
  "รวมทั้งหมด", "คะแนนรวมทั้งหมด",
];

// Sub-total labels — only checked in first 3 columns to avoid false-matching
// column headers (some sheets have "รวมแต้ม" as a column header in col_5+)
const SUBTOTAL_LABELS = [
  "รวมคะแนน", "รวมแต้ม", "คะแนนรวม", "ผลรวม", "รวม",
];

// Combined for weight×day fallback (avoid importing twice)
const TOTAL_LABELS = [...GRAND_TOTAL_LABELS, ...SUBTOTAL_LABELS];

/** Coerce any cell value to a number. Returns NaN if not numeric. */
function toNum(val) {
  if (val === null || val === undefined || val === "") return NaN;
  if (typeof val === "number")  return val;
  if (typeof val === "boolean") return NaN;
  const s = String(val).trim();
  // Skip ISO date strings — parseFloat("2025-01-15T...") returns 2025
  // which looks like a CE year but slips through isYearLike for out-of-range dates
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
  return parseFloat(s.replace(/,/g, ""));
}

/** True if n looks like a calendar year and not a score. */
function isYearLike(n) {
  return (n >= 1900 && n <= 2099) || (n >= 2400 && n <= 2699);
}

/**
 * Collect all positive, non-year numbers from a set of rows.
 * NOTE: row-ID filtering is intentionally NOT applied here — it caused
 * false negatives when a score value happened to equal the row index.
 */
function collectCandidates(rows) {
  const results = [];
  for (const row of rows) {
    for (const val of Object.values(row)) {
      const n = toNum(val);
      if (isNaN(n) || n <= 0) continue;
      if (isYearLike(n))      continue;
      results.push(n);
    }
  }
  return results;
}

/**
 * Try keyword label row first, then fall back to the largest valid number
 * in the entire sheet.
 *
 * KEY FIXES vs previous version:
 * 1. Only check the FIRST 3 columns for Thai total labels.
 *    Some sheets have "รวมแต้ม" as a COLUMN HEADER in col_5 — searching
 *    all columns causes a false match on the header row (day numbers 1–31).
 * 2. Collect candidates from ALL matching label rows (not just the first).
 *    Return the max across all of them — the grand total is always the
 *    largest of all sub-totals.
 * @param {object[]} rows
 * @returns {{ score: number|null, method: string }}
 */
function extractScoreFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { score: null, method: "no rows" };
  }

  // Step 1: grand-total pass — search ALL columns for grand-total specific labels.
  // These keywords only appear in grand-total rows, never as column headers.
  const grandCandidates = [];
  for (const row of rows) {
    const allValues = Object.values(row).map((v) => String(v ?? ""));
    const hasGrandLabel = allValues.some((s) =>
      GRAND_TOTAL_LABELS.some((label) => s.includes(label))
    );
    if (hasGrandLabel) {
      const nums = collectCandidates([row]);
      grandCandidates.push(...nums);
    }
  }
  if (grandCandidates.length > 0) {
    return { score: Math.max(...grandCandidates), method: "grand-total label row (all columns)" };
  }

  // Step 2: sub-total pass — search col_1/col_2/col_3 only.
  // Limited to first 3 columns to avoid false-matching "รวมแต้ม" column headers.
  // Returns the MAX across all matching rows — grand total > any sub-total.
  const subCandidates = [];
  for (const row of rows) {
    const firstThree = ["col_1", "col_2", "col_3"]
      .map((k) => String(row[k] ?? ""));
    const hasLabel = firstThree.some((s) =>
      SUBTOTAL_LABELS.some((label) => s.includes(label))
    );
    if (hasLabel) {
      const nums = collectCandidates([row]);
      subCandidates.push(...nums);
    }
  }
  if (subCandidates.length > 0) {
    const subMax = Math.max(...subCandidates);
    // Sanity-check: if the sheet has a larger number than any labeled sub-total row,
    // the grand total is likely in a row whose label sits in col_4+ (not col_1-3).
    // Prefer the sheet-wide max in that case.
    const allNums = collectCandidates(rows);
    const sheetMax = allNums.length > 0 ? Math.max(...allNums) : subMax;
    if (sheetMax > subMax) {
      return { score: sheetMax, method: "largest in sheet (exceeds sub-total label rows)" };
    }
    return { score: subMax, method: "sub-total label row (col_1-3)" };
  }

  // Step 3: largest valid number in the whole sheet
  const all = collectCandidates(rows);
  if (all.length > 0) {
    return { score: Math.max(...all), method: "largest in sheet" };
  }

  // Step 4: weight × day-count computation (last resort for cm="1" formula-only sheets)
  let computedTotal = 0;
  for (const row of rows) {
    const isLabel = ["col_1", "col_2", "col_3"]
      .some((k) => TOTAL_LABELS.some((label) => String(row[k] ?? "").includes(label)));
    if (isLabel) continue;

    const weightRaw = row["col_3"];
    if (weightRaw === null || weightRaw === undefined) continue;

    let weight;
    if (typeof weightRaw === "number") {
      weight = weightRaw;
    } else {
      const m = String(weightRaw).replace(/,/g, "").match(/^(\d+\.?\d*)/);
      if (!m) continue;
      weight = parseFloat(m[1]);
    }
    if (isNaN(weight) || weight <= 0) continue;

    let daySum = 0;
    for (let d = 6; d <= 36; d++) {
      const v = toNum(row[`col_${d}`]);
      if (!isNaN(v) && v > 0) daySum += v;
    }
    if (daySum > 0) computedTotal += weight * daySum;
  }

  if (computedTotal > 0) {
    return { score: computedTotal, method: "weight × day-count computation" };
  }

  return { score: null, method: "no candidates found" };
}

/**
 * @param {object} jsonData  { _email_subject, _email_body, _source_file, rows[] }
 * @param {string} filename
 * @returns {Promise<{ name: string, date: string, score: string }>}
 */
export async function analyseJson(jsonData, filename = "data.json") {
  const client  = getClient();
  const rows    = jsonData.rows ?? [];
  const subject = jsonData._email_subject ?? "";
  const body    = jsonData._email_body    ?? "";
  const file    = jsonData._source_file   ?? filename;

  if (rows.length === 0) throw new Error("No rows to analyse.");

  // Resolve BE year per-source (filename → subject → body) for highest accuracy
  const resolvedBE = resolveBeYear(file, subject, body);
  const yearHint   = resolvedBE
    ? `Pre-resolved BE year: ${resolvedBE}  ← USE THIS EXACT VALUE, do not recalculate.`
    : `BE year: unknown — use "0000".`;

  // Resolve score in JS first — gives Claude a reliable anchor
  const { score: jsScore, method: jsMethod } = extractScoreFromRows(rows);
  console.log(`│        🔢  JS score pre-scan: ${jsScore !== null ? jsScore.toFixed(2) : "null"} (${jsMethod})`);

  const scoreHint = jsScore !== null
    ? `Pre-detected score (JS, method: ${jsMethod}): ${jsScore.toFixed(2)}  ← USE THIS VALUE.`
    : `No score pre-detected — find it from the label row or column sum.`;

  // Compact rows — drop all-null rows and null cells before sending to Claude
  const compactRows = rows
    .filter((row) => Object.values(row).some((v) => v !== null))
    .map((row) => Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== null)
    ));

  const fullJson = JSON.stringify(compactRows, null, 2);
  if (fullJson.length > 8000) {
    console.warn(`│        ⚠️  Row JSON truncated: ${fullJson.length} → 8000 chars (${compactRows.length} rows)`);
  }
  const rowsJson = fullJson.slice(0, 8000);

  const bodyPreview = body.trim().slice(0, 400); // trimmed — avoid injecting leading whitespace

  const prompt = `You are analysing a Thai physician physical workload scorecard exported from Excel.
Return ONLY this JSON, nothing else:
{"name": "PHYSICIAN_NAME", "date": "xxxx_xx", "score": "TOTAL"}

━━ 1. name ━━
Firstname + " " + lastname only. Strip all titles: นพ. พญ. นายแพทย์ แพทย์หญิง ทพ. ดร. Dr. Prof. Mr. Mrs.

━━ 2. date ━━
${yearHint}

Month sources — Filename: "${file}" | Subject: "${subject}" | Body: "${bodyPreview}"
ม.ค./มค/มกราคม/Jan/January=01    ก.พ./กพ/กุมภาพันธ์/Feb/February=02
มี.ค./มีค/มีนาคม/Mar/March=03     เม.ย./เมย/เมษายน/Apr/April=04
พ.ค./พค/พฤษภาคม/May=05            มิ.ย./มิย/มิถุนายน/Jun/June=06
ก.ค./กค/กรกฎาคม/Jul/July=07      ส.ค./สค/สิงหาคม/Aug/August=08
ก.ย./กย/กันยายน/Sep/September=09  ต.ค./ตค/ตุลาคม/Oct/October=10
พ.ย./พย/พฤศจิกายน/Nov/November=11 ธ.ค./ธค/ธันวาคม/Dec/December=12
Format: "xxxx_xx". Unknown month → "00".

━━ 3. score ━━
${scoreHint}
If you find a Thai total label row (รวมคะแนน รวมแต้ม คะแนนรวม ผลรวม รวมทั้งหมด รวม), use the largest non-zero numeric value from it.
Format: 2 decimal places, no commas.

━━ Row data ━━
${rowsJson}`;

  const message = await client.messages.create({
    model     : process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
    max_tokens: 512,
    messages  : [{ role: "user", content: prompt }],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw}`);
  }

  // Validate name
  const name = parsed?.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`Missing or empty "name": ${raw}`);
  }

  // Validate date format xxxx_xx and semantic range
  const date = parsed?.date;
  if (typeof date !== "string" || !/^\d{4}_\d{2}$/.test(date)) {
    throw new Error(`Invalid date format "${date}" — expected xxxx_xx: ${raw}`);
  }
  const [yr, mo] = date.split("_").map(Number);
  if (yr < 2400 || yr > 2700 || mo < 1 || mo > 12) {
    throw new Error(`Date "${date}" out of valid range (BE year 2400–2700, month 01–12): ${raw}`);
  }

  // Score: prefer Claude's answer; fall back to JS if Claude returns 0/null
  const rawScore = parsed?.score;
  let numeric = 0;
  if (rawScore !== undefined && rawScore !== null && rawScore !== "null") {
    numeric = typeof rawScore === "number"
      ? rawScore
      : parseFloat(String(rawScore).replace(/,/g, ""));
  }
  if (isNaN(numeric) || numeric === 0) {
    if (jsScore !== null && jsScore > 0) {
      console.log(`│        ⚠️  Claude returned "${rawScore}" — using JS score ${jsScore.toFixed(2)} (${jsMethod})`);
      numeric = jsScore;
    } else {
      throw new Error(
        `Could not determine score. Claude: "${rawScore}", JS scan: null (${jsMethod}). ` +
        `Row count: ${rows.length}. Sample values: ${
          rows.slice(0, 3).map(r => JSON.stringify(Object.values(r).slice(0, 4))).join(" | ")
        }`
      );
    }
  }

  return { name: name.trim(), date, score: numeric.toFixed(2) };
}
