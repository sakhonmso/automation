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
import { analyseJson }                   from "./claude-analyst.js";
import { matchName, saveScore }          from "./supabase-client.js";
import { sendTelegram, formatResultMessage, formatErrorMessage } from "./telegram.js";
import * as path                         from "path";
import ExcelJS                           from "exceljs";
import "dotenv/config";

// Lazy Drive client — only initialised if P4P_FOLDER_ID is set
let _drive = null;
function getDrive() {
  if (!process.env.P4P_FOLDER_ID) return null;
  if (!_drive) _drive = createDriveClient();
  return _drive;
}

const MAX_MESSAGES = 10;

// Messages from these senders are ignored entirely
const SKIP_SENDERS = new Set([
  "sakhonmso@gmail.com",
  "p4pskh@gmail.com",
]);

// MIME types AND extensions that we treat as Excel files (.xlsx only)
const EXCEL_MIMETYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/wps-office.xlsx",                                         // WPS variant
]);

function isExcelFile(mimeType, filename) {
  if (EXCEL_MIMETYPES.has(mimeType)) return true;
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

/**
 * Load any Excel buffer with ExcelJS and convert the FIRST sheet to row objects.
 *
 * Uses row.eachCell (not row.values) so we access the real Cell object and can
 * call cell.result directly. This fixes cm="1" (Excel 365 dynamic array formula)
 * cells where row.values returns a formula-object with result=0 even when the
 * actual cached <v> element contains the correct non-zero value.
 */
async function firstSheetToRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const allSheets = workbook.worksheets.map((ws) => ws.name);
  if (allSheets.length === 0) throw new Error("Workbook has no sheets.");

  const worksheet = workbook.worksheets[0];
  const rows = [];

  worksheet.eachRow((row) => {
    if (!row.hasValues) return;

    const obj = {};

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = `col_${colNumber}`;

      const val = cell.value;
      const isFormula = val !== null && typeof val === "object" && "formula" in val;

      if (isFormula) {
        const r = cell.result;
        if (r === null || r === undefined) {
          obj[key] = null;
        } else if (r instanceof Date) {
          obj[key] = r.toISOString();
        } else {
          obj[key] = r;
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

  return { rows, allSheets, chosenSheet: allSheets[0] };
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

      // Extract cached value from <v>...</v>
      const vMatch = inner.match(/<v>([^<]*)<\/v>/);
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

  // Find all sheet XML paths in order (sheet1.xml, sheet2.xml, …)
  const sheetPaths = Object.keys(origZip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)[1]);
      const nb = parseInt(b.match(/(\d+)/)[1]);
      return na - nb;
    });

  if (sheetIndex >= sheetPaths.length) return null;

  const targetSheetPath = sheetPaths[sheetIndex]; // e.g. "xl/worksheets/sheet2.xml"
  const targetSheetNum  = sheetIndex + 1;          // 1-based, for internal XML references

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
async function processBuffer(buffer, { subject = "", body = "", filename, replyTo = "", messageId = "", gmail }) {
  // Parse workbook
  let rows, allSheets, chosenSheet;
  try {
    ({ rows, allSheets, chosenSheet } = await firstSheetToRows(buffer));
  } catch (err) {
    console.error(`│        ❌  Failed to parse workbook: ${err.message}`);
    await sendTelegram(formatErrorMessage(`Workbook parse failed: ${err.message}`, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    return false;
  }

  console.log(`│        All sheets : ${allSheets.join(", ")}`);
  console.log(`│        Using sheet: "${chosenSheet}" (first sheet)`);
  console.log(`│        Rows       : ${rows.length}`);

  // ── Corruption checks ────────────────────────────────────────────────
  if (rows.length === 0) {
    const msg = "Workbook parsed but contains no data rows — file may be empty or corrupt.";
    console.error(`│        ❌  ${msg}`);
    await sendTelegram(formatErrorMessage(msg, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    return false;
  }

  const nonNullCount = rows.reduce(
    (n, r) => n + Object.values(r).filter((v) => v !== null).length, 0
  );
  if (nonNullCount < 3) {
    const msg = `Workbook has only ${nonNullCount} non-null cell(s) — likely corrupt or blank.`;
    console.error(`│        ❌  ${msg}`);
    await sendTelegram(formatErrorMessage(msg, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    return false;
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
    console.log(`│        ✅  Score     : ${analysis.score}`);
  } catch (err) {
    console.error(`│        ❌  Claude analysis failed: ${err.message}`);
    await sendTelegram(formatErrorMessage(err.message, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    return false;
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
    sendTelegram(formatErrorMessage(`Supabase match error: ${dbErr.message}`, filename))
      .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
  }

  // ── Upload to Google Drive (must succeed before saving score / archiving) ─
  const drive = getDrive();
  if (drive) {
    const uploadName = match?.matchedName ?? analysis.name;
    console.log(`│        📤  Preparing first-sheet buffer for Drive upload…`);
    try {
      const uploadBuffer = await extractFirstSheetBuffer(buffer);

      if (!uploadBuffer) {
        const msg = "First sheet is blank — Drive upload aborted.";
        console.warn(`│        ⚠️  ${msg}`);
        await sendTelegram(formatErrorMessage(msg, filename)).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
        return false;
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
      return false;  // ← do not archive, do not save score
    }
  }

  // ── Save score to Supabase (only after Drive upload confirmed) ────────
  let scoreSaved = false;
  if (match) {
    try {
      await saveScore(analysis.date, match.index, parseFloat(analysis.score));
      scoreSaved = true;
      console.log(`│        💾  Score ${analysis.score} saved → table "${analysis.date}", row ${match.index}`);
    } catch (dbErr) {
      console.error(`│        ❌  Supabase save error: ${dbErr.message}`);
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
      score      : analysis.score,
      saved      : scoreSaved,
    }, filename));
    console.log(`│        ✅  Telegram message sent.`);
  } catch (tgErr) {
    console.error(`│        ❌  Telegram error: ${tgErr.message}`);
  }

  // ── Auto-reply to sender ──────────────────────────────────────────────
  if (replyTo && messageId) {
    const THAI_MONTHS = [
      "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
      "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
      "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
    ];
    const [beYear, monthNum] = analysis.date.split("_");
    const thaiMonth  = THAI_MONTHS[parseInt(monthNum, 10)] || monthNum;
    const displayDate = `${thaiMonth} ${beYear}`;

    // Build display name: "prefix firstname  lastname" (1 space after prefix, 2 between names)
    const prefix = match?.prefix ? `${match.prefix.trim()} ` : "";
    const baseName = match?.matchedName ?? analysis.name;
    const nameParts = baseName.trim().split(/\s+/);
    const spacedName = nameParts.length >= 2
      ? `${nameParts[0]}  ${nameParts.slice(1).join("  ")}`
      : baseName;
    const displayName    = `${prefix}${spacedName}`;
    const department     = match?.department ?? "";
    // Escape all user-derived values before HTML interpolation (XSS prevention)
    const safeDisplayName = escapeHtml(displayName);
    const safeDepartment  = escapeHtml(department);
    const safeDisplayDate = escapeHtml(displayDate);
    const safeScore       = escapeHtml(analysis.score);

    const htmlReply = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#e6f2ec;font-family:'Sarabun',sans-serif;font-size:15px;color:#1a2e22;padding:32px 16px}
  .card{background:#fff;max-width:540px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(5,104,57,.15)}
  .header{background:linear-gradient(135deg,#056839,#0a8a4a);padding:28px 32px}
  .header h1{color:#fff;font-size:19px;font-weight:600;letter-spacing:.2px}
  .header p{color:#a8d5bc;font-size:13px;margin-top:5px;font-weight:400}
  .body{padding:28px 32px}
  .greeting{font-size:17px;color:#056839;font-weight:600;margin-bottom:14px}
  .intro{line-height:1.8;color:#3a5a44;margin-bottom:22px;font-size:15px}
  .line-btn{display:block;background:#06c755;border-radius:10px;padding:13px 20px;margin-bottom:24px;text-decoration:none}
  .line-btn span{color:#fff;font-weight:600;font-size:14px;letter-spacing:.2px}
  .detail-card{background:#eef7f2;border-left:4px solid #056839;border-radius:0 10px 10px 0;padding:18px 22px;margin-bottom:24px}
  .detail-title{font-size:11.5px;font-weight:700;color:#6a9e7e;text-transform:uppercase;letter-spacing:.7px;margin-bottom:13px}
  table{width:100%;border-collapse:collapse}
  td{padding:9px 0;font-size:14px;vertical-align:middle}
  td:first-child{color:#4a7a5a;width:42%}
  td:last-child{font-weight:600;color:#033d21;text-align:right}
  tr+tr td{border-top:1px solid #cce8d8}
  .score-val{font-size:14px;color:#056839;font-weight:700}
  .thanks{color:#3a5a44;line-height:1.8;font-size:15px;margin-bottom:8px}
  .footer{border-top:1px solid #d4ebe0;padding:15px 32px;background:#f4fbf7;text-align:center;font-size:12px;color:#7aaa8a}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div>
        <h1>แจ้งผลการส่ง P4P ของแพทย์<br>โรงพยาบาลสมุทรสาคร</h1>
        <p>อีเมลตอบกลับอัตโนมัติ</p>
      </div>
    </div>
  </div>
  <div class="body">
    <p class="greeting">เรียน ${safeDisplayName}</p>
    <p class="intro">
      องค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว<br>
      ท่านสามารถตรวจสอบสถานะการส่งได้ที่
    </p>
    <a href="https://line.me/R/ti/p/%40703emfui" class="line-btn">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" valign="middle">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">
                  <img src="https://upload.wikimedia.org/wikipedia/commons/4/41/LINE_logo.svg" width="28" height="28" alt="LINE" style="display:block;border-radius:6px;background:#fff;padding:2px"/>
                </td>
                <td width="12"></td>
                <td valign="middle" style="color:#fff;font-weight:600;font-size:14px;letter-spacing:.2px;white-space:nowrap">LINE OA : SAKHONMSO</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </a>
    <div class="detail-card">
      <div class="detail-title">รายละเอียดไฟล์</div>
      <table>
        <tr>
          <td>ชื่อแพทย์</td>
          <td>${safeDisplayName}</td>
        </tr>
        ${safeDepartment ? `<tr>
          <td>กลุ่มงาน</td>
          <td>${safeDepartment}</td>
        </tr>` : ""}
        <tr>
          <td>เดือน / ปี</td>
          <td>${safeDisplayDate}</td>
        </tr>
        <tr>
          <td>คะแนนรวม</td>
          <td class="score-val">${safeScore}</td>
        </tr>
      </table>
    </div>
    <p class="thanks">ขอบคุณที่ให้ความร่วมมือเป็นอย่างดี</p>
    <p style="margin-top:18px;font-size:13px;color:#7a9a82;line-height:1.7;border-top:1px solid #d4ebe0;padding-top:16px;font-style:italic">
      <strong style="color:#056839;font-style:normal">หมายเหตุ</strong> หากท่านส่งไฟล์ฉบับแก้ไข หรือส่งไฟล์เดิมซ้ำ ระบบจะจัดเก็บไฟล์ใหม่นี้ แทนที่ไฟล์ของเดิม ทั้งนี้ เมื่อมีการเซ็นชื่อแล้ว จะไม่สามารถเปลี่ยนแปลงข้อมูลได้
    </p>
  </div>
  <div class="footer">อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ กรุณาอย่าตอบกลับ</div>
</div>
</body>
</html>`;

    console.log(`│        📧  Sending auto-reply to ${replyTo}…`);
    try {
      await gmail.sendMessage({
        to              : replyTo,
        subject         : `องค์กรแพทย์ รพ. สค.`,
        html            : htmlReply,
        body            : `เรียน ${displayName}\n\nองค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว\n\nชื่อแพทย์: ${displayName}\nเดือน/ปี: ${displayDate}\nคะแนนรวม: ${analysis.score}\n\nขอบคุณที่ให้ความร่วมมือเป็นอย่างดี`,  // plain text — no escaping needed
        replyToMessageId: messageId,
      });
      console.log(`│        ✅  Auto-reply sent to ${replyTo}`);
    } catch (replyErr) {
      console.error(`│        ❌  Auto-reply failed: ${replyErr.message}`);
    }
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
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

  // ── Build query — new inbox emails only ───────────────────────────────
  // in:inbox        → not archived
  // -is:starred     → not starred
  // -has:userlabels → not tagged with any user-created label
  // is:unread       → only new, unread messages
  const INBOX_QUERY = "in:inbox -is:starred -has:userlabels is:unread";

  console.log(`\n🔍  Fetching messages — query: "${INBOX_QUERY}" …`);

  const messages = await gmail.listMessages({
    labelIds  : "INBOX",
    query     : INBOX_QUERY,
    maxResults: MAX_MESSAGES,
  });

  if (messages.length === 0) {
    console.log(`\n📭  No new unread unlabeled inbox messages found.`);
    console.log(`\n✅  Done.`);
    return;
  }

  console.log(`\n📬  ${messages.length} message(s) found:\n`);

  for (let i = 0; i < messages.length; i++) {
    const { id } = messages[i];
    const { msg, attachments } = await gmail.getMessageWithAttachments(id);

    const bodyPreview = msg.body.trim();
    const fromEmail   = (msg.from.match(/<(.+?)>/) ?? [, msg.from])[1].trim().toLowerCase();

    console.log(`┌─ [${i + 1}/${messages.length}] ──────────────────────────────────────────`);
    console.log(`│  Date:     ${msg.date}`);
    console.log(`│  From:     ${msg.from}`);
    console.log(`│  Subject:  ${msg.subject}`);
    console.log(`│  Body:     ${bodyPreview.slice(0, 120).replace(/\n/g, " ")}${bodyPreview.length > 120 ? "…" : ""}`);

    if (SKIP_SENDERS.has(fromEmail)) {
      console.log(`│  ⏭️   Sender is on the skip list — skipping.`);
      console.log(`└────────────────────────────────────────────────────────────\n`);
      continue;
    }

    let processedAnyAttachment = false;

    if (attachments.length === 0) {
      console.log(`│  📎  No attachments`);
    } else {
      console.log(`│  📎  ${attachments.length} attachment(s):`);

      for (const att of attachments) {
        const excel = isExcelFile(att.mimeType, att.filename);

        console.log(`│`);
        console.log(`│      • ${att.filename}`);
        console.log(`│        MIME type : ${att.mimeType}`);
        console.log(`│        Size      : ${formatSize(att.size)}`);
        console.log(`│        Excel?    : ${excel ? "✅  Yes" : "❌  No — skipping"}`);

        if (!excel) continue;

        let buffer;
        try {
          buffer = await gmail.downloadAttachment(id, att.attachmentId);
        } catch (err) {
          console.error(`│        ❌  Download failed: ${err.message}`);
          continue;
        }

        const succeeded = await processBuffer(buffer, {
          subject  : msg.subject,
          body     : msg.body.trim(),
          filename : att.filename,
          replyTo  : msg.from,
          messageId: id,
          gmail,
        });

        if (succeeded) processedAnyAttachment = true;
      }
    }

    // ── Mark message: read + starred + labeled ────────────────────────
    // Only applied after at least one xlsx attachment was processed.
    // Prevents false-tagging emails that had no usable attachments.
    if (processedAnyAttachment) {
      const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
      const removeLabels = ["UNREAD", "INBOX"];
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