/**
 * scripts/test-send-tracker.mjs
 *
 * One-shot test: fetch real Supabase data for อายุรกรรม and send the
 * score-tracker email to a given address — bypasses email_sent_log dedup
 * and does NOT write any log entries.
 *
 * Usage:
 *   node scripts/test-send-tracker.mjs
 * (requires .env or the same env vars as the main workflow)
 */

import { createClient }          from "@supabase/supabase-js";
import PDFDocument               from "pdfkit";
import { config as dotenvConfig } from "dotenv";
import { existsSync }            from "fs";
import { join, dirname }         from "path";
import { fileURLToPath }         from "url";
import { createGmailClient }     from "../gmail-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";

dotenvConfig({ override: true });

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Test target ────────────────────────────────────────────────────────────
const TEST_DEPT  = "อายุรกรรม";
const TEST_EMAIL = "pong.poti@gmail.com";
const CHECK_COUNT = 3;

// ── Font paths ─────────────────────────────────────────────────────────────
const FONT_REG  = join(__dir, "../fonts/Sarabun-Regular.ttf");
const FONT_BOLD = join(__dir, "../fonts/Sarabun-Bold.ttf");

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
async function getDeptStatus(sb, tableKey, dept) {
  const { data, error } = await sb
    .from(tableKey)
    .select("firstname, lastname, prefix, score")
    .eq("department", dept);
  if (error) throw new Error(`[${tableKey}/${dept}] ${error.message}`);
  if (!data?.length) return null;
  const total  = data.length;
  const filled = data.filter(r => r.score !== null).length;
  const missing = total - filled;
  const missingNames = data
    .filter(r => r.score === null)
    .map(r => `${r.prefix ?? ""}${r.firstname ?? ""} ${r.lastname ?? ""}`.trim());
  return { total, filled, missing, complete: missing === 0, missingNames };
}

// ── PDF generation (identical to score-tracker.mjs) ───────────────────────
async function generatePDF(dept, monthsData, todayStr) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 }, autoFirstPage: true });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const hasReg  = existsSync(FONT_REG);
    const hasBold = existsSync(FONT_BOLD);
    if (hasReg)  doc.registerFont("SarabunReg",  FONT_REG);
    if (hasBold) doc.registerFont("SarabunBold", FONT_BOLD);
    const REG  = hasReg  ? "SarabunReg"  : "Helvetica";
    const BOLD = hasBold ? "SarabunBold" : "Helvetica-Bold";

    const PW = doc.page.width, PH = doc.page.height, L = 50, CW = PW - 100;
    const BLUE_D = "#1e3a8a", BLUE_L = "#dbeafe", BLUE_BG = "#eff6ff";
    const DARK = "#1e293b", GRAY = "#64748b", GREEN = "#16a34a", RED = "#dc2626";

    // Header band
    doc.rect(0, 0, PW, 90).fill(BLUE_D);
    doc.font(BOLD).fontSize(17).fill("#fff")
       .text(`รายงานสถานะ P4P — กลุ่มงาน ${dept}`, L, 18, { width: CW });
    doc.font(REG).fontSize(11).fill("#bfdbfe")
       .text(`โรงพยาบาลสมุทรสาคร  ·  จัดทำเมื่อ ${todayStr}`, L, 50, { width: CW, lineBreak: false });
    doc.font(REG).fontSize(10).fill("#93c5fd")
       .text("ตรวจสอบ 3 เดือนล่าสุด (ไม่รวมเดือนปัจจุบัน)", L, 68, { width: CW, lineBreak: false });

    // Summary table
    const TY = 105, HDH = 26, RH = 28;
    const COLS = [
      { label: "เดือน",          w: 165, align: "left"   },
      { label: "แพทย์ทั้งหมด", w: 82,  align: "center" },
      { label: "ส่งแล้ว",       w: 80,  align: "center" },
      { label: "ค้างส่ง",       w: 78,  align: "center" },
      { label: "สถานะ",         w: 90,  align: "center" },
    ];

    // Table header background
    doc.rect(L, TY, CW, HDH).fill(BLUE_D);
    let cx = L;
    for (const col of COLS) {
      doc.font(BOLD).fontSize(10).fill("#fff")
         .text(col.label, cx + 4, TY + 8, { width: col.w - 8, align: col.align, lineBreak: false });
      cx += col.w;
    }

    // Table rows
    let rowY = TY + HDH;
    for (const { displayName, status } of monthsData) {
      const isEven = (monthsData.indexOf(monthsData.find(m => m.displayName === displayName)) % 2 === 1);
      doc.rect(L, rowY, CW, RH).fill(isEven ? BLUE_BG : "#fff");
      doc.rect(L, rowY, CW, RH).stroke(BLUE_L);
      const vals = status
        ? [displayName, String(status.total), String(status.filled), String(status.missing),
           status.complete ? "✓ ครบถ้วน" : `✗ ค้าง ${status.missing}`]
        : [displayName, "—", "—", "—", "ไม่พบข้อมูล"];
      const colors = status
        ? [DARK, DARK, GREEN, status.missing > 0 ? RED : GRAY,
           status.complete ? GREEN : RED]
        : [DARK, GRAY, GRAY, GRAY, GRAY];

      cx = L;
      for (let i = 0; i < COLS.length; i++) {
        doc.font(REG).fontSize(11).fill(colors[i])
           .text(vals[i], cx + 4, rowY + 9, { width: COLS[i].w - 8, align: COLS[i].align, lineBreak: false });
        cx += COLS[i].w;
      }
      rowY += RH;
    }

    // Missing names section
    const pending = monthsData.filter(m => m.status && !m.status.complete);
    if (pending.length) {
      rowY += 16;
      doc.rect(L, rowY, CW, 24).fill(BLUE_D);
      doc.font(BOLD).fontSize(11).fill("#fff")
         .text("รายชื่อแพทย์ที่ยังไม่ส่งคะแนน", L + 8, rowY + 7, { width: CW - 16, lineBreak: false });
      rowY += 24;

      for (const { displayName, status } of pending) {
        rowY += 8;
        doc.font(BOLD).fontSize(10).fill(BLUE_D)
           .text(`${displayName}  (ค้าง ${status.missing} คน)`, L, rowY);
        rowY += 16;

        const names = status.missingNames;
        const colW  = Math.floor(CW / 2) - 10;
        const midX  = L + Math.floor(CW / 2) + 10;
        let col1Y = rowY, col2Y = rowY, idx = 0;
        for (const name of names) {
          if (idx % 2 === 0) {
            doc.font(REG).fontSize(10).fill(DARK).text(`• ${name}`, L, col1Y, { width: colW, lineBreak: false });
            col1Y += 15;
          } else {
            doc.font(REG).fontSize(10).fill(DARK).text(`• ${name}`, midX, col2Y, { width: colW, lineBreak: false });
            col2Y += 15;
          }
          idx++;
        }
        rowY = Math.max(col1Y, col2Y) + 4;
      }
    }

    // Footer
    doc.font(REG).fontSize(9).fill(GRAY)
       .text("เอกสารนี้สร้างโดยระบบอัตโนมัติ — โรงพยาบาลสมุทรสาคร",
             L, PH - 38, { width: CW, align: "center", lineBreak: false });

    doc.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");

  const todayStr = todayThaiStr();
  const nowTag   = new Date().toISOString().slice(0, 7);
  const months   = getPreviousMonths(CHECK_COUNT);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TEST: Score Tracker Email — ${TEST_DEPT}`);
  console.log(`  Target: ${TEST_EMAIL}`);
  console.log(`  Months: ${months.map(tableKeyToDisplay).join("  •  ")}`);
  console.log(`${"═".repeat(60)}\n`);

  const sb    = createClient(SUPABASE_URL, SUPABASE_KEY);
  const gmail = createGmailClient();

  // Fetch data for all 3 months
  const monthsData = [];
  for (const key of months) {
    const status = await getDeptStatus(sb, key, TEST_DEPT);
    const display = tableKeyToDisplay(key);
    monthsData.push({ key, displayName: display, status });
    if (!status) {
      console.log(`  ${display}: ไม่พบข้อมูลในตาราง ${key}`);
    } else {
      console.log(`  ${display}: ${status.total} คน, ส่งแล้ว ${status.filled}, ค้าง ${status.missing} — ${status.complete ? "✓ ครบถ้วน" : "✗ ไม่ครบ"}`);
    }
  }

  // Generate PDF
  console.log("\n  📄 Generating PDF...");
  const pdfBuf = await generatePDF(TEST_DEPT, monthsData, todayStr);
  console.log(`  PDF size: ${(pdfBuf.length / 1024).toFixed(1)} KB`);

  // Build email
  const html = buildScoreReportEmail({
    depts: [{
      dept: TEST_DEPT,
      monthsSummary: monthsData.map(({ displayName, status }) => ({ displayName, status })),
    }],
    reportDate: todayStr,
  });

  const subject   = `[TEST] รายงานสถานะ P4P กลุ่มงาน ${TEST_DEPT} — ${todayStr}`;
  const plainBody = `[TEST] รายงานสถานะ P4P\nกลุ่มงาน: ${TEST_DEPT}\nดูรายละเอียดในไฟล์ PDF ที่แนบ`;

  console.log(`\n  📧 Sending to ${TEST_EMAIL}...`);
  await gmail.sendMessage({
    to: TEST_EMAIL,
    subject,
    body: plainBody,
    html,
    attachments: [{
      filename: `P4P_รายงาน_${TEST_DEPT}_${nowTag}.pdf`,
      mimeType: "application/pdf",
      buffer: pdfBuf,
    }],
  });

  console.log(`\n  ✅ Email sent!`);
  console.log(`     To:      ${TEST_EMAIL}`);
  console.log(`     Subject: ${subject}`);
  console.log(`     PDF:     P4P_รายงาน_${TEST_DEPT}_${nowTag}.pdf (${(pdfBuf.length / 1024).toFixed(1)} KB)`);
  console.log(`     (email_sent_log NOT written — this is a test run)\n`);
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
