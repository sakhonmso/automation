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
import { MAX_ROW_JSON_CHARS, CLAUDE_MAX_TOKENS } from "./config.js";

// ── Singleton client ───────────────────────────────────────────────────────
let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  _client = new Anthropic({ apiKey, ...(baseURL && { baseURL }) });
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
 * Searches in priority order: subject → body → filename (most → least reliable).
 * Returns null if no year found.
 */
export function resolveBeYear(filename, subject, body) {
  // Try each source independently, highest confidence first.
  // This prevents a day number in the body (e.g. "วันที่ 28") from
  // being misread as a short CE year (28 → 2028 → BE 2571).
  const sources = [
    subject  ?? "",
    body     ?? "",
    filename ?? "",
  ];

  for (const t of sources) {
    // Use (?<!\d) / (?!\d) instead of \b so that underscore-delimited numbers
    // in filenames like "P4P_2569_02.xlsx" are matched correctly.
    // (\b does NOT fire between _ and a digit because _ is a \w character.)

    // 1. Full BE year: 25xx (2500–2599)
    const mFullBE = t.match(/(?<!\d)(25\d{2})(?!\d)/);
    if (mFullBE) return parseInt(mFullBE[1], 10);

    // 2. Full CE year: 20xx (2000–2099)
    const mFullCE = t.match(/(?<!\d)(20\d{2})(?!\d)/);
    if (mFullCE) return parseInt(mFullCE[1], 10) + 543;

    // 3. 2-digit 43–99 → short BE (e.g. 69 → 2569).
    const mShortBE = t.match(/(?<!\d)([4-9]\d)(?!\d)/);
    if (mShortBE) return 2500 + parseInt(mShortBE[1], 10);

    // 4. 2-digit 00–42 → short CE (e.g. 26 → 2026 → BE 2569).
    //    Only applied per-source so body day numbers don't pollute filename results.
    //    Skip if this source is the body (too noisy — day numbers are common).
    if (t !== body) {
      const mShortCE = t.match(/(?<!\d)([0-3]\d)(?!\d)/);
      if (mShortCE) return 2000 + parseInt(mShortCE[1], 10) + 543;
    }
  }

  return null;
}

// ── JS-side physician name resolver ───────────────────────────────────────
// Thai title prefixes to strip before returning a name
const TITLE_PREFIX_RE = /^(?:นพ\.|พญ\.|นายแพทย์\s*|แพทย์หญิง\s*|ทพ\.|ทพญ\.|ดร\.|Dr\.\s*|Prof\.\s*|Mr\.\s*|Mrs\.\s*)/;

// Thai words that are not physician names (common non-name tokens in filenames/subjects)
const NON_NAME_THAI = new Set([
  "P4P", "เดือน", "ปี", "แพทย์", "โรงพยาบาล", "รพ", "ผลงาน", "คะแนน",
  "แต้ม", "รวม", "ข้อมูล", "ส่ง", "ไฟล์", "สค", "สมุทรสาคร", "องค์กร",
  "ฝ่าย", "กลุ่ม", "งาน", "ประจำ", "ทำงาน",
  // Thai month names (full) — filenames like "ศาศวัต มีนาคม.xlsx" must not treat
  // the month word as a lastname
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
  // Thai month abbreviations (no dots — dots are stripped by the Thai-char regex)
  "มค", "กพ", "มีค", "เมย", "พค", "มิย", "กค", "กย", "ตค", "พย", "ธค",
]);

/**
 * Try to extract "firstname lastname" from a single text string.
 * Strategy:
 *   1. Title prefix + two Thai words  (most reliable — "นพ.สมชาย ใจดี")
 *   2. Two consecutive Thai words separated by space/underscore/dash
 *      (filename pattern — "สมชาย_ใจดี.xlsx")
 * Returns "firstname lastname" with no title, or null.
 */
function extractNameFromText(text) {
  if (!text) return null;

  // Pattern 1: recognised title prefix immediately followed by two Thai words
  const titleRe = /(?:นพ\.|พญ\.|นายแพทย์|แพทย์หญิง|ทพ\.|ทพญ\.|ดร\.)\s*([\u0E00-\u0E7F]{2,})\s+([\u0E00-\u0E7F]{2,})/;
  const m1 = text.match(titleRe);
  if (m1) return `${m1[1]} ${m1[2]}`;

  // Pattern 2: two consecutive Thai-character sequences (min 2 chars each),
  // separated by one of: space, underscore, dash, dot — but NOT a digit boundary.
  // Both words must not be in the NON_NAME_THAI exclusion set.
  const twoWordRe = /([\u0E00-\u0E7F]{2,})[\s_\-.]+([\u0E00-\u0E7F]{2,})/g;
  let m2;
  while ((m2 = twoWordRe.exec(text)) !== null) {
    const first = m2[1];
    const last  = m2[2];
    if (!NON_NAME_THAI.has(first) && !NON_NAME_THAI.has(last)) {
      return `${first} ${last}`;
    }
  }

  return null;
}

/**
 * Extract physician name (firstname + lastname, no title) in priority order:
 *   1. Excel attachment filename
 *   2. Email subject
 *   3. Email body
 * Returns the first plausible name found, or null (caller falls back to sheet/Claude).
 */
export function resolvePhysicianName(filename, subject, body) {
  // Strip file extension from filename before scanning
  const fileBase = (filename ?? "").replace(/\.[^.]+$/, "");

  const sources = [
    fileBase,
    subject ?? "",
    body    ?? "",
  ];

  for (const src of sources) {
    const name = extractNameFromText(src);
    if (name) return name;
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

/** True if n looks like a calendar year and not a score. */
function isYearLike(n) {
  return (n >= 1900 && n <= 2099) || (n >= 2400 && n <= 2699);
}

/**
 * Extract all positive, non-year numbers embedded in a mixed text+number string.
 * Handles cells like "รวมทั้งหมด  = 11011.5" where label and score share one cell.
 */
function numsFromText(val) {
  const s = String(val ?? "").replace(/,/g, "");
  return [...s.matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0]))
    .filter((n) => !isNaN(n) && n > 0 && !isYearLike(n));
}

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
export function extractScoreFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { score: null, method: "no rows" };
  }

  // Step 1: grand-total pass — search ALL columns for grand-total specific labels.
  // These keywords only appear in grand-total rows, never as column headers.
  const grandCandidates = [];
  for (const row of rows) {
    const allValues = Object.values(row).map((v) => String(v ?? ""));
    const labelCells = allValues.filter((s) =>
      GRAND_TOTAL_LABELS.some((label) => s.includes(label))
    );
    if (labelCells.length > 0) {
      const nums = collectCandidates([row]);
      // Also extract numbers embedded inside the label cells themselves.
      // Handles the case where label and score share one cell, e.g.:
      //   "รวมทั้งหมด  = 11011.5"
      const embedded = labelCells.flatMap((s) => numsFromText(s));
      grandCandidates.push(...nums, ...embedded);
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
 * Wraps extractScoreFromRows with a two-tier fallback for files where
 * fix_p4p_score.py (openpyxl) wrote =SUM(...) formulas without caching
 * a <v> value. In those files the grand-total cell parses as empty, so
 * extractScoreFromRows falls back to the largest plain number in the sheet
 * (often a per-item weight like 2200) instead of the actual grand total.
 *
 * Tier 1 — grand-total row empty, all sub-total rows cached:
 *   Sum the max value from each sub-total row.
 *
 * Tier 2 — some sub-total rows also uncached:
 *   Detect the score column (last numeric column) from whichever sub-total
 *   rows are populated, then sum that column from individual data rows only
 *   (sub-total and grand-total rows are excluded to avoid double-counting).
 */
function resolveScore(rows) {
  const { score: jsScore, method: jsMethod } = extractScoreFromRows(rows);

  // Detect: grand-total label row present but contains no numbers
  const grandRowEmpty = rows.some((row) => {
    const allVals = Object.values(row).map((v) => String(v ?? ""));
    const hasLabel = allVals.some((s) => GRAND_TOTAL_LABELS.some((lbl) => s.includes(lbl)));
    if (!hasLabel) return false;
    // Check for any positive non-year number in this row
    return !Object.values(row).some((val) => {
      const n = toNum(val);
      return !isNaN(n) && n > 0 && !isYearLike(n);
    });
  });

  if (!grandRowEmpty) return { score: jsScore, method: jsMethod };

  const isSubtotalRow = (row) => {
    const firstThree = ["col_1", "col_2", "col_3"].map((k) => String(row[k] ?? ""));
    return firstThree.some((s) => SUBTOTAL_LABELS.some((lbl) => s.includes(lbl)));
  };
  const isGrandTotalRow = (row) =>
    Object.values(row).some((v) => GRAND_TOTAL_LABELS.some((lbl) => String(v ?? "").includes(lbl)));

  const rowNums = (row) =>
    Object.values(row).map(toNum).filter((n) => !isNaN(n) && n > 0 && !isYearLike(n));

  const populated = rows.filter((r) => isSubtotalRow(r) && rowNums(r).length > 0);
  const empty     = rows.filter((r) => isSubtotalRow(r) && rowNums(r).length === 0);

  // Tier 1: sum max from each populated sub-total row
  const subtotalSum = populated.reduce((s, r) => s + Math.max(...rowNums(r)), 0);

  // Tier 2: when some sub-totals are also uncached, sum score column from data rows
  let dataRowSum = 0;
  if (populated.length > 0 && empty.length > 0) {
    let scoreColIndex = -1;
    for (const row of populated) {
      const indices = Object.keys(row)
        .filter((k) => /^col_\d+$/.test(k) && !isNaN(toNum(row[k])) && toNum(row[k]) > 0)
        .map((k) => parseInt(k.slice(4)));
      if (indices.length > 0) scoreColIndex = Math.max(scoreColIndex, Math.max(...indices));
    }
    if (scoreColIndex > 0) {
      const scoreColKey = `col_${scoreColIndex}`;
      for (const row of rows) {
        if (isSubtotalRow(row) || isGrandTotalRow(row)) continue;
        const n = toNum(row[scoreColKey]);
        if (!isNaN(n) && n > 0 && !isYearLike(n)) dataRowSum += n;
      }
    }
  }

  const best = Math.max(subtotalSum, dataRowSum);
  if (best > 0 && best > (jsScore ?? 0)) {
    const method = dataRowSum >= subtotalSum
      ? "sum of score-column data rows (sub-totals partially uncached)"
      : "sum of sub-total rows (grand-total formula uncached)";
    return { score: best, method };
  }

  return { score: jsScore, method: jsMethod };
}

/**
 * @param {object} jsonData  { _email_subject, _email_body, _source_file, rows[] }
 * @param {string} filename
 * @returns {Promise<{ name: string, date: string, score: number }>}
 */
export async function analyseJson(jsonData, filename = "data.json") {
  const client  = getClient();
  const rows    = jsonData.rows ?? [];
  const subject = jsonData._email_subject ?? "";
  const body    = jsonData._email_body    ?? "";
  const file    = jsonData._source_file   ?? filename;

  if (rows.length === 0) throw new Error("No rows to analyse.");

  // Resolve physician name: filename → subject → body → null (fall back to sheet)
  const resolvedName = resolvePhysicianName(file, subject, body);
  const nameHint = resolvedName
    ? `Pre-resolved name (from filename/subject/body): "${resolvedName}"  ← USE THIS VALUE, strip titles if still present.`
    : `Name not pre-detected — search in order: (1) filename "${file}", (2) email subject/body, (3) row data.`;
  console.log(`│        👤  JS name pre-scan: ${resolvedName ?? "null (will use sheet)"}`);

  // Resolve BE year per-source (subject → body → filename) for highest accuracy
  const resolvedBE = resolveBeYear(file, subject, body);
  const yearHint   = resolvedBE
    ? `Pre-resolved BE year: ${resolvedBE}  ← USE THIS EXACT VALUE, do not recalculate.`
    : `BE year: unknown — use "0000".`;

  // Resolve score in JS first — gives Claude a reliable anchor
  // Use resolveScore (not extractScoreFromRows directly) so that files where
  // fix_p4p_score.py wrote uncached =SUM(...) formulas fall through the
  // two-tier fallback instead of returning the largest plain number (e.g. 2200).
  const { score: jsScore, method: jsMethod } = resolveScore(rows);
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
  if (fullJson.length > MAX_ROW_JSON_CHARS) {
    console.warn(`│        ⚠️  Row JSON truncated: ${fullJson.length} → ${MAX_ROW_JSON_CHARS} chars (${compactRows.length} rows)`);
  }
  const rowsJson = fullJson.slice(0, MAX_ROW_JSON_CHARS);

  const bodyPreview = body.trim().slice(0, 400); // trimmed — avoid injecting leading whitespace

  const prompt = `You are analysing a Thai physician physical workload scorecard exported from Excel.
Return ONLY this JSON, nothing else:
{"name": "PHYSICIAN_NAME", "date": "xxxx_xx", "score": "TOTAL"}

━━ 1. name ━━
${nameHint}
Firstname + " " + lastname only. Strip all titles: นพ. พญ. นายแพทย์ แพทย์หญิง ทพ. ดร. Dr. Prof. Mr. Mrs.
IMPORTANT: Thai month names are NOT lastnames — ignore them: มกราคม กุมภาพันธ์ มีนาคม เมษายน พฤษภาคม มิถุนายน กรกฎาคม สิงหาคม กันยายน ตุลาคม พฤศจิกายน ธันวาคม
If the filename contains "ชื่อ เดือน" (e.g. "ศาศวัต มีนาคม"), only "ศาศวัต" is the name — search row data for the real lastname.
If pre-resolved name above is provided, use it. Otherwise search: (1) filename, (2) subject/body, (3) row data.

━━ 2. date ━━
${yearHint}

Month sources — Subject: "${subject}" | Body: "${bodyPreview}" | Filename: "${file}"
Priority: (1) subject/body, (2) filename, (3) row data.
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
    max_tokens: CLAUDE_MAX_TOKENS,
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
  if (isNaN(numeric) || numeric <= 0) {
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

  // Return score as a number — callers format with .toFixed(2) for display
  return { name: name.trim(), date, score: numeric };
}
