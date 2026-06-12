/**
 * scripts/score-tracker.mjs
 *
 * Monthly P4P score-completion tracker.
 * Triggered on the 1st of every month by GitHub Actions.
 *
 * Logic:
 *  Phase 1 — Per-department: gather 3-month status (all months, regardless of completeness).
 *  Phase 2 — Group by head email: departments sharing the same head email are
 *             batched into ONE email (one email per person, not per department).
 *  Phase 3 — Send: one email per unique address.
 *
 * Required env vars (GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 *   DEPT_HEADS_JSON   — JSON object: dept name → head email (null = no email)
 *                       Keys must match the department values in Supabase exactly
 *                       (script trims whitespace when matching).
 *                       Example: {"ศัลยกรรม":"dr@h.com","เวชกรรมฟื้นฟู":null}
 */

import { createClient }          from "@supabase/supabase-js";
import { config as dotenvConfig } from "dotenv";
import { appendFileSync }        from "fs";
import { createGmailClient }     from "../gmail-client.js";
import { createDriveClient }     from "../drive-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";

dotenvConfig({ override: true });

// ── Configuration ─────────────────────────────────────────────────────────
// Dept names are trimmed at lookup time so trailing spaces in the JSON don't matter.
const DEPT_HEADS = (() => {
  try { return JSON.parse(process.env.DEPT_HEADS_JSON || "{}"); }
  catch (e) { console.warn("⚠️  Could not parse DEPT_HEADS_JSON:", e.message); return {}; }
})();
const EXEMPT_DEPTS = new Set(["INTERN"]);
const CHECK_COUNT  = 3;

// ── Thai locale data ───────────────────────────────────────────────────────
const THAI_MONTHS = {
  "01":"มกราคม","02":"กุมภาพันธ์","03":"มีนาคม","04":"เมษายน",
  "05":"พฤษภาคม","06":"มิถุนายน","07":"กรกฎาคม","08":"สิงหาคม",
  "09":"กันยายน","10":"ตุลาคม","11":"พฤศจิกายน","12":"ธันวาคม",
};

// ── Date helpers ───────────────────────────────────────────────────────────
function getPreviousMonths(count) {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  const result = [];
  for (let i = 0; i < count; i++) {
    if (--m === 0) { m = 12; y--; }
    result.push(`${y + 543}_${String(m).padStart(2, "0")}`);
  }
  return result; // most-recent first
}

function tableKeyToDisplay(key) {
  const [year, month] = key.split("_");
  return `${THAI_MONTHS[month] ?? month} ${year}`;
}

function todayThaiStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getDate()} ${THAI_MONTHS[m]} ${d.getFullYear() + 543}`;
}

// ── Supabase helpers ───────────────────────────────────────────────────────
function createSB() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function getDeptStatus(sb, tableKey, dept, driveFileMap = null) {
  const { data, error } = await sb
    .from(tableKey)
    .select("firstname, lastname, score")
    .eq("department", dept);
  if (error) throw new Error(`[${tableKey}/${dept}] Supabase: ${error.message}`);
  if (!data?.length) return null;

  const total   = data.length;
  const filled  = data.filter(r => r.score !== null).length;
  const missing = total - filled;

  // Sort: score DESC, nulls last
  const rows = [...data]
    .sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    })
    .map(r => {
      const name = `${r.firstname ?? ""} ${r.lastname ?? ""}`.trim();
      return { name, score: r.score, driveFileId: driveFileMap?.get(name) ?? null };
    });

  const missingNames = rows.filter(r => r.score === null).map(r => r.name);
  return { total, filled, missing, complete: missing === 0, missingNames, rows };
}

async function getDistinctDepts(sb, tableKeys) {
  const deptSet = new Set();
  for (const key of tableKeys) {
    const { data, error } = await sb.from(key).select("department");
    if (error || !data) continue;
    for (const r of data) {
      if (r.department && !EXEMPT_DEPTS.has(r.department.trim())) deptSet.add(r.department.trim());
    }
  }
  return [...deptSet].sort();
}


// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const todayStr = todayThaiStr();

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  P4P Score Tracker  —  ${todayStr}`);
  console.log(`  Checking last ${CHECK_COUNT} months`);
  console.log(`${"═".repeat(62)}\n`);

  const months = getPreviousMonths(CHECK_COUNT);
  const sb     = createSB();
  const gmail  = createGmailClient();

  console.log(`📅  Months: ${months.map(tableKeyToDisplay).join("  •  ")}\n`);

  // ── Build Drive file maps (one API call per month, shared across all depts)
  const drive = process.env.P4P_FOLDER_ID ? createDriveClient() : null;
  const driveFileMaps = new Map(); // tableKey → Map<physicianName, fileId>
  if (drive) {
    for (const key of months) {
      try {
        const fileMap = await drive.listMonthFiles(key);
        driveFileMaps.set(key, fileMap);
        console.log(`📁  Drive ${tableKeyToDisplay(key)}: ${fileMap.size} files`);
      } catch (e) {
        console.warn(`⚠️  Drive lookup failed for ${key}: ${e.message}`);
      }
    }
    console.log();
  }

  const depts = await getDistinctDepts(sb, months);
  if (!depts.length) { console.log("⚠️  No departments found — nothing to do."); return; }
  console.log(`🏥  Departments: ${depts.join(", ")}\n`);

  // ── Phase 1: gather per-dept status for all 3 months ───────────────────
  // deptData: dept → { monthsData }
  const deptData = new Map();

  for (const dept of depts) {
    console.log(`┌─ ${dept}`);
    const monthsData = [];
    for (const key of months) {
      const status = await getDeptStatus(sb, key, dept, driveFileMaps.get(key) ?? null);
      monthsData.push({ key, displayName: tableKeyToDisplay(key), status });
      const icon = !status ? "—" : status.complete ? "✓" : `✗ ค้าง ${status.missing}/${status.total}`;
      console.log(`│   ${tableKeyToDisplay(key)}: ${icon}`);
    }
    console.log(`└─ รอส่งอีเมล\n`);
    deptData.set(dept, { monthsData });
  }

  // ── Phase 2: group departments by head email ────────────────────────────
  const byEmail = new Map();
  const noEmail = [];

  for (const [dept, data] of deptData) {
    const email = (DEPT_HEADS[dept] ?? DEPT_HEADS[dept.trim()]) ?? null;
    if (!email) {
      console.log(`⚠️  "${dept}": ไม่มีอีเมลหัวหน้า — ข้ามการส่ง`);
      noEmail.push(dept);
      continue;
    }
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push({ dept, ...data });
  }

  // ── Phase 3: send one email per unique address ──────────────────────────
  const summaryRows = [];

  for (const [email, deptList] of byEmail) {
    const deptNames = deptList.map(d => d.dept).join(", ");
    console.log(`\n📧  ${email}`);
    console.log(`    กลุ่มงาน: ${deptNames}`);

    // Build combined HTML email
    const html = buildScoreReportEmail({
      depts: deptList.map(d => ({
        dept        : d.dept,
        monthsSummary: d.monthsData.map(({ displayName, status }) => ({ displayName, status })),
      })),
      reportDate: todayStr,
    });

    const subject   = `รายงานสถานะ P4P ${deptNames} — ${todayStr}`;
    const plainBody = `รายงานสถานะ P4P\nกลุ่มงาน: ${deptNames}`;

    await gmail.sendMessage({ to: email, subject, body: plainBody, html });
    console.log(`    ✉️  ส่งแล้ว`);

    for (const { dept } of deptList) {
      summaryRows.push({ dept, emailed: true, note: email });
    }
  }

  for (const dept of noEmail) {
    summaryRows.push({ dept, emailed: false, note: "ไม่มีอีเมลหัวหน้า" });
  }

  writeSummary(summaryRows, months, todayStr);
}

// ── Step summary helper ────────────────────────────────────────────────────
function writeSummary(rows, months, todayStr) {
  const monthLabels = months.map(tableKeyToDisplay).join(" · ");
  let md = `# 📈 P4P Score Tracker\n\n`;
  md += `**วันที่:** ${todayStr}  \n`;
  md += `**เดือนที่ตรวจสอบ:** ${monthLabels}\n\n`;

  if (!rows.length) {
    md += "_ไม่พบกลุ่มงานในช่วงนี้_\n";
  } else {
    md += `| กลุ่มงาน | ส่งอีเมล | หมายเหตุ |\n`;
    md += `|---|:---:|---|\n`;
    for (const r of rows) {
      md += `| ${r.dept} | ${r.emailed ? "✅" : "—"} | ${r.note} |\n`;
    }
  }

  md += `\n---\n_Run at ${new Date().toISOString()}_\n`;

  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) { appendFileSync(path, md, "utf8"); console.log("\n📊 Step summary written"); }
  else       { console.log("\n" + md); }
}

main().catch(err => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
