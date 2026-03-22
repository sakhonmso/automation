/**
 * index.js
 *
 * - Fetches up to 10 messages labelled "เอกสาร P4P"
 * - For .xlsx and .xls attachments: converts the FIRST sheet to JSON using ExcelJS
 *   Note: ExcelJS supports .xlsx (OOXML) fully. Truly legacy binary .xls files
 *   (BIFF format) are not supported — a clear error is reported if encountered.
 * - Sends to Claude API to extract: physician name, workload date (BE), total score
 * - Saves result to ./JSON/ as { name, date, score, matched }
 *
 *   npm start
 */

import { createGmailClient }   from "./gmail-client.js";
import { analyseJson }          from "./claude-analyst.js";
import { checkNameInSupabase }  from "./supabase-client.js";
import * as fs                  from "fs";
import * as path                from "path";
import ExcelJS                  from "exceljs";
import "dotenv/config";

const MAX_MESSAGES = 10;
const JSON_DIR     = "./JSON";

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

/** Sanitise a string for use as a filename */
function safeName(str) {
  if (!str) return "unnamed";
  return String(str).replace(/[/\\?%*:|"<>\s]/g, "_").slice(0, 80);
}

// ── Excel loading (ExcelJS only) ──────────────────────────────────────────

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

      // Detect formula cells by checking for the 'formula' property on cell.value.
      // This is safer than relying on cell.type === 6 (an internal ExcelJS enum
      // value that could change across versions). For formula cells we always use
      // cell.result — the cached computed value — to avoid cm="1" dynamic array
      // formula cells returning 0 when the actual cached <v> is non-zero.
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const gmail = createGmailClient();

  // ── 1. Build query — new inbox emails only ────────────────────────────
  // in:inbox        → not archived
  // -is:starred     → not starred
  // -has:userlabels → not tagged with any user-created label
  // is:unread       → only new, unread messages
  const INBOX_QUERY = "in:inbox -is:starred -has:userlabels is:unread";

  console.log(`\n🔍  Fetching messages — query: "${INBOX_QUERY}" …`);

  // ── 2. Fetch messages ─────────────────────────────────────────────────
  const messages = await gmail.listMessages({
    labelIds : "INBOX",
    query    : INBOX_QUERY,
    maxResults: MAX_MESSAGES,
  });

  if (messages.length === 0) {
    console.log(`\n📭  No new unread unlabeled inbox messages found.`);
    return;
  }

  console.log(`\n📬  ${messages.length} message(s) found:\n`);
  fs.mkdirSync(JSON_DIR, { recursive: true });

  // ── 3. Process each message ───────────────────────────────────────────
  for (let i = 0; i < messages.length; i++) {
    const { id } = messages[i];

    // Single API call returns both decoded fields AND attachment list
    const { msg, attachments } = await gmail.getMessageWithAttachments(id);

    const bodyPreview = msg.body.trim();

    // Extract bare email address from "Display Name <email@example.com>" format
    const fromEmail = (msg.from.match(/<(.+?)>/) ?? [, msg.from])[1].trim().toLowerCase();

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

        // ── Download & parse ───────────────────────────────────────────
        let rows, allSheets, chosenSheet;
        try {
          const buffer = await gmail.downloadAttachment(id, att.attachmentId);
          ({ rows, allSheets, chosenSheet } = await firstSheetToRows(buffer));
        } catch (err) {
          const isXls = path.extname(att.filename).toLowerCase() === ".xls";
          const hint  = isXls
            ? " (.xls binary format is not supported by ExcelJS — ask sender to resave as .xlsx)"
            : "";
          console.error(`│        ❌  Failed to parse workbook: ${err.message}${hint}`);
          continue;
        }

        console.log(`│        All sheets : ${allSheets.join(", ")}`);
        console.log(`│        Using sheet: "${chosenSheet}" (first sheet)`);
        console.log(`│        Rows       : ${rows.length}`);

        if (rows.length === 0) {
          console.log(`│        ⚠️  Sheet is empty — skipping.`);
          try { fs.unlinkSync(path.join(JSON_DIR, `temp_${safeName(att.filename)}_*.json`)); } catch (_) {}
          continue;
        }

        // ── Build and save intermediate JSON with temp name ───────────
        const intermediate = {
          _email_subject  : msg.subject,
          _email_body     : msg.body.trim(),
          _email_from     : msg.from,
          _email_date     : msg.date,
          _source_file    : att.filename,
          _selected_sheet : chosenSheet,
          _all_sheets     : allSheets,
          rows,
        };

        // Use a temp filename until Claude returns name + date
        const tempFilename = `temp_${safeName(att.filename)}_${Date.now()}.json`;
        let   dest         = path.join(JSON_DIR, tempFilename);
        fs.writeFileSync(dest, JSON.stringify(intermediate, null, 2), "utf8");
        console.log(`│        💾  Saved  → ${dest}`);

        // ── Claude analysis ────────────────────────────────────────────
        console.log(`│        🤖  Sending to Claude for analysis…`);
        try {
          const analysis = await analyseJson(intermediate, att.filename);

          console.log(`│        ✅  Physician : ${analysis.name}`);
          console.log(`│        ✅  Date      : ${analysis.date}`);
          console.log(`│        ✅  Score     : ${analysis.score}`);

          // ── Supabase name match ────────────────────────────────────
          let matchResult = "unknown";
          console.log(`│        🔍  Checking name in Supabase table "${analysis.date}"…`);
          try {
            matchResult = await checkNameInSupabase(analysis.name, analysis.date);
            console.log(`│        ${matchResult === "matched" ? "✅" : "⚠️ "}  Name: ${matchResult}`);
          } catch (dbErr) {
            matchResult = `error: ${dbErr.message}`;
            console.error(`│        ❌  Supabase error: ${dbErr.message}`);
          }

          // ── Build final filename: firstname-lastname_date.json ─────
          const nameParts     = analysis.name.trim().split(/\s+/);
          const firstname     = safeName(nameParts[0] ?? "unknown");
          const lastname      = safeName(nameParts.slice(1).join(" ") || "unknown");
          const baseName      = `${firstname}-${lastname}_${analysis.date}`;

          // Guard against collision — append _2, _3 … if file already exists
          let finalFilename = `${baseName}.json`;
          let counter = 2;
          while (fs.existsSync(path.join(JSON_DIR, finalFilename))) {
            finalFilename = `${baseName}_${counter}.json`;
            counter++;
          }
          const finalDest = path.join(JSON_DIR, finalFilename);

          const result = {
            name   : analysis.name,
            date   : analysis.date,
            score  : analysis.score,
            matched: matchResult,
          };

          // Write final BEFORE deleting temp — if write fails, temp is preserved
          fs.writeFileSync(finalDest, JSON.stringify(result, null, 2), "utf8");
          fs.unlinkSync(dest);
          dest = finalDest;
          console.log(`│        📝  Final JSON written → ${dest}`);

        } catch (err) {
          // Rename temp file to an error filename so it's identifiable
          const errFilename = `error_${safeName(att.filename)}_${Date.now()}.json`;
          const errDest     = path.join(JSON_DIR, errFilename);
          const errorResult = { error: err.message };
          try { fs.unlinkSync(dest); } catch (_) {}
          fs.writeFileSync(errDest, JSON.stringify(errorResult, null, 2), "utf8");
          console.error(`│        ❌  Claude analysis failed: ${err.message}`);
          console.error(`│        📝  Error written → ${errDest}`);
        }
      }
    }

    console.log(`└────────────────────────────────────────────────────────────\n`);
  }

  // ── 4. Summary ────────────────────────────────────────────────────────
  const savedFiles = fs.readdirSync(JSON_DIR).filter((f) => f.endsWith(".json"));
  if (savedFiles.length > 0) {
    console.log(`\n📁  JSON files in ./${JSON_DIR.replace("./", "")}:`);
    for (const f of savedFiles) console.log(`    • ${f}`);
  } else {
    console.log(`\n💡  No Excel attachments were found — nothing written to ${JSON_DIR}.`);
  }
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  process.exit(1);
});