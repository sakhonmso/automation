/**
 * scripts/backfill-drive-scores.mjs
 *
 * Reads every Excel file from a P4P Google Drive month folder,
 * extracts the physician score, matches the physician in Supabase,
 * updates the score row, and writes a markdown results table to
 * $GITHUB_STEP_SUMMARY (or stdout when run locally).
 *
 * Environment variables (from GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   P4P_FOLDER_ID   — root "P4P" folder ID on Drive
 *   SUPABASE_URL, SUPABASE_KEY
 *
 * Job inputs (set by the workflow):
 *   TARGET_YEAR   e.g. "2569"
 *   TARGET_MONTH  e.g. "3"
 *   DRY_RUN       "true" → skip saveScore (read-only preview)
 */

import { google }   from "googleapis";
import { createClient } from "@supabase/supabase-js";
import ExcelJS      from "exceljs";
import { appendFileSync } from "fs";
import { config as dotenvConfig } from "dotenv";
import { extractScoreFromRows } from "../claude-analyst.js";
import { matchName, saveScore }  from "../supabase-client.js";

dotenvConfig({ override: true });

const TARGET_YEAR  = process.env.TARGET_YEAR  || "2569";
const TARGET_MONTH = parseInt(process.env.TARGET_MONTH || "3", 10);
const DRY_RUN      = process.env.DRY_RUN === "true";
const DATE_KEY     = `${TARGET_YEAR}_${String(TARGET_MONTH).padStart(2, "0")}`;

const MONTH_FOLDER_NAMES = {
   1:"1 - มกราคม",  2:"2 - กุมภาพันธ์", 3:"3 - มีนาคม",
   4:"4 - เมษายน",  5:"5 - พฤษภาคม",    6:"6 - มิถุนายน",
   7:"7 - กรกฎาคม", 8:"8 - สิงหาคม",    9:"9 - กันยายน",
  10:"10 - ตุลาคม", 11:"11 - พฤศจิกายน",12:"12 - ธันวาคม",
};

const MONTH_TOKENS_BY_NUM = {
   1:["มกราคม","มกรา","มกร","มค","january","jan"],
   2:["กุมภาพันธ์","กุมภา","กุมภ","กพ","february","feb"],
   3:["มีนาคม","มีนา","มีน","มีค","march","mar"],
   4:["เมษายน","เมษา","เมษ","เมย","april","apr"],
   5:["พฤษภาคม","พฤษภ","พฤษ","พค","may"],
   6:["มิถุนายน","มิถุน","มิถุ","มิย","june","jun"],
   7:["กรกฎาคม","กรกฎ","กรก","กค","july","jul"],
   8:["สิงหาคม","สิงหา","สิงห","สค","august","aug"],
   9:["กันยายน","กันยา","กันย","กย","september","sep"],
  10:["ตุลาคม","ตุลา","ตุล","ตค","october","oct"],
  11:["พฤศจิกายน","พฤศจิ","พฤศ","พย","november","nov"],
  12:["ธันวาคม","ธันวา","ธันว","ธค","december","dec"],
};

// ── Google Drive auth ─────────────────────────────────────────────────────
function createDrive() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth });
}

function esc(s) { return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

async function findFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${esc(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)", pageSize: 5,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function listFiles(drive, parentId) {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      fields: "nextPageToken,files(id,name,mimeType,size)",
      pageSize: 100, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    all.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

async function downloadBuffer(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

// ── Excel parsing (mirrors index.js firstSheetToRows with all fixes) ──────
async function parseExcel(buffer, targetMonth) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheets = wb.worksheets;
  if (!sheets.length) throw new Error("Workbook has no sheets");

  function nonNullCount(ws) {
    let n = 0;
    ws.eachRow(row => row.eachCell({ includeEmpty: false }, cell => {
      if (cell.value !== null && cell.value !== undefined) n++;
    }));
    return n;
  }

  // Default: first non-empty sheet
  let idx = 0;
  if (nonNullCount(sheets[0]) < 3 && sheets.length > 1) idx = 1;

  // Month-name match for multi-sheet workbooks
  if (targetMonth && sheets.length > 1) {
    const toks = MONTH_TOKENS_BY_NUM[targetMonth] ?? [];
    const m = sheets.findIndex(ws => toks.some(t => ws.name.toLowerCase().includes(t)));
    if (m !== -1 && nonNullCount(sheets[m]) >= 3) idx = m;
  }

  const ws   = sheets[idx];
  const rows = [];

  ws.eachRow(row => {
    if (!row.hasValues) return;
    const obj = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = `col_${col}`;
      const val = cell.value;
      const isMaster = val !== null && typeof val === "object" && "formula" in val;
      const isClone  = val !== null && typeof val === "object" && "sharedFormula" in val && !("formula" in val);
      if (isMaster || isClone) {
        const r = cell.result;
        obj[key] = isClone ? (typeof r === "number" ? r : null) : (r instanceof Date ? r.toISOString() : r ?? null);
        return;
      }
      if (val === null || val === undefined)                         obj[key] = null;
      else if (val instanceof Date)                                  obj[key] = val.toISOString();
      else if (typeof val === "object" && Array.isArray(val.richText)) obj[key] = val.richText.map(r => r.text ?? "").join("");
      else if (typeof val === "object" && "text" in val)             obj[key] = String(val.text ?? "");
      else                                                           obj[key] = val;
    });
    if (Object.keys(obj).length) rows.push(obj);
  });

  return { rows, sheetName: ws.name, sheetCount: sheets.length };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const monthFolderName = MONTH_FOLDER_NAMES[TARGET_MONTH];
  if (!monthFolderName) throw new Error(`Invalid month number: ${TARGET_MONTH}`);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  P4P Backfill — ${monthFolderName} ${TARGET_YEAR}  ${DRY_RUN ? "[DRY RUN]" : ""}`);
  console.log(`  Supabase table: ${DATE_KEY}`);
  console.log(`${"═".repeat(60)}\n`);

  const drive = createDrive();

  // Navigate P4P root → year folder → month folder
  const rootId = process.env.P4P_FOLDER_ID;
  if (!rootId) throw new Error("Missing P4P_FOLDER_ID");

  const yearFolderId = await findFolder(drive, TARGET_YEAR, rootId);
  if (!yearFolderId) throw new Error(`Year folder "${TARGET_YEAR}" not found inside P4P root`);

  const monthFolderId = await findFolder(drive, monthFolderName, yearFolderId);
  if (!monthFolderId) throw new Error(`Month folder "${monthFolderName}" not found inside "${TARGET_YEAR}"`);

  const files = await listFiles(drive, monthFolderId);
  console.log(`📂  ${files.length} file(s) found in  ${monthFolderName}\n`);

  if (!files.length) {
    console.log("No files to process.");
    return;
  }

  // ── Clear all scores for this month before re-processing ──────────────
  if (DRY_RUN) {
    console.log("🔍 Dry run — skipping score clear\n");
  } else {
    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { error: clearError } = await sb
      .from(DATE_KEY)
      .update({ score: null })
      .not("index", "is", null);
    if (clearError) throw new Error(`Failed to clear scores in "${DATE_KEY}": ${clearError.message}`);
    console.log(`🧹 Cleared all score values in table "${DATE_KEY}"\n`);
  }

  // ── Process each file ──────────────────────────────────────────────────
  const results = [];

  for (const file of files) {
    const entry = {
      fileName   : file.name,
      status     : "",
      score      : null,
      matchedName: "",
      similarity : null,
      error      : "",
    };

    console.log(`┌─ ${file.name}`);

    try {
      // 1. Download
      const buffer = await downloadBuffer(drive, file.id);

      // 2. Parse Excel
      const { rows, sheetName, sheetCount } = await parseExcel(buffer, TARGET_MONTH);
      if (sheetCount > 1) console.log(`│  📋 ${sheetCount} sheets — using "${sheetName}"`);
      console.log(`│  📄 Rows: ${rows.length}`);

      // 3. Extract score
      const { score, method } = extractScoreFromRows(rows);
      entry.score = score;
      console.log(`│  🔢 Score: ${score != null ? score.toFixed(2) : "none"} (${method})`);

      if (!score || score <= 0) {
        entry.status = "⚠️ no score";
        entry.error  = method;
        console.log(`└─ ⚠️  Skipped — no score found\n`);
        results.push(entry);
        continue;
      }

      // 4. Match physician name in Supabase
      //    Drive filenames = physician name (saved by uploadFile as matchedName)
      const physicianName = file.name.replace(/\.[^.]+$/, "").trim();
      console.log(`│  👤 Looking up: "${physicianName}"`);

      const match = await matchName(physicianName, DATE_KEY);

      if (!match) {
        entry.status = "❌ not found";
        entry.error  = `"${physicianName}" not matched in ${DATE_KEY}`;
        console.log(`└─ ❌ No match — ${entry.error}\n`);
        results.push(entry);
        continue;
      }

      entry.matchedName = match.matchedName;
      entry.similarity  = match.similarity;
      console.log(`│  ✅ Matched: "${match.matchedName}" (${(match.similarity * 100).toFixed(0)}%, row ${match.index})`);

      // 5. Save to Supabase
      if (DRY_RUN) {
        entry.status = "🔍 dry run";
        console.log(`└─ 🔍 Dry run — score NOT saved\n`);
      } else {
        await saveScore(DATE_KEY, match.index, score);
        entry.status = "✅ saved";
        console.log(`└─ 💾 Saved ${score.toFixed(2)} → "${DATE_KEY}" row ${match.index}\n`);
      }

    } catch (err) {
      entry.status = "❌ error";
      entry.error  = err.message;
      console.error(`└─ ❌ ${err.message}\n`);
    }

    results.push(entry);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const saved    = results.filter(r => r.status.startsWith("✅")).length;
  const dryRuns  = results.filter(r => r.status.startsWith("🔍")).length;
  const noScore  = results.filter(r => r.status.startsWith("⚠️")).length;
  const failed   = results.filter(r => r.status.startsWith("❌")).length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${results.length} files | ✅ ${saved} saved | ⚠️ ${noScore} no score | ❌ ${failed} failed${DRY_RUN ? ` | 🔍 ${dryRuns} dry-run` : ""}`);
  console.log(`${"═".repeat(60)}\n`);

  // ── GitHub Step Summary (markdown) ──────────────────────────────────────
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  let md = `# 📊 P4P Score Backfill — ${monthFolderName} ${TARGET_YEAR}${DRY_RUN ? " *(Dry Run)*" : ""}\n\n`;
  md += `**Supabase table:** \`${DATE_KEY}\`\n\n`;
  md += `| Stat | Count |\n|---|---|\n`;
  md += `| Total files | ${results.length} |\n`;
  md += `| ✅ Saved | ${saved + dryRuns} |\n`;
  md += `| ⚠️ No score found | ${noScore} |\n`;
  md += `| ❌ Failed / Not matched | ${failed} |\n\n`;

  md += `## File Details\n\n`;
  md += `| # | Drive Filename | Score | Matched Name | Sim% | Status |\n`;
  md += `|---|---|---|---|---|---|\n`;

  results.forEach((r, i) => {
    const score = r.score != null ? r.score.toFixed(2) : "—";
    const sim   = r.similarity != null ? `${(r.similarity * 100).toFixed(0)}%` : "—";
    const note  = r.error ? `<br><sub>${r.error.replace(/\|/g, "╎")}</sub>` : "";
    md += `| ${i + 1} | ${r.fileName} | ${score} | ${r.matchedName || "—"} | ${sim} | ${r.status}${note} |\n`;
  });

  md += `\n---\n_Run at ${new Date().toISOString()}_\n`;

  if (summaryPath) {
    appendFileSync(summaryPath, md, "utf8");
    console.log("📊 Step summary written to $GITHUB_STEP_SUMMARY");
  } else {
    // Local run: just print the markdown
    console.log(md);
  }
}

main().catch(err => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
