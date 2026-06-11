/**
 * scripts/score-tracker.mjs
 *
 * Monthly P4P score-completion tracker.
 * Triggered on the 1st of every month by GitHub Actions.
 *
 * Logic:
 *  Phase 1 — Per-department: compute 3-month status, find newly-complete months.
 *  Phase 2 — Group by head email: departments sharing the same head email are
 *             batched into ONE email (one email per person, not per department).
 *  Phase 3 — Send: one email per unique address with one PDF attachment per
 *             department, then log each (month, dept) to email_sent_log.
 *
 * Required env vars (GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 *   DEPT_HEADS_JSON   — JSON object: dept name → head email (null = no email)
 *                       Keys must match the department values in Supabase exactly
 *                       (script trims whitespace when matching).
 *                       Example: {"ศัลยกรรม":"dr@h.com","เวชกรรมฟื้นฟู":null}
 * Optional:
 *   DRY_RUN           — "true" → check & report but do NOT send emails or log
 */

import { createClient }          from "@supabase/supabase-js";
import PDFDocument               from "pdfkit";
import { config as dotenvConfig } from "dotenv";
import { existsSync, appendFileSync } from "fs";
import { join, dirname }         from "path";
import { fileURLToPath }         from "url";
import { createGmailClient }     from "../gmail-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";

dotenvConfig({ override: true });

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Configuration ─────────────────────────────────────────────────────────
const DRY_RUN    = process.env.DRY_RUN === "true";
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

// ── Font paths (downloaded by the workflow step) ───────────────────────────
const FONT_REG  = join(__dir, "../fonts/Sarabun-Regular.ttf");
const FONT_BOLD = join(__dir, "../fonts/Sarabun-Bold.ttf");

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

async function getDeptStatus(sb, tableKey, dept) {
  const { data, error } = await sb
    .from(tableKey)
    .select("firstname, lastname, prefix, score, drive_file_id")
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
    .map(r => ({
      name       : `${r.prefix ?? ""}${r.firstname ?? ""} ${r.lastname ?? ""}`.trim(),
      score      : r.score,
      driveFileId: r.drive_file_id ?? null,
    }));

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


// ── PDF generation ─────────────────────────────────────────────────────────
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

    const hasReg  = existsSync(FONT_REG);
    const hasBold = existsSync(FONT_BOLD);
    if (!hasReg) console.warn("⚠️  Sarabun-Regular.ttf not found — Thai text may not render");
    if (hasReg)  doc.registerFont("SarabunReg",  FONT_REG);
    if (hasBold) doc.registerFont("SarabunBold", FONT_BOLD);
    const REG  = hasReg  ? "SarabunReg"  : "Helvetica";
    const BOLD = hasBold ? "SarabunBold" : "Helvetica-Bold";

    const PW  = doc.page.width;
    const PH  = doc.page.height;
    const L   = 50;
    const CW  = PW - 100;

    const BLUE_D  = "#1e3a8a";
    const BLUE_L  = "#dbeafe";
    const BLUE_BG = "#eff6ff";
    const DARK    = "#1e293b";
    const GRAY    = "#64748b";
    const GREEN   = "#16a34a";
    const RED     = "#dc2626";

    // Header band
    doc.rect(0, 0, PW, 90).fill(BLUE_D);
    doc.font(BOLD).fontSize(17).fill("#fff")
       .text(`รายงานสถานะ P4P — กลุ่มงาน ${dept}`, L, 18, { width: CW });
    doc.font(REG).fontSize(11).fill("#bfdbfe")
       .text(`โรงพยาบาลสมุทรสาคร  ·  จัดทำเมื่อ ${todayStr}`, L, 50, { width: CW, lineBreak: false });
    doc.font(REG).fontSize(10).fill("#93c5fd")
       .text("ตรวจสอบ 3 เดือนล่าสุด (ไม่รวมเดือนปัจจุบัน)", L, 68, { width: CW, lineBreak: false });

    // Summary table
    const TY  = 105;
    const HDH = 26;
    const RH  = 28;

    const COLS = [
      { label: "เดือน",          w: 165, align: "left"   },
      { label: "แพทย์ทั้งหมด", w: 82,  align: "center" },
      { label: "ส่งแล้ว",       w: 80,  align: "center" },
      { label: "ค้างส่ง",       w: 78,  align: "center" },
      { label: "สถานะ",         w: 90,  align: "center" },
    ];

    doc.rect(L, TY, CW, HDH).fill(BLUE_L);
    let cx = L;
    doc.font(BOLD).fontSize(11).fill(BLUE_D);
    for (const col of COLS) {
      doc.text(col.label, cx + 5, TY + 7, { width: col.w - 10, align: col.align, lineBreak: false });
      cx += col.w;
    }

    let ry = TY + HDH;
    for (let i = 0; i < monthsData.length; i++) {
      const { displayName, status } = monthsData[i];
      doc.rect(L, ry, CW, RH).fill(i % 2 === 0 ? "#fff" : BLUE_BG);
      cx = L;
      const CY = ry + 8;

      doc.font(REG).fontSize(12).fill(DARK)
         .text(displayName, cx + 5, CY, { width: COLS[0].w - 10, lineBreak: false });
      cx += COLS[0].w;

      if (!status) {
        doc.fill(GRAY).fontSize(11)
           .text("ไม่พบข้อมูล", cx + 5, CY, { width: CW - COLS[0].w - 10, align: "center", lineBreak: false });
      } else {
        doc.font(REG).fill(DARK).fontSize(12)
           .text(String(status.total), cx + 5, CY, { width: COLS[1].w - 10, align: "center", lineBreak: false });
        cx += COLS[1].w;
        doc.font(BOLD).fill(GREEN)
           .text(String(status.filled), cx + 5, CY, { width: COLS[2].w - 10, align: "center", lineBreak: false });
        cx += COLS[2].w;
        doc.fill(status.missing > 0 ? RED : DARK).font(status.missing > 0 ? BOLD : REG)
           .text(String(status.missing), cx + 5, CY, { width: COLS[3].w - 10, align: "center", lineBreak: false });
        cx += COLS[3].w;
        doc.fill(status.complete ? GREEN : RED).font(BOLD).fontSize(11)
           .text(status.complete ? "✓ ครบถ้วน" : "✗ ยังไม่ครบ", cx + 5, CY,
                 { width: COLS[4].w - 10, align: "center", lineBreak: false });
      }

      doc.moveTo(L, ry + RH).lineTo(L + CW, ry + RH).strokeColor("#e2e8f0").lineWidth(0.5).stroke();
      ry += RH;
    }
    doc.rect(L, TY, CW, HDH + RH * monthsData.length).strokeColor(BLUE_L).lineWidth(1).stroke();

    // Incomplete names section
    const incomplete = monthsData.filter(
      m => m.status && !m.status.complete && m.status.missingNames?.length > 0
    );
    if (incomplete.length > 0) {
      let y = ry + 22;
      doc.font(BOLD).fontSize(12).fill(BLUE_D)
         .text("รายชื่อแพทย์ที่ยังไม่ส่งคะแนน", L, y, { width: CW, lineBreak: false });
      y += 20;

      for (const { displayName, status } of incomplete) {
        doc.rect(L, y, CW, 22).fill(BLUE_L);
        doc.font(BOLD).fontSize(11).fill(BLUE_D)
           .text(displayName, L + 8, y + 5, { width: CW - 16, lineBreak: false });
        y += 26;

        doc.font(REG).fontSize(11).fill(DARK);
        const halfW = (CW - 24) / 2;
        for (let i = 0; i < status.missingNames.length; i += 2) {
          doc.text(`• ${status.missingNames[i]}`, L + 12, y, { width: halfW, lineBreak: false });
          if (status.missingNames[i + 1]) {
            doc.text(`• ${status.missingNames[i + 1]}`, L + 12 + halfW + 10, y,
                     { width: halfW, lineBreak: false });
          }
          y += 18;
        }
        y += 8;
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
  const todayStr = todayThaiStr();
  const nowTag   = new Date().toISOString().slice(0, 7); // "2026-06"

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  P4P Score Tracker${DRY_RUN ? "  [DRY RUN]" : ""}  —  ${todayStr}`);
  console.log(`  Checking last ${CHECK_COUNT} months`);
  console.log(`${"═".repeat(62)}\n`);

  const months = getPreviousMonths(CHECK_COUNT);
  const sb     = createSB();
  const gmail  = createGmailClient();

  console.log(`📅  Months: ${months.map(tableKeyToDisplay).join("  •  ")}\n`);

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
      const status = await getDeptStatus(sb, key, dept);
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

    if (DRY_RUN) {
      console.log(`    🔍 DRY RUN — ไม่ส่งอีเมลจริง`);
      for (const { dept } of deptList) {
        summaryRows.push({ dept, emailed: false, note: `Dry run → ${email}` });
      }
      continue;
    }

    // Generate one PDF per department
    const attachments = [];
    for (const { dept, monthsData } of deptList) {
      const buf = await generatePDF(dept, monthsData, todayStr);
      attachments.push({
        filename: `P4P_รายงาน_${dept}_${nowTag}.pdf`,
        mimeType: "application/pdf",
        buffer: buf,
      });
      console.log(`    📄 PDF: P4P_รายงาน_${dept}_${nowTag}.pdf (${(buf.length / 1024).toFixed(0)} KB)`);
    }

    // Build combined HTML email
    const html = buildScoreReportEmail({
      depts: deptList.map(d => ({
        dept        : d.dept,
        monthsSummary: d.monthsData.map(({ displayName, status }) => ({ displayName, status })),
      })),
      reportDate: todayStr,
    });

    const subject   = `รายงานสถานะ P4P ${deptNames} — ${todayStr}`;
    const plainBody = `รายงานสถานะ P4P\nกลุ่มงาน: ${deptNames}\nดูรายละเอียดในไฟล์ PDF ที่แนบ`;

    await gmail.sendMessage({ to: email, subject, body: plainBody, html, attachments });
    console.log(`    ✉️  ส่งแล้ว (${attachments.length} PDF แนบ)`);

    for (const { dept } of deptList) {
      summaryRows.push({ dept, emailed: true, note: email });
    }
  }

  for (const dept of noEmail) {
    summaryRows.push({ dept, emailed: false, note: "ไม่มีอีเมลหัวหน้า" });
  }

  writeSummary(summaryRows, months, todayStr, DRY_RUN);
}

// ── Step summary helper ────────────────────────────────────────────────────
function writeSummary(rows, months, todayStr, isDry) {
  const monthLabels = months.map(tableKeyToDisplay).join(" · ");
  let md = `# 📈 P4P Score Tracker${isDry ? " *(Dry Run)*" : ""}\n\n`;
  md += `**วันที่:** ${todayStr}  \n`;
  md += `**เดือนที่ตรวจสอบ:** ${monthLabels}\n\n`;

  if (!rows.length) {
    md += "_ไม่พบกลุ่มงานในช่วงนี้_\n";
  } else {
    md += `| กลุ่มงาน | ส่งอีเมล | หมายเหตุ |\n`;
    md += `|---|:---:|---|\n`;
    for (const r of rows) {
      const icon = r.emailed ? "✅" : (isDry ? "🔍" : "—");
      md += `| ${r.dept} | ${icon} | ${r.note} |\n`;
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
