/**
 * scripts/test-send-tracker.mjs
 *
 * One-shot test: fetch real Supabase data for อายุรกรรม and send the
 * score-tracker email to a given address.
 * Does NOT write any log entries.
 *
 * Usage:
 *   node scripts/test-send-tracker.mjs
 * (requires .env or the same env vars as the main workflow)
 */

import { createClient }          from "@supabase/supabase-js";
import { config as dotenvConfig } from "dotenv";
import { createGmailClient }     from "../gmail-client.js";
import { createDriveClient }     from "../drive-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";

dotenvConfig({ override: true });

// ── Test target ────────────────────────────────────────────────────────────
const TEST_DEPT  = "อายุรกรรม";
const TEST_EMAIL = "pong.poti@gmail.com";
const CHECK_COUNT = 3;

// ── Thai helpers ───────────────────────────────────────────────────────────
const THAI_MONTHS = {
  "01":"มกราคม","02":"กุมภาพันธ์","03":"มีนาคม","04":"เมษายน",
  "05":"พฤษภาคม","06":"มิถุนายน","07":"กรกฎาคม","08":"สิงหาคม",
  "09":"กันยายน","10":"ตุลาคม","11":"พฤศจิกายน","12":"ธันวาคม",
};

function getPreviousMonths(count) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth() + 1;
  const result = [];
  for (let i = 0; i < count; i++) {
    if (--m === 0) { m = 12; y--; }
    result.push(`${y + 543}_${String(m).padStart(2, "0")}`);
  }
  return result;
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

// ── Supabase ───────────────────────────────────────────────────────────────
async function getDeptStatus(sb, tableKey, dept, driveFileMap = null) {
  const { data, error } = await sb
    .from(tableKey)
    .select("firstname, lastname, score")
    .eq("department", dept);
  if (error) throw new Error(`[${tableKey}/${dept}] ${error.message}`);
  if (!data?.length) return null;

  const total   = data.length;
  const filled  = data.filter(r => r.score !== null).length;
  const missing = total - filled;

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

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");

  const todayStr = todayThaiStr();
  const months   = getPreviousMonths(CHECK_COUNT);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TEST: Score Tracker Email — ${TEST_DEPT}`);
  console.log(`  Target: ${TEST_EMAIL}`);
  console.log(`  Months: ${months.map(tableKeyToDisplay).join("  •  ")}`);
  console.log(`${"═".repeat(60)}\n`);

  const sb    = createClient(SUPABASE_URL, SUPABASE_KEY);
  const gmail = createGmailClient();

  // Build Drive file maps (one API call per month)
  const drive = process.env.P4P_FOLDER_ID ? createDriveClient() : null;
  const driveFileMaps = new Map();
  if (drive) {
    for (const key of months) {
      try {
        const fileMap = await drive.listMonthFiles(key);
        driveFileMaps.set(key, fileMap);
        console.log(`  📁 Drive ${tableKeyToDisplay(key)}: ${fileMap.size} files`);
      } catch (e) {
        console.warn(`  ⚠️  Drive lookup failed for ${tableKeyToDisplay(key)}: ${e.message}`);
      }
    }
  } else {
    console.log(`  ℹ️  P4P_FOLDER_ID not set — skipping Drive lookup (names won't be linked)`);
  }

  const monthsData = [];
  for (const key of months) {
    const status = await getDeptStatus(sb, key, TEST_DEPT, driveFileMaps.get(key) ?? null);
    const display = tableKeyToDisplay(key);
    monthsData.push({ key, displayName: display, status });
    if (!status) {
      console.log(`  ${display}: ไม่พบข้อมูลในตาราง ${key}`);
    } else {
      console.log(`  ${display}: ${status.total} คน, ส่งแล้ว ${status.filled}, ค้าง ${status.missing} — ${status.complete ? "✓ ครบถ้วน" : "✗ ไม่ครบ"}`);
    }
  }

  const html = buildScoreReportEmail({
    depts: [{
      dept: TEST_DEPT,
      monthsSummary: monthsData.map(({ displayName, status }) => ({ displayName, status })),
    }],
    reportDate: todayStr,
  });

  const subject   = `[TEST] รายงานสถานะ P4P กลุ่มงาน ${TEST_DEPT} — ${todayStr}`;
  const plainBody = `[TEST] รายงานสถานะ P4P\nกลุ่มงาน: ${TEST_DEPT}`;

  console.log(`\n  📧 Sending to ${TEST_EMAIL}...`);
  await gmail.sendMessage({ to: TEST_EMAIL, subject, body: plainBody, html });

  console.log(`\n  ✅ Email sent!`);
  console.log(`     To:      ${TEST_EMAIL}`);
  console.log(`     Subject: ${subject}\n`);
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
