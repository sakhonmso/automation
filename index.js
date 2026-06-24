/**
 * index.js
 *
 * - Fetches up to 10 new unread inbox messages
 * - For .xlsx attachments: converts the FIRST sheet to JSON using ExcelJS
 * - Sends to Claude API to extract: physician name, workload date (BE), total score
 * - Fuzzy-matches name in Supabase, saves score, notifies via Telegram
 *
 *   npm start
 */

import { createGmailClient }             from "./gmail-client.js";
import { createDriveClient }             from "./drive-client.js";
import { analyseJson, resolveBeMonth, resolvePhysicianNameFromSheet } from "./claude-analyst.js";
import { matchName, saveScore, logSubmission } from "./supabase-client.js";
import { sendTelegram, formatResultMessage, formatErrorMessage } from "./telegram.js";
import { buildHtmlReply }               from "./templates/reply.js";
import { buildHtmlErrorReply }          from "./templates/error-reply.js";
import { checkEnv }                     from "./env-check.js";
import { MAX_MESSAGES, SKIP_SENDERS, SEND_ERROR_REPLIES, THREAD_RELAY_SENDERS } from "./config.js";
import log                              from "./logger.js";
import * as path                        from "path";
import ExcelJS                          from "exceljs";
// override:true ensures .env values win over stale system-level env vars
// (e.g. ANTHROPIC_API_KEY="" set at OS level would otherwise shadow the real key)
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

// Thai month names for auto-reply display (index 0 unused; 1 = January … 12 = December)
const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
  "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
  "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

// Lazy Drive client — only initialised if P4P_FOLDER_ID is set
let _drive = null;
function getDrive() {
  if (!process.env.P4P_FOLDER_ID) return null;
  if (!_drive) _drive = createDriveClient();
  return _drive;
}

// MIME types AND extensions that we treat as Excel files (.xlsx only)
const EXCEL_MIMETYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/wps-office.xlsx",                                         // WPS variant
]);

// Matches cloud-storage share links — used to detect "file link instead of real file"
const CLOUD_LINK_RE = /https?:\/\/(drive\.google\.com|docs\.google\.com|1drv\.ms|dropbox\.com|onedrive\.live\.com|sharepoint\.com)/i;

function isExcelFile(mimeType, filename) {
  if (EXCEL_MIMETYPES.has(mimeType)) return true;
  if (!filename) return false;
  return path.extname(filename).toLowerCase() === ".xlsx";
}

function formatSize(bytes) {
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Escape user-derived strings before inserting into HTML to prevent XSS. */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Excel loading ─────────────────────────────────────────────────────────
// Note: both ExcelJS and JSZip are intentionally used together.
//   • JSZip  — low-level ZIP/XML manipulation to strip formulas and extract
//              a single sheet without re-encoding the whole workbook.
//   • ExcelJS — high-level row/cell reading after the XML has been sanitised.
// Replacing either library would require reimplementing the other's role.

/**
 * Load any Excel buffer with ExcelJS and convert the correct sheet to row objects.
 *
 * Uses row.eachCell (not row.values) so we access the real Cell object and can
 * call cell.result directly. This fixes cm="1" (Excel 365 dynamic array formula)
 * cells where row.values returns a formula-object with result=0 even when the
 * actual cached <v> element contains the correct non-zero value.
 *
 * @param {Buffer} buffer
 * @param {{ targetMonth?: number|null }} [opts]  targetMonth 1–12 hints which sheet to use
 *   in multi-sheet workbooks (e.g. physician accumulated all months in one file).
 */
async function firstSheetToRows(buffer, { targetMonth = null } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const allSheets = workbook.worksheets.map((ws) => ws.name);
  if (allSheets.length === 0) throw new Error("Workbook has no sheets.");

  function nonNullCount(ws) {
    let count = 0;
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.value !== null && cell.value !== undefined) count++;
      });
    });
    return count;
  }

  // ── Sheet selection ──────────────────────────────────────────────────────
  // Default: first non-empty sheet (existing behaviour).
  // When targetMonth is known, prefer the sheet whose name contains a month
  // token matching that month number — handles multi-month workbooks where a
  // physician accumulates all months in one file.
  let wsIndex = 0;
  if (nonNullCount(workbook.worksheets[0]) < 3 && workbook.worksheets.length > 1) {
    wsIndex = 1;
  }

  if (targetMonth !== null && workbook.worksheets.length > 1) {
    // Build a month-number → list of Thai/English tokens map for matching
    const MONTH_TOKENS_BY_NUM = {
      1:  ["มกราคม","มกรา","มกร","มค","january","jan"],
      2:  ["กุมภาพันธ์","กุมภา","กุมภ","กพ","february","feb"],
      3:  ["มีนาคม","มีนา","มีน","มีค","march","mar"],
      4:  ["เมษายน","เมษา","เมษ","เมย","april","apr"],
      5:  ["พฤษภาคม","พฤษภ","พฤษ","พค","may"],
      6:  ["มิถุนายน","มิถุน","มิถุ","มิย","june","jun"],
      7:  ["กรกฎาคม","กรกฎ","กรก","กค","july","jul"],
      8:  ["สิงหาคม","สิงหา","สิงห","สค","august","aug"],
      9:  ["กันยายน","กันยา","กันย","กย","september","sep"],
      10: ["ตุลาคม","ตุลา","ตุล","ตค","october","oct"],
      11: ["พฤศจิกายน","พฤศจิ","พฤศ","พย","november","nov"],
      12: ["ธันวาคม","ธันวา","ธันว","ธค","december","dec"],
    };
    const targetTokens = MONTH_TOKENS_BY_NUM[targetMonth] ?? [];

    const matched = workbook.worksheets.findIndex((ws) => {
      const name = ws.name.toLowerCase();
      return targetTokens.some((tok) => name.includes(tok));
    });

    if (matched !== -1 && nonNullCount(workbook.worksheets[matched]) >= 3) {
      if (matched !== wsIndex) {
        console.log(`│        📋  Multi-sheet workbook: target month ${targetMonth} → sheet "${workbook.worksheets[matched].name}" (index ${matched}) over default "${allSheets[wsIndex]}"`);
      }
      wsIndex = matched;
    }
  }

  const worksheet = workbook.worksheets[wsIndex];
  const rows = [];

  worksheet.eachRow((row) => {
    if (!row.hasValues) return;

    const obj = {};

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = `col_${colNumber}`;

      const val = cell.value;
      // ExcelJS represents shared-formula cells in two forms:
      //   Master cell: { formula: "=A1*B1", result: 42, shared: true, si: 0 }  → "formula" in val
      //   Clone cell:  { sharedFormula: "A1", result: 42 }                      → "sharedFormula" in val, no "formula"
      // Without handling clones, their raw objects leak into rows as { sharedFormula: "..." }
      // which bloats the JSON and prevents correct numeric extraction.
      const isMasterFormula = val !== null && typeof val === "object" && "formula" in val;
      const isCloneFormula  = val !== null && typeof val === "object" && "sharedFormula" in val && !("formula" in val);

      if (isMasterFormula || isCloneFormula) {
        const r = cell.result;
        if (isCloneFormula) {
          // Clone cells: keep only numeric results (computed scores/counts).
          // Text results are repeated merged-cell display text that adds no analytical value
          // and would be duplicated across every column in the merged range.
          obj[key] = (typeof r === "number") ? r : null;
        } else {
          // Master formula cells: extract result normally
          if (r === null || r === undefined) {
            obj[key] = null;
          } else if (r instanceof Date) {
            obj[key] = r.toISOString();
          } else {
            obj[key] = r;
          }
        }
        return;
      }

      if (val === null || val === undefined) {
        obj[key] = null;
      } else if (val instanceof Date) {
        obj[key] = val.toISOString();
      } else if (typeof val === "object" && Array.isArray(val.richText)) {
        obj[key] = val.richText.map((r) => r.text ?? "").join("");
      } else if (typeof val === "object" && "text" in val) {
        obj[key] = String(val.text ?? "");
      } else {
        obj[key] = val;
      }
    });

    if (Object.keys(obj).length > 0) rows.push(obj);
  });

  return { rows, allSheets, chosenSheet: allSheets[wsIndex] };
}

/**
 * Pre-process an xlsx buffer at the XML level, replacing every formula cell
 * with its plain cached value. This prevents ExcelJS from choking on:
 *   - Shared formulas (t="shared"): master/clone chains that ExcelJS
 *     can't reconstruct correctly when writing a stripped workbook.
 *   - Dynamic array formulas (cm="1"): Excel 365 spill formulas that
 *     ExcelJS reads as result=0.
 *
 * Strategy: for each worksheet XML, strip the <f> element from every cell
 * and keep only the <v> element (the cached computed value).
 * Returns a new Buffer with the modified XML.
 */
async function stripFormulasFromBuffer(inputBuffer) {
  const JSZip = (await import("jszip")).default;
  const zip   = await JSZip.loadAsync(inputBuffer);

  const sheetPaths = Object.keys(zip.files).filter(
    (p) => p.startsWith("xl/worksheets/sheet") && p.endsWith(".xml")
  );

  for (const sheetPath of sheetPaths) {
    let xml = await zip.files[sheetPath].async("string");

    // Normalize bare \r line endings to \n.
    // Some Excel files (notably from Mac Excel) use \r without \n between
    // the XML declaration and the root element. JSZip's internal XML parser
    // treats \r as a document separator, triggering "documents may contain
    // only one root" when the zip is re-serialised via generateAsync.
    xml = xml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Match only non-self-closing cells: <c ...>...</c>
    // The negative lookbehind (?<!\/) ensures we never match <c .../>
    // (self-closing cells have no formula/value to strip and must pass through unchanged)
    xml = xml.replace(/<c ([^>]*)(?<!\/)>([\s\S]*?)<\/c>/g, (match, attrs, inner) => {
      // Remove cm="1" attribute (dynamic array marker) from <c> tag
      const cleanAttrs = attrs.replace(/\s*cm="1"/, "");

      // Extract cached value from <v>...</v> (allow optional whitespace in tag, e.g. <v >)
      const vMatch = inner.match(/<v[^>]*>([^<]*)<\/v>/);
      const vTag   = vMatch ? `<v>${vMatch[1]}</v>` : "";

      // Reconstruct cell with no formula, just the cached value
      return vTag ? `<c ${cleanAttrs}>${vTag}</c>` : `<c ${cleanAttrs}/>`;
    });

    zip.file(sheetPath, xml);
  }

  const out = await zip.generateAsync({
    type              : "nodebuffer",
    compression       : "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return out;
}

/**
 * Extract the target sheet from the ORIGINAL buffer and return it as a
 * single-sheet xlsx, preserving all original formulas and formatting.
 *
 * Strategy:
 *   1. Use the formula-stripped buffer to safely determine which sheet has
 *      content (ExcelJS can't reliably read shared-formula files otherwise).
 *   2. Map the chosen sheet index back to its raw XML path in the original zip.
 *   3. Build a new minimal xlsx zip using only that sheet's original XML,
 *      carrying over all shared resources (styles, sharedStrings, theme, etc.)
 *      but removing references to the other sheets from workbook.xml.
 *
 * Returns a Buffer, or null if no usable sheet is found.
 */
async function extractFirstSheetBuffer(buffer) {
  const JSZip = (await import("jszip")).default;

  // ── Step 1: determine which sheet index to use (0-based) ──────────────
  const strippedBuffer = await stripFormulasFromBuffer(buffer);
  const source = new ExcelJS.Workbook();
  await source.xlsx.load(strippedBuffer);

  if (source.worksheets.length === 0) return null;

  function nonNullCount(ws) {
    let count = 0;
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.value !== null && cell.value !== undefined) count++;
      });
    });
    return count;
  }

  let sheetIndex = 0;
  const firstCount = nonNullCount(source.worksheets[0]);

  if (firstCount < 3 && source.worksheets.length > 1) {
    const secondCount = nonNullCount(source.worksheets[1]);
    console.log(`│        ℹ️   First sheet "${source.worksheets[0].name}" has ${firstCount} cell(s) — using sheet 2 "${source.worksheets[1].name}" (${secondCount} cells) for upload.`);
    if (secondCount < 3) {
      console.warn(`│        ⚠️  Second sheet also almost blank — upload aborted.`);
      return null;
    }
    sheetIndex = 1;
  }

  if (nonNullCount(source.worksheets[sheetIndex]) < 3) return null;

  // ── Step 2: transplant original sheet XML into a new single-sheet zip ──
  const origZip = await JSZip.loadAsync(buffer);

  // Resolve the correct sheet XML file via workbook.xml + rels.
  // Sorting sheetN.xml filenames by number is NOT reliable — Excel can reorder
  // sheets visually without renumbering the underlying XML files, so
  // sheetPaths[sheetIndex] can point to the wrong sheet in reordered workbooks.
  const wbXml   = await origZip.files["xl/workbook.xml"].async("string");
  const relsXml = await origZip.files["xl/_rels/workbook.xml.rels"].async("string");

  const sheetsBlockM = wbXml.match(/<sheets>([\s\S]*?)<\/sheets>/);
  if (!sheetsBlockM) return null;

  // r:id values for each sheet in visual order (as listed in workbook.xml)
  const sheetRIds = [...sheetsBlockM[1].matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]);
  if (sheetIndex >= sheetRIds.length) return null;

  const targetRId = sheetRIds[sheetIndex];
  const relM = relsXml.match(new RegExp(`Id="${targetRId}"[^>]+Target="([^"]+)"`));
  if (!relM) return null;

  const targetRelPath   = relM[1];               // e.g. "worksheets/sheet2.xml"
  const targetSheetPath = `xl/${targetRelPath}`; // e.g. "xl/worksheets/sheet2.xml"
  const sheetNumM       = targetRelPath.match(/sheet(\d+)\.xml$/i);
  if (!sheetNumM) return null;
  const targetSheetNum  = parseInt(sheetNumM[1]); // 1-based, for internal XML references

  // Build output zip: copy everything except the other sheet XMLs and their rels
  const outZip = new JSZip();

  for (const [filePath, fileObj] of Object.entries(origZip.files)) {
    if (fileObj.dir) continue;

    // Drop worksheets other than our target
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(filePath) && filePath !== targetSheetPath) continue;
    if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(filePath)) {
      const num = parseInt(filePath.match(/sheet(\d+)/)[1]);
      if (num !== targetSheetNum) continue;
    }

    // Rewrite workbook.xml to reference only the chosen sheet
    if (filePath === "xl/workbook.xml") {
      let wbXml = await fileObj.async("string");
      // Keep only the target <sheet> element; renumber it as sheet 1
      wbXml = wbXml.replace(/<sheets>[\s\S]*?<\/sheets>/, (sheetsBlock) => {
        const sheetMatches = [...sheetsBlock.matchAll(/<sheet [^/]*/g)];
        if (sheetMatches.length <= sheetIndex) return sheetsBlock; // safety
        let targetTag = sheetMatches[sheetIndex][0];
        // Renumber r:id to rId1 and sheetId to 1
        targetTag = targetTag
          .replace(/r:id="[^"]*"/, 'r:id="rId1"')
          .replace(/sheetId="[^"]*"/, 'sheetId="1"');
        return `<sheets>${targetTag}/></sheets>`;
      });
      outZip.file(filePath, wbXml);
      continue;
    }

    // Rewrite workbook.xml.rels to keep only the target sheet relationship
    if (filePath === "xl/_rels/workbook.xml.rels") {
      let relsXml = await fileObj.async("string");
      // Find the rId that pointed to the target sheet
      const targetRel = new RegExp(
        `<Relationship[^>]+Id="([^"]+)"[^>]+Target="worksheets/sheet${targetSheetNum}\\.xml"[^>]*/>`
      );
      const m = relsXml.match(targetRel);
      if (m) {
        const origRid = m[1];
        // Keep only this relationship, renamed to rId1
        relsXml = relsXml.replace(
          /<Relationships[^>]*>([\s\S]*?)<\/Relationships>/,
          (_, inner) => {
            const kept = inner
              .split(/(?=<Relationship)/)
              .find((rel) => rel.includes(`Id="${origRid}"`)) ?? "";
            const renumbered = kept
              .replace(`Id="${origRid}"`, 'Id="rId1"')
              .replace(`Target="worksheets/sheet${targetSheetNum}.xml"`, 'Target="worksheets/sheet1.xml"');
            return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${renumbered}</Relationships>`;
          }
        );
      }
      outZip.file(filePath, relsXml);
      continue;
    }

    // Rename target sheet XML to sheet1.xml in the output
    const outPath = filePath === targetSheetPath
      ? "xl/worksheets/sheet1.xml"
      : filePath.replace(`sheet${targetSheetNum}.xml`, "sheet1.xml");

    const data = await fileObj.async("nodebuffer");
    outZip.file(outPath, data);
  }

  const out = await outZip.generateAsync({
    type              : "nodebuffer",
    compression       : "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return out;
}

// ── Alert reply helper ────────────────────────────────────────────────────

const ALERT_SUBJECTS = {
  wrong_extension     : "[แจ้งข้อผิดพลาด] ประเภทไฟล์ไม่ถูกต้อง",
  file_link           : "[แจ้งข้อผิดพลาด] ตรวจพบลิงก์ไฟล์แทนไฟล์จริง",
  zero_score          : "[แจ้งข้อผิดพลาด] คะแนนรวมเป็นศูนย์",
  wrong_date          : "[แจ้งข้อผิดพลาด] วันที่/เดือน/ปีในไฟล์ไม่ถูกต้อง",
  physician_not_found : "[แจ้งข้อผิดพลาด] ไม่พบชื่อแพทย์ในระบบ",
  other           : "[แจ้งข้อผิดพลาด] ไม่สามารถประมวลผลไฟล์ P4P ได้",
};

/**
 * Send an alert-themed HTML reply to the original sender.
 * Silently no-ops if replyTo or messageId is missing.
 *
 * @param {"wrong_extension"|"file_link"|"wrong_date"|"physician_not_found"|"other"} errorType
 * @param {string} safeFilename   HTML-escaped filename (may be empty)
 * @param {string} [detectedDate] Shown for wrong_date errors
 * @param {string} [detectedName] Shown for physician_not_found errors
 * @param {string} replyTo        Sender email address
 * @param {string} messageId      Gmail message ID for thread reply
 * @param {object} gmail          Shared Gmail client
 */
async function sendAlertReply({ errorType = "other", safeFilename = "", detectedDate = "", detectedName = "", replyTo, messageId, gmail }) {
  if (!SEND_ERROR_REPLIES) {
    console.log(`│        ⏸️   Alert reply [${errorType}] suppressed (SEND_ERROR_REPLIES=false)`);
    return;
  }
  if (!replyTo || !messageId) return;
  const subject  = ALERT_SUBJECTS[errorType] ?? ALERT_SUBJECTS.other;
  const htmlReply = buildHtmlErrorReply({ safeFilename, errorType, detectedDate, detectedName });
  try {
    await gmail.sendMessage({
      to              : replyTo,
      subject,
      html            : htmlReply,
      body            : `เรียนผู้ส่ง\n\nระบบไม่สามารถประมวลผลไฟล์ P4P ที่ท่านส่งมาได้\nกรุณาตรวจสอบและส่งใหม่อีกครั้ง`,
      replyToMessageId: messageId,
    });
    console.log(`│        📧  Alert reply [${errorType}] sent to ${replyTo}`);
  } catch (replyErr) {
    console.error(`│        ❌  Alert reply failed: ${replyErr.message}`);
  }
}

// ── Processing pipeline ───────────────────────────────────────────────────

/**
 * Process a single xlsx buffer through Claude → Supabase → Telegram → Drive.
 * Returns true if the full pipeline completed (Claude succeeded), false otherwise.
 *
 * @param {Buffer} buffer
 * @param {object} context
 * @param {string} context.subject
 * @param {string} context.body
 * @param {string} context.filename
 * @param {string} context.replyTo      Sender email address for auto-reply
 * @param {string} context.messageId    Gmail message ID for thread reply
 * @param {object} context.gmail        Shared Gmail client instance
 */
async function processBuffer(buffer, { subject = "", body = "", filename, replyTo = "", messageId = "", emailDate = null, threadId = null, gmail }) {
  /** Shorthand: fire an "other" alert reply for unexpected pipeline errors. */
  const otherReply = () => sendAlertReply({
    errorType   : "other",
    safeFilename: escapeHtml(filename ?? ""),
    replyTo, messageId, gmail,
  });

  // Resolve target month from filename/subject/body before parsing workbook —
  // needed to pick the correct sheet in multi-month workbooks.
  const targetMonth = resolveBeMonth(filename ?? "", subject, body);

  // Parse workbook
  let rows, allSheets, chosenSheet;
  try {
    ({ rows, allSheets, chosenSheet } = await firstSheetToRows(buffer, { targetMonth }));
  } catch (err) {
    console.error(`│        ❌  Failed to parse workbook: ${err.message}`);
    await sendTelegram(formatErrorMessage(`Workbook parse failed: ${err.message}`, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await otherReply();
    return "replied";
  }

  console.log(`│        All sheets : ${allSheets.join(", ")}`);
  console.log(`│        Using sheet: "${chosenSheet}"`);
  console.log(`│        Rows       : ${rows.length}`);

  // ── Corruption checks ────────────────────────────────────────────────
  if (rows.length === 0) {
    const msg = "Workbook parsed but contains no data rows — file may be empty or corrupt.";
    console.error(`│        ❌  ${msg}`);
    await sendTelegram(formatErrorMessage(msg, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await otherReply();
    return "replied";
  }

  const nonNullCount = rows.reduce(
    (n, r) => n + Object.values(r).filter((v) => v !== null).length, 0
  );
  if (nonNullCount < 3) {
    const msg = `Workbook has only ${nonNullCount} non-null cell(s) — likely corrupt or blank.`;
    console.error(`│        ❌  ${msg}`);
    await sendTelegram(formatErrorMessage(msg, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await otherReply();
    return "replied";
  }

  console.log(`│        Non-null cells: ${nonNullCount} ✅`);

  const intermediate = {
    _email_subject  : subject,
    _email_body     : body,
    _email_from     : "",
    _email_date     : new Date().toISOString(),
    _source_file    : filename,
    _selected_sheet : chosenSheet,
    _all_sheets     : allSheets,
    rows,
  };

  // Claude analysis
  console.log(`│        🤖  Sending to Claude for analysis…`);
  let analysis;
  try {
    analysis = await analyseJson(intermediate, filename);
    console.log(`│        ✅  Physician : ${analysis.name}`);
    console.log(`│        ✅  Date      : ${analysis.date}`);
    console.log(`│        ✅  Score     : ${analysis.score.toFixed(2)}`);
    if (analysis.score <= 0) throw new Error("Score is 0 — cannot save a zero score.");
  } catch (err) {
    console.error(`│        ❌  Claude analysis failed: ${err.message}`);
    await sendTelegram(formatErrorMessage(err.message, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    if (/score is 0/i.test(err.message)) {
      await sendAlertReply({ errorType: "zero_score", safeFilename: escapeHtml(filename ?? ""), replyTo, messageId, gmail });
    } else {
      await otherReply();
    }
    return "replied";
  }

  // ── Fuzzy name match (lookup only — score saved after Drive succeeds) ──
  let match = null;
  console.log(`│        🔍  Fuzzy-matching name in Supabase table "${analysis.date}"…`);
  try {
    match = await matchName(analysis.name, analysis.date);
    if (match) {
      console.log(`│        ✅  Best match : "${match.matchedName}" (${(match.similarity * 100).toFixed(0)}% similar)`);
    } else {
      console.log(`│        ⚠️  No sufficiently similar name found.`);
    }
  } catch (dbErr) {
    console.error(`│        ❌  Supabase match error: ${dbErr.message}`);
    const isTableMissing = /does not exist|undefined_table|42P01|schema cache/i.test(dbErr.message);
    if (isTableMissing) {
      console.log(`│        📅  Table "${analysis.date}" not found — sending wrong_date reply`);
    }
    await sendAlertReply({
      errorType   : isTableMissing ? "wrong_date" : "other",
      safeFilename: escapeHtml(filename ?? ""),
      detectedDate: isTableMissing ? escapeHtml(analysis.date) : "",
      replyTo, messageId, gmail,
    });
    await sendTelegram(
      formatErrorMessage(
        isTableMissing
          ? `Table "${analysis.date}" not found — wrong date extracted from ${filename}`
          : `Supabase match error: ${dbErr.message}`,
        filename
      )
    ).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    return "replied";
  }

  // ── Fallback: filename name missed — try names from inside the workbook ──
  // The filename/subject/body pre-scan can yield a wrong name when the sender
  // mis-names the file (department word or month abbrev instead of surname).
  // The correct name is usually still written inside the sheet (a ชื่อแพทย์
  // header cell) or in the sheet tab — retry the match against those before
  // declaring a mismatch.
  if (!match) {
    const fallbackNames = resolvePhysicianNameFromSheet(rows, chosenSheet);
    for (const candidate of fallbackNames) {
      if (candidate === analysis.name) continue;
      let alt;
      try {
        alt = await matchName(candidate, analysis.date);
      } catch { continue; } // table/DB errors already surfaced by the primary match
      if (alt) {
        console.log(`│        🔁  Filename name "${analysis.name}" missed — recovered "${candidate}" from sheet → matched "${alt.matchedName}" (${(alt.similarity * 100).toFixed(0)}%)`);
        analysis.name = candidate;
        match = alt;
        break;
      }
    }
  }

  // ── Upload to Google Drive (must succeed before saving score / archiving) ─
  const drive = getDrive();
  if (drive) {
    if (!match) {
      console.warn(`│        ⚠️  Name mismatch — Drive upload skipped for "${analysis.name}".`);
      await sendTelegram(
        formatErrorMessage(`Name mismatch: "${analysis.name}" not found in table "${analysis.date}" — Drive upload skipped.`, filename)
      ).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    } else {
      const uploadName = match.matchedName;
      console.log(`│        📤  Preparing first-sheet buffer for Drive upload…`);
      try {
        const uploadBuffer = await extractFirstSheetBuffer(buffer);

        if (!uploadBuffer) {
          const msg = "First sheet is blank — Drive upload aborted.";
          console.warn(`│        ⚠️  ${msg}`);
          await sendTelegram(formatErrorMessage(msg, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
          await otherReply();
          return "replied";
        }

        console.log(`│        📤  Uploading as "${uploadName}"…`);
        const { fileName, replaced } = await drive.uploadFile(
          uploadBuffer,
          uploadName,
          analysis.date
        );
        console.log(`│        ✅  Drive upload: "${fileName}" (${replaced ? "replaced existing" : "new file"})`);
      } catch (driveErr) {
        console.error(`│        ❌  Drive upload failed: ${driveErr.message}`);
        await sendTelegram(
          formatErrorMessage(`Drive upload failed: ${driveErr.message}`, filename)
        ).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
        await otherReply();
        return "replied";  // ← do not archive, do not save score
      }
    }
  }

  // ── Save score to Supabase (only after Drive upload confirmed) ────────
  let scoreSaved = false;
  if (match) {
    try {
      await saveScore(analysis.date, match.index, analysis.score, ts.toISOString())
      scoreSaved = true;
      console.log(`│        💾  Score ${analysis.score.toFixed(2)} saved → table "${analysis.date}", row ${match.index}`);
    } catch (dbErr) {
      console.error(`│        ❌  Supabase save error: ${dbErr.message}`);
    }
  }

  // ── Log submission for punctuality tracking ───────────────────────────
  if (scoreSaved) {
    try {
      const ts = emailDate ? new Date(emailDate) : new Date();
      await logSubmission({
        physicianName: match.matchedName,
        department   : match.department ?? "",
        workMonth    : analysis.date,
        submittedAt  : ts.toISOString(),
        threadId     : threadId ?? null,
        filename     : filename ?? null,
      });
      console.log(`│        📊  Submission logged (punctuality)`);
    } catch (logErr) {
      console.warn(`│        ⚠️  Submission log skipped (non-fatal): ${logErr.message}`);
    }
  }

  // ── Telegram success notification ─────────────────────────────────────
  console.log(`│        📨  Sending to Telegram…`);
  try {
    await sendTelegram(formatResultMessage({
      name       : analysis.name,
      matchedName: match?.matchedName ?? null,
      similarity : match?.similarity  ?? null,
      date       : analysis.date,
      score      : analysis.score.toFixed(2),
      saved      : scoreSaved,
    }, filename));
    console.log(`│        ✅  Telegram message sent.`);
  } catch (tgErr) {
    console.error(`│        ❌  Telegram error: ${tgErr.message}`);
  }

  // ── Auto-reply to sender ──────────────────────────────────────────────
  if (replyTo && messageId) {
    if (!match) {
      await sendAlertReply({
        errorType   : "physician_not_found",
        safeFilename: escapeHtml(filename ?? ""),
        detectedName: escapeHtml(analysis.name ?? ""),
        replyTo, messageId, gmail,
      });
    } else {
      const [beYear, monthNum] = analysis.date.split("_");
      const thaiMonth  = THAI_MONTHS[parseInt(monthNum, 10)] || monthNum;
      const displayDate = `${thaiMonth} ${beYear}`;

      // Build display name: "prefix firstname  lastname" (1 space after prefix, 2 between names)
      const prefix = match.prefix ? `${match.prefix.trim()} ` : "";
      const nameParts = match.matchedName.trim().split(/\s+/);
      const spacedName = nameParts.length >= 2
        ? `${nameParts[0]}  ${nameParts.slice(1).join("  ")}`
        : match.matchedName;
      const displayName    = `${prefix}${spacedName}`;
      const department     = match.department ?? "";
      // Escape all user-derived values before HTML interpolation (XSS prevention)
      const safeDisplayName = escapeHtml(displayName);
      const safeDepartment  = escapeHtml(department);
      const safeDisplayDate = escapeHtml(displayDate);
      const safeScore       = escapeHtml(analysis.score.toFixed(2));

      const htmlReply = buildHtmlReply({ displayName: safeDisplayName, safeDepartment, safeDisplayDate, safeScore });

      console.log(`│        📧  Sending auto-reply to ${replyTo}…`);
      try {
        await gmail.sendMessage({
          to              : replyTo,
          subject         : `องค์กรแพทย์ รพ. สค.`,
          html            : htmlReply,
          body            : `เรียน ${displayName}\n\nองค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว\n\nชื่อแพทย์: ${displayName}\nเดือน/ปี: ${displayDate}\nคะแนนรวม: ${analysis.score.toFixed(2)}\n\nขอบคุณที่ให้ความร่วมมือเป็นอย่างดี`,  // plain text — no escaping needed
          replyToMessageId: messageId,
        });
        console.log(`│        ✅  Auto-reply sent to ${replyTo}`);
      } catch (replyErr) {
        console.error(`│        ❌  Auto-reply failed: ${replyErr.message}`);
      }
    }
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Download and process a single Excel attachment through the full pipeline.
 * Extracted so multiple attachments can be processed in parallel via Promise.allSettled.
 */
async function processAttachment(att, messageId, context, gmail) {
  const excel = isExcelFile(att.mimeType, att.filename);

  console.log(`│`);
  console.log(`│      • ${att.filename}`);
  console.log(`│        MIME type : ${att.mimeType}`);
  console.log(`│        Size      : ${formatSize(att.size)}`);
  console.log(`│        Excel?    : ${excel ? "✅  Yes" : "❌  No — skipping"}`);

  if (!excel) return false;

  let buffer;
  try {
    buffer = await gmail.downloadAttachment(messageId, att.attachmentId);
  } catch (err) {
    console.error(`│        ❌  Download failed: ${err.message}`);
    await sendAlertReply({
      errorType   : "other",
      safeFilename: escapeHtml(att.filename ?? ""),
      replyTo     : context.replyTo,
      messageId,
      gmail,
    });
    return "replied";
  }

  return processBuffer(buffer, { ...context, filename: att.filename, gmail });
}

async function main() {
  // Fail fast if any required env var is missing
  const { absentOptional } = checkEnv();
  if (absentOptional.length > 0) {
    log.info(`Optional env vars not set: ${absentOptional.join(", ")}`);
  }

  const gmail = createGmailClient();

  // ── Resolve "เอกสาร P4P" label ID once ───────────────────────────────
  // Used to tag processed messages. If the label doesn't exist yet,
  // create it in Gmail first (Settings → Labels → Create new label).
  const P4P_LABEL_NAME = "เอกสาร P4P";
  let p4pLabelId = null;
  try {
    const matched = await gmail.listLabels(P4P_LABEL_NAME);
    const label   = matched.find((l) => l.name === P4P_LABEL_NAME) ?? matched[0];
    if (label) {
      p4pLabelId = label.id;
      console.log(`🏷️   Label "${P4P_LABEL_NAME}" resolved (${p4pLabelId})`);
    } else {
      console.warn(`⚠️   Label "${P4P_LABEL_NAME}" not found — messages will not be labelled.`);
    }
  } catch (err) {
    console.warn(`⚠️   Could not resolve label: ${err.message}`);
  }

  // ── Fetch messages from INBOX, SPAM, and JUNK ────────────────────────
  // in:inbox / in:spam  → scope to folder
  // -is:starred         → not already processed
  // -has:userlabels     → not tagged with any user-created label
  // is:unread           → only new, unread messages
  const INBOX_QUERY = "in:inbox -is:starred -has:userlabels is:unread";
  const SPAM_QUERY  = "-is:starred -has:userlabels is:unread";

  console.log(`\n🔍  Fetching messages — INBOX …`);
  const inboxMessages = await gmail.listMessages({
    labelIds  : "INBOX",
    query     : INBOX_QUERY,
    maxResults: MAX_MESSAGES,
  });

  console.log(`🔍  Fetching messages — SPAM / Junk …`);
  const spamMessages = await gmail.listMessages({
    labelIds  : "SPAM",
    query     : SPAM_QUERY,
    maxResults: MAX_MESSAGES,
  });

  // Tag each message with its source folder so we can remove the right label later
  const messages = [
    ...inboxMessages.map((m) => ({ ...m, _sourceLabel: "INBOX" })),
    ...spamMessages.map((m) => ({ ...m, _sourceLabel: "SPAM" })),
  ];

  if (messages.length === 0) {
    console.log(`\n📭  No new unread unlabeled messages found (inbox + spam).`);
    console.log(`\n✅  Done.`);
    return;
  }

  console.log(`\n📬  ${messages.length} message(s) found (${inboxMessages.length} inbox, ${spamMessages.length} spam/junk):\n`);

  for (let i = 0; i < messages.length; i++) {
    const { id, _sourceLabel } = messages[i];
    const { msg, attachments } = await gmail.getMessageWithAttachments(id);

    const msgBody   = msg.body?.trim() ?? "";
    const fromRaw   = msg.from ?? "";
    const fromEmail = (fromRaw.match(/<(.+?)>/) ?? [, fromRaw])[1].trim().toLowerCase();

    console.log(`┌─ [${i + 1}/${messages.length}] [${_sourceLabel}] ──────────────────────────────────────────`);
    console.log(`│  Date:     ${msg.date}`);
    console.log(`│  From:     ${msg.from}`);
    console.log(`│  Subject:  ${msg.subject}`);
    console.log(`│  Body:     ${msgBody.slice(0, 120).replace(/\n/g, " ")}${msgBody.length > 120 ? "…" : ""}`);

    if (SKIP_SENDERS.has(fromEmail)) {
      // Relay senders (e.g. sakhonmso@gmail.com) forward/reply to physician emails.
      // Instead of skipping, search the thread for an xlsx from the original sender.
      if (THREAD_RELAY_SENDERS.has(fromEmail) && msg.threadId) {
        console.log(`│  🔄  Relay sender — searching thread for xlsx from original messages…`);
        let relayProcessed = false;
        try {
          const threadMsgs = await gmail.getThreadMessages(msg.threadId);
          for (const tm of [...threadMsgs].reverse()) {
            if (tm.msg.id === id) continue;
            const tmEmail = (tm.msg.from.match(/<(.+?)>/) ?? [, tm.msg.from])[1].trim().toLowerCase();
            if (THREAD_RELAY_SENDERS.has(tmEmail)) continue; // skip other relay messages
            const xlsxInMsg = tm.attachments.filter((a) => isExcelFile(a.mimeType, a.filename));
            if (xlsxInMsg.length > 0) {
              console.log(`│  📎  Found xlsx in thread — original sender: ${tm.msg.from}`);
              const relayContext = {
                subject  : tm.msg.subject || msg.subject,
                body     : tm.msg.body    || msgBody,
                replyTo  : tmEmail,   // reply to the original physician, not the relay
                messageId: id,        // thread-link to the current (relay) message
                emailDate: msg.date,
                threadId : msg.threadId,
              };
              const results = await Promise.allSettled(
                xlsxInMsg.map((att) => processAttachment(att, tm.msg.id, relayContext, gmail))
              );
              relayProcessed = results.some((r) => r.status === "fulfilled" && r.value === true);
              results.forEach((r, idx) => {
                if (r.status === "rejected") {
                  console.error(`│      ❌  Relay attachment[${idx}] threw: ${r.reason?.message ?? r.reason}`);
                }
              });
              if (relayProcessed) {
                const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
                const removeLabels = ["UNREAD", _sourceLabel];
                try {
                  await gmail.modifyMessage(id, addLabels, removeLabels);
                  console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
                } catch (err) {
                  console.error(`│  ❌  Failed to update message labels: ${err.message}`);
                }
              }
              break;
            }
          }
        } catch (err) {
          console.warn(`│  ⚠️   Relay thread search failed: ${err.message}`);
        }
        if (!relayProcessed) {
          console.log(`│  📭  No xlsx found in thread from original sender — skipping`);
        }
      } else {
        console.log(`│  ⏭️   Sender is on the skip list — skipping.`);
      }
      console.log(`└────────────────────────────────────────────────────────────\n`);
      continue;
    }

    let processedAnyAttachment = false;

    // ── Pre-flight error checks ───────────────────────────────────────────
    // Classify message-level issues before touching attachments.
    // Only send an alert reply when no xlsx file is present — if xlsx
    // files exist alongside other attachments, process normally.
    const xlsxAtts  = attachments.filter((a) => isExcelFile(a.mimeType, a.filename));
    const otherAtts = attachments.filter((a) => !isExcelFile(a.mimeType, a.filename));

    if (xlsxAtts.length === 0) {
      // ── Thread search: look for xlsx in earlier messages of this thread ──
      let threadXlsx = null; // { messageId, att }
      if (msg.threadId) {
        try {
          const threadMsgs = await gmail.getThreadMessages(msg.threadId);
          // Iterate newest-first so we pick the most recent xlsx in the thread
          for (const tm of [...threadMsgs].reverse()) {
            if (tm.msg.id === id) continue; // already checked current message
            const found = tm.attachments.filter((a) => isExcelFile(a.mimeType, a.filename));
            if (found.length > 0) {
              threadXlsx = { messageId: tm.msg.id, atts: found };
              break;
            }
          }
        } catch (err) {
          console.warn(`│  ⚠️   Thread search failed: ${err.message}`);
        }
      }

      if (threadXlsx) {
        console.log(`│  🔍  No xlsx in this message — found xlsx in thread (message ${threadXlsx.messageId})`);
        console.log(`│  📎  ${threadXlsx.atts.length} xlsx attachment(s) from thread:`);
        const context = {
          subject  : msg.subject,
          body     : msgBody,
          replyTo  : fromEmail,
          messageId: id,
          emailDate: msg.date,
          threadId : msg.threadId,
        };
        const results = await Promise.allSettled(
          threadXlsx.atts.map((att) => processAttachment(att, threadXlsx.messageId, context, gmail))
        );
        processedAnyAttachment = results.some(
          (r) => r.status === "fulfilled" && r.value === true
        );
        results.forEach((r, idx) => {
          if (r.status === "rejected") {
            console.error(`│      ❌  Thread attachment[${idx}] threw: ${r.reason?.message ?? r.reason}`);
          }
        });
        if (processedAnyAttachment) {
          const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
          const removeLabels = ["UNREAD", _sourceLabel];
          try {
            await gmail.modifyMessage(id, addLabels, removeLabels);
            console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
          } catch (err) {
            console.error(`│  ❌  Failed to update message labels: ${err.message}`);
          }
        }
        console.log(`└────────────────────────────────────────────────────────────\n`);
        continue;
      }

      let alertSent = false;
      if (CLOUD_LINK_RE.test(msgBody)) {
        // Sender pasted a cloud-storage link instead of attaching the file
        console.log(`│  ⚠️   No xlsx found — cloud link detected in body → sending file_link alert`);
        await sendAlertReply({ errorType: "file_link", safeFilename: "", replyTo: fromEmail, messageId: id, gmail });
        alertSent = true;
      } else if (otherAtts.length > 0) {
        // Sender attached a file but in the wrong format (.xls, .ods, …)
        const names = escapeHtml(otherAtts.map((a) => a.filename).join(", "));
        console.log(`│  ⚠️   No xlsx found — wrong extension(s): ${otherAtts.map((a) => a.filename).join(", ")} → sending wrong_extension alert`);
        await sendAlertReply({ errorType: "wrong_extension", safeFilename: names, replyTo: fromEmail, messageId: id, gmail });
        alertSent = true;
      } else {
        console.log(`│  📎  No attachments and no cloud link — skipping`);
      }
      if (alertSent) {
        const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
        const removeLabels = ["UNREAD", _sourceLabel];
        try {
          await gmail.modifyMessage(id, addLabels, removeLabels);
          console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
        } catch (err) {
          console.error(`│  ❌  Failed to update message labels: ${err.message}`);
        }
      }
      console.log(`└────────────────────────────────────────────────────────────\n`);
      continue;
    }

    console.log(`│  📎  ${attachments.length} attachment(s):`);

    // Process all Excel attachments in parallel — faster for messages with multiple files
    // Use fromEmail (plain addr) not msg.from (full header) for replyTo —
    // the full From: header can contain RFC 2047-encoded display names in many
    // formats; using just the address avoids any encoding issue in To: header.
    const context = {
      subject  : msg.subject,
      body     : msgBody,
      replyTo  : fromEmail,
      messageId: id,
      emailDate: msg.date,
      threadId : msg.threadId,
    };
    const results = await Promise.allSettled(
      attachments.map((att) => processAttachment(att, id, context, gmail))
    );
    processedAnyAttachment = results.some(
      (r) => r.status === "fulfilled" && r.value === true
    );
    const repliedToAny = results.some(
      (r) => r.status === "fulfilled" && r.value === "replied"
    );
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        console.error(`│      ❌  Attachment[${idx}] threw: ${r.reason?.message ?? r.reason}`);
      }
    });

    // ── Mark message: read + starred + labeled ────────────────────────
    // Applied after a successful processing OR after an alert reply was sent.
    if (processedAnyAttachment || repliedToAny) {
      const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
      const removeLabels = ["UNREAD", _sourceLabel];
      try {
        await gmail.modifyMessage(id, addLabels, removeLabels);
        console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
      } catch (err) {
        console.error(`│  ❌  Failed to update message labels: ${err.message}`);
      }
    }

    console.log(`└────────────────────────────────────────────────────────────\n`);
  }

  console.log(`\n✅  Done.`);
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  process.exit(1);
});