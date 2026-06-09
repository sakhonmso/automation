/**
 * scripts/score-tracker.mjs
 *
 * Monthly P4P score-completion tracker.
 * Triggered on the 1st of every month by GitHub Actions.
 *
 * Logic:
 *  1. Compute the last 4 calendar months (excluding current month).
 *  2. Discover all distinct departments across those tables (INTERN is exempt).
 *  3. For each department:
 *       a. Check how many physicians have a NULL score each month.
 *       b. Find months that are NOW complete but have NOT yet been emailed
 *          (tracked in the Supabase `email_sent_log` table).
 *       c. If any newly-complete months exist → generate a PDF report and
 *          send an email to the department head.
 *       d. Log each newly-complete (month, dept) pair to `email_sent_log`.
 *  4. Write a markdown table to $GITHUB_STEP_SUMMARY.
 *
 * Required env vars (GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 *   DEPT_HEADS_JSON   — JSON object mapping dept name → head email address
 *                       e.g. {"OPD":"head@hospital.com","IPD":"ipd@hospital.com"}
 * Optional:
 *   DRY_RUN           — "true" → check & report but do NOT send emails or log
 */

import { createClient }         from "@supabase/supabase-js";
import PDFDocument              from "pdfkit";
import { config as dotenvConfig } from "dotenv";
import { existsSync, appendFileSync } from "fs";
import { join, dirname }        from "path";
import { fileURLToPath }        from "url";
import { createGmailClient }    from "../gmail-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";

dotenvConfig({ override: true });

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Configuration ─────────────────────────────────────────────────────────
const DRY_RUN     = process.env.DRY_RUN === "true";
const DEPT_HEADS  = (() => {
  try { return JSON.parse(process.env.DEPT_HEADS_JSON || "{}"); }
  catch (e) { console.warn("⚠️  Could not parse DEPT_HEADS_JSON:", e.message); return {}; }
})();
const EXEMPT_DEPTS = new Set(["INTERN"]);
const CHECK_COUNT  = 4;

// ── Thai locale data ───────────────────────────────────────────────────────
const THAI_MONTHS = {
  "01":"มกราคม","02":"กุมภาพันธ์","03":"มีนาคม","04":"เมษายน",
  "05":"พฤษภาคม","06":"มิถุนายน","07":"กรกฎาคม","08":"สิงหาคม",
  "09":"กันยายน","10":"ตุลาคม","11":"พฤศจิกายน","12":"ธันวาคม",
};

// ── Font paths (downloaded by the workflow step) ───────────────────────────
const FONT_REG  = join(__dir, "../fonts/Sarabun-Regular.ttf");
const FONT_BOLD = join(__dir, "../fonts/Sarabun-Bold.ttf");

// ── Date helpers ───────────────────────────────────────────────────────────
/**
 * Return the last `count` month table-keys (most-recent first).
 * Keys follow the Supabase naming convention: "YYYY_MM" in Buddhist Era.
 * Example (called in June 2569): ["2569_05","2569_04","2569_03","2569_02"]
 */
function getPreviousMonths(count) {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;          // 1-12
  const result = [];
  for (let i = 0; i < count; i++) {
    if (--m === 0) { m = 12; y--; }
    result.push(`${y + 543}_${String(m).padStart(2, "0")}`);
  }
  return result;
}

/** "2569_05" → "พฤษภาคม 2569" */
function tableKeyToDisplay(key) {
  const [year, month] = key.split("_");
  return `${THAI_MONTHS[month] ?? month} ${year}`;
}

/** Today formatted as Thai date string: "1 มิถุนายน 2569" */
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

/**
 * Return score-completion status for one department in one month table.
 * Returns null if the department has no rows in that table.
 */
async function getDeptStatus(sb, tableKey, dept) {
  const { data, error } = await sb
    .from(tableKey)
    .select("firstname, lastname, prefix, score")
    .eq("department", dept);

  if (error) throw new Error(`[${tableKey}/${dept}] Supabase: ${error.message}`);
  if (!data?.length) return null;

  const total   = data.length;
  const filled  = data.filter(r => r.score !== null).length;
  const missing = total - filled;
  const missingNames = data
    .filter(r => r.score === null)
    .map(r => `${r.prefix ?? ""}${r.firstname ?? ""} ${r.lastname ?? ""}`.trim());

  return { total, filled, missing, complete: missing === 0, missingNames };
}

/** Collect every distinct non-exempt department across all checked tables. */
async function getDistinctDepts(sb, tableKeys) {
  const deptSet = new Set();
  for (const key of tableKeys) {
    const { data, error } = await sb.from(key).select("department");
    if (error || !data) continue;
    for (const r of data) {
      if (r.department && !EXEMPT_DEPTS.has(r.department)) deptSet.add(r.department);
    }
  }
  return [...deptSet].sort();
}

/** True if an email was already sent for this (tableKey, dept) pair. */
async function checkAlreadySent(sb, tableKey, dept) {
  const { data } = await sb
    .from("email_sent_log")
    .select("id")
    .eq("table_name", tableKey)
    .eq("department", dept)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/** Record that the email for (tableKey, dept) has been sent. */
async function logSent(sb, tableKey, dept) {
  const { error } = await sb
    .from("email_sent_log")
    .insert({ table_name: tableKey, department: dept });
  if (error) console.warn(`⚠️  email_sent_log insert failed for ${tableKey}/${dept}: ${error.message}`);
}

// ── PDF generation ─────────────────────────────────────────────────────────
/**
 * Generate a PDF report for one department.
 *
 * @param {string} dept
 * @param {Array}  monthsData  [{ key, displayName, status }] most-recent first
 * @param {string} todayStr    Thai date string
 * @returns {Promise<Buffer>}
 */
async function generatePDF(dept, monthsData, todayStr) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      autoFirstPage: true,
    });

    const chunks = [];
    doc.on("data",  c  => chunks.push(c));
    doc.on("end",   () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Register Thai fonts if available
    const hasReg  = existsSync(FONT_REG);
    const hasBold = existsSync(FONT_BOLD);
    if (!hasReg)  console.warn("⚠️  Sarabun-Regular.ttf not found — Thai text may not render");
    if (hasReg)   doc.registerFont("SarabunReg",  FONT_REG);
    if (hasBold)  doc.registerFont("SarabunBold", FONT_BOLD);
    const REG  = hasReg  ? "SarabunReg"  : "Helvetica";
    const BOLD = hasBold ? "SarabunBold" : "Helvetica-Bold";

    const PW  = doc.page.width;   // 595
    const PH  = doc.page.height;  // 842
    const L   = 50;               // left margin
    const CW  = PW - 100;         // content width (495)

    // Palette
    const BLUE_D  = "#1e3a8a";
    const BLUE_L  = "#dbeafe";
    const BLUE_BG = "#eff6ff";
    const DARK    = "#1e293b";
    const GRAY    = "#64748b";
    const GREEN   = "#16a34a";
    const RED     = "#dc2626";

    // ─────────────────────────────────────────────────────────────────────
    // HEADER BAND  (Y: 0 – 90)
    // ─────────────────────────────────────────────────────────────────────
    doc.rect(0, 0, PW, 90).fill(BLUE_D);

    doc.font(BOLD).fontSize(17).fill("#fff")
       .text(`รายงานสถานะ P4P — กลุ่มงาน ${dept}`, L, 18, { width: CW });

    doc.font(REG).fontSize(11).fill("#bfdbfe")
       .text(`โรงพยาบาลสมุทรสาคร  ·  จัดทำเมื่อ ${todayStr}`, L, 50, { width: CW, lineBreak: false });

    doc.font(REG).fontSize(10).fill("#93c5fd")
       .text("ตรวจสอบ 4 เดือนล่าสุด (ไม่รวมเดือนปัจจุบัน)", L, 68, { width: CW, lineBreak: false });

    // ─────────────────────────────────────────────────────────────────────
    // SUMMARY TABLE  (starts at Y: 105)
    // ─────────────────────────────────────────────────────────────────────
    const TY  = 105;   // table top
    const HDH = 26;    // header row height
    const RH  = 28;    // data row height

    // Column definitions [total width must equal CW = 495]
    const COLS = [
      { label: "เดือน",          w: 165, align: "left"   },
      { label: "แพทย์ทั้งหมด", w: 82,  align: "center" },
      { label: "ส่งแล้ว",       w: 80,  align: "center" },
      { label: "ค้างส่ง",       w: 78,  align: "center" },
      { label: "สถานะ",         w: 90,  align: "center" },
    ];

    // Header row background
    doc.rect(L, TY, CW, HDH).fill(BLUE_L);

    // Header labels
    let cx = L;
    doc.font(BOLD).fontSize(11).fill(BLUE_D);
    for (const col of COLS) {
      doc.text(col.label, cx + 5, TY + 7, { width: col.w - 10, align: col.align, lineBreak: false });
      cx += col.w;
    }

    // Data rows
    let ry = TY + HDH;
    for (let i = 0; i < monthsData.length; i++) {
      const { displayName, status } = monthsData[i];

      // Row background (alternating)
      doc.rect(L, ry, CW, RH).fill(i % 2 === 0 ? "#fff" : BLUE_BG);

      cx = L;
      const CELL_Y = ry + 8;

      // Month name
      doc.font(REG).fontSize(12).fill(DARK)
         .text(displayName, cx + 5, CELL_Y, { width: COLS[0].w - 10, lineBreak: false });
      cx += COLS[0].w;

      if (!status) {
        doc.fill(GRAY).fontSize(11)
           .text("ไม่พบข้อมูล", cx + 5, CELL_Y,
                 { width: CW - COLS[0].w - 10, align: "center", lineBreak: false });
      } else {
        // Total
        doc.font(REG).fill(DARK).fontSize(12)
           .text(String(status.total), cx + 5, CELL_Y,
                 { width: COLS[1].w - 10, align: "center", lineBreak: false });
        cx += COLS[1].w;

        // Filled (green bold)
        doc.font(BOLD).fill(GREEN)
           .text(String(status.filled), cx + 5, CELL_Y,
                 { width: COLS[2].w - 10, align: "center", lineBreak: false });
        cx += COLS[2].w;

        // Missing (red bold if > 0)
        doc.fill(status.missing > 0 ? RED : DARK)
           .font(status.missing > 0 ? BOLD : REG)
           .text(String(status.missing), cx + 5, CELL_Y,
                 { width: COLS[3].w - 10, align: "center", lineBreak: false });
        cx += COLS[3].w;

        // Status badge text
        doc.fill(status.complete ? GREEN : RED)
           .font(BOLD).fontSize(11)
           .text(status.complete ? "✓ ครบถ้วน" : "✗ ยังไม่ครบ", cx + 5, CELL_Y,
                 { width: COLS[4].w - 10, align: "center", lineBreak: false });
      }

      // Row divider
      doc.moveTo(L, ry + RH).lineTo(L + CW, ry + RH)
         .strokeColor("#e2e8f0").lineWidth(0.5).stroke();
      ry += RH;
    }

    // Table outer border
    doc.rect(L, TY, CW, HDH + RH * monthsData.length)
       .strokeColor(BLUE_L).lineWidth(1).stroke();

    // ─────────────────────────────────────────────────────────────────────
    // INCOMPLETE NAMES SECTION
    // ─────────────────────────────────────────────────────────────────────
    const incompleteMonths = monthsData.filter(
      m => m.status && !m.status.complete && m.status.missingNames?.length > 0
    );

    if (incompleteMonths.length > 0) {
      let y = ry + 22;

      // Section title
      doc.font(BOLD).fontSize(12).fill(BLUE_D)
         .text("รายชื่อแพทย์ที่ยังไม่ส่งคะแนน", L, y, { width: CW, lineBreak: false });
      y += 20;

      for (const { displayName, status } of incompleteMonths) {
        // Month sub-header bar
        doc.rect(L, y, CW, 22).fill(BLUE_L);
        doc.font(BOLD).fontSize(11).fill(BLUE_D)
           .text(displayName, L + 8, y + 5, { width: CW - 16, lineBreak: false });
        y += 26;

        // Names (2 per row to conserve space)
        doc.font(REG).fontSize(11).fill(DARK);
        const names = status.missingNames;
        for (let i = 0; i < names.length; i += 2) {
          const halfW = (CW - 24) / 2;
          doc.text(`• ${names[i]}`, L + 12, y, { width: halfW, lineBreak: false });
          if (names[i + 1]) {
            doc.text(`• ${names[i + 1]}`, L + 12 + halfW + 10, y, { width: halfW, lineBreak: false });
          }
          y += 18;
        }
        y += 8; // gap between months
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // FOOTER  (fixed at bottom of page)
    // ─────────────────────────────────────────────────────────────────────
    doc.font(REG).fontSize(9).fill(GRAY)
       .text("เอกสารนี้สร้างโดยระบบอัตโนมัติ — โรงพยาบาลสมุทรสาคร",
             L, PH - 38, { width: CW, align: "center", lineBreak: false });

    doc.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const todayStr = todayThaiStr();

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  P4P Score Tracker${DRY_RUN ? "  [DRY RUN]" : ""}  —  ${todayStr}`);
  console.log(`  Checking last ${CHECK_COUNT} months`);
  console.log(`${"═".repeat(62)}\n`);

  const months  = getPreviousMonths(CHECK_COUNT);
  const sb      = createSB();
  const gmail   = createGmailClient();

  console.log(`📅  Months: ${months.map(tableKeyToDisplay).join("  •  ")}\n`);

  // Discover all non-INTERN departments across the 4 months
  const depts = await getDistinctDepts(sb, months);
  if (!depts.length) {
    console.log("⚠️  No departments found — nothing to do.");
    return;
  }
  console.log(`🏥  Departments: ${depts.join(", ")}\n`);

  // ── Per-department processing ──────────────────────────────────────────
  const summaryRows = [];

  for (const dept of depts) {
    console.log(`┌─ ${dept}`);

    // Gather status for each of the 4 months
    const monthsData = [];
    for (const key of months) {
      const status = await getDeptStatus(sb, key, dept);
      monthsData.push({ key, displayName: tableKeyToDisplay(key), status });
    }

    // Log per-month status to console
    for (const { displayName, status } of monthsData) {
      if (!status) {
        console.log(`│   ${displayName}: — (ไม่พบข้อมูล)`);
      } else {
        const icon = status.complete ? "✓" : `✗ ค้าง ${status.missing}/${status.total}`;
        console.log(`│   ${displayName}: ${icon}`);
      }
    }

    // Find months that are NOW complete but NOT yet emailed
    const newlyComplete = [];
    for (const { key, displayName, status } of monthsData) {
      if (!status?.complete) continue;
      const alreadySent = await checkAlreadySent(sb, key, dept);
      if (!alreadySent) newlyComplete.push({ key, displayName });
    }

    if (!newlyComplete.length) {
      console.log(`└─ ไม่มีเดือนใหม่ที่ครบถ้วน — ข้ามไป\n`);
      summaryRows.push({ dept, newlyCount: 0, emailed: false, note: "ไม่มีเดือนใหม่ที่ครบถ้วน" });
      continue;
    }

    const newNames = newlyComplete.map(m => m.displayName).join(", ");
    console.log(`│   🎉 ครบถ้วนใหม่: ${newNames}`);

    // Generate PDF
    const pdfBuf = await generatePDF(dept, monthsData, todayStr);
    const nowTag  = new Date().toISOString().slice(0, 7); // "2026-06"
    const pdfFilename = `P4P_รายงาน_${dept}_${nowTag}.pdf`;
    console.log(`│   📄 PDF: ${pdfFilename} (${(pdfBuf.length / 1024).toFixed(0)} KB)`);

    // Look up dept head email
    const headEmail = DEPT_HEADS[dept];

    if (!headEmail) {
      console.log(`│   ⚠️  ยังไม่ได้กำหนดอีเมลหัวหน้ากลุ่มงาน "${dept}" ใน DEPT_HEADS_JSON`);
      summaryRows.push({ dept, newlyCount: newlyComplete.length, emailed: false, note: "ไม่พบอีเมลหัวหน้า" });
    } else if (DRY_RUN) {
      console.log(`│   🔍 DRY RUN — would send to ${headEmail}`);
      summaryRows.push({ dept, newlyCount: newlyComplete.length, emailed: false, note: `Dry run (${headEmail})` });
    } else {
      // Build email
      const html = buildScoreReportEmail({
        dept,
        newlyCompletedMonths : newlyComplete.map(m => m.displayName),
        monthsSummary        : monthsData.map(({ displayName, status }) => ({ displayName, status })),
        reportDate           : todayStr,
      });
      const subject = `รายงานสถานะ P4P กลุ่มงาน ${dept} — ${newNames}`;

      await gmail.sendMessage({
        to          : headEmail,
        subject,
        body        : `รายงานสถานะ P4P กลุ่มงาน ${dept}\nเดือนที่ครบถ้วน: ${newNames}\nดูรายละเอียดในไฟล์ PDF ที่แนบมา`,
        html,
        attachments : [{ filename: pdfFilename, mimeType: "application/pdf", buffer: pdfBuf }],
      });

      console.log(`│   ✉️  อีเมลส่งแล้ว → ${headEmail}`);
      summaryRows.push({ dept, newlyCount: newlyComplete.length, emailed: true, note: headEmail });

      // Log each newly-complete month so we never re-send
      for (const { key } of newlyComplete) {
        await logSent(sb, key, dept);
      }
      console.log(`│   💾 บันทึกสถานะแล้ว ${newlyComplete.length} เดือน`);
    }

    console.log(`└─ เสร็จสิ้น\n`);
  }

  // ── Console summary ────────────────────────────────────────────────────
  const emailedCount = summaryRows.filter(r => r.emailed).length;
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  สรุป: ${depts.length} กลุ่มงาน | ส่งอีเมล ${emailedCount} กลุ่ม`);
  console.log(`${"═".repeat(62)}\n`);

  // ── GitHub Step Summary ────────────────────────────────────────────────
  const monthLabels = months.map(tableKeyToDisplay).join(" · ");
  let md = `# 📈 P4P Score Tracker${DRY_RUN ? " *(Dry Run)*" : ""}\n\n`;
  md += `**วันที่:** ${todayStr}  \n`;
  md += `**เดือนที่ตรวจสอบ:** ${monthLabels}\n\n`;
  md += `| กลุ่มงาน | เดือนครบถ้วนใหม่ | ส่งอีเมล | หมายเหตุ |\n`;
  md += `|---|:---:|:---:|---|\n`;
  for (const r of summaryRows) {
    const emailIcon = r.emailed ? "✅" : (DRY_RUN && r.newlyCount > 0 ? "🔍" : "—");
    md += `| ${r.dept} | ${r.newlyCount} | ${emailIcon} | ${r.note} |\n`;
  }
  md += `\n---\n_Run at ${new Date().toISOString()}_\n`;

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, md, "utf8");
    console.log("📊 Step summary written to $GITHUB_STEP_SUMMARY");
  } else {
    console.log(md);
  }
}

main().catch(err => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
