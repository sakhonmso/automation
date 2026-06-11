/**
 * templates/score-report-email.js
 *
 * Builds the HTML notification email sent to a department head on the 1st of
 * every month.  Shows per-physician score tables for the last 3 months.
 * Rows sorted: score DESC, blank scores at the bottom.
 * Physician names link to their Excel file on Google Drive (when available).
 * Blue professional theme.
 *
 * @param {object} data
 * @param {Array}  data.depts        Array of per-department objects:
 *   {
 *     dept:          string,
 *     monthsSummary: Array<{
 *       displayName: string,
 *       status: {
 *         total: number, filled: number, missing: number, complete: boolean,
 *         rows: Array<{ name: string, score: number|null, driveFileId: string|null }>
 *       } | null
 *     }>
 *   }
 * @param {string} data.reportDate   Thai date string (e.g. "1 มิถุนายน 2569")
 */
export function buildScoreReportEmail({ depts, reportDate }) {

  const driveLink = (id) => `https://drive.google.com/file/d/${id}/view`;

  // ── Per-department sections ───────────────────────────────────────────────
  const deptSections = depts.map(({ dept, monthsSummary }) => {

    const monthBlocks = monthsSummary.map(({ displayName, status }) => {
      if (!status) {
        return `
      <div class="month-block">
        <div class="month-header">
          <span class="month-name">${displayName}</span>
          <span class="badge badge-none">ไม่พบข้อมูล</span>
        </div>
      </div>`;
      }

      const badgeHtml = status.complete
        ? `<span class="badge badge-ok">ครบถ้วน ${status.total} คน</span>`
        : `<span class="badge badge-warn">ค้าง ${status.missing} / ${status.total} คน</span>`;

      const rowsHtml = status.rows.map(({ name, score, driveFileId }) => {
        const hasScore = score !== null;
        const scoreCell = hasScore ? String(Math.round(score)) : "—";
        const nameHtml = driveFileId
          ? `<a href="${driveLink(driveFileId)}" style="color:#1d4ed8;text-decoration:none">${name}</a>`
          : name;
        const rowStyle = hasScore ? "" : `style="background:#fef2f2"`;
        return `<tr ${rowStyle}>
            <td>${nameHtml}</td>
            <td style="text-align:center;font-weight:${hasScore ? "600" : "400"};color:${hasScore ? "#1e293b" : "#94a3b8"}">${scoreCell}</td>
          </tr>`;
      }).join("");

      return `
      <div class="month-block">
        <div class="month-header">
          <span class="month-name">${displayName}</span>
          ${badgeHtml}
        </div>
        <table class="physician-table">
          <thead>
            <tr>
              <th>ชื่อ-สกุล</th>
              <th style="width:80px;text-align:center">คะแนน</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
    }).join("");

    return `
    <div class="dept-section">
      <div class="dept-heading">${dept}</div>
      ${monthBlocks}
    </div>`;
  }).join(`<hr class="dept-divider">`);

  // Header title
  const deptNames = depts.map(d => d.dept).join(", ");
  const headerTitle = depts.length === 1
    ? `รายงานสถานะคะแนน P4P<br>กลุ่มงาน ${depts[0].dept}`
    : `รายงานสถานะคะแนน P4P<br>กลุ่มงาน ${deptNames}`;

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#eff6ff;font-family:'Sarabun',sans-serif;font-size:15px;color:#1e293b;padding:32px 16px}
  .card{background:#fff;max-width:640px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(30,58,138,.15)}
  .header{background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:28px 32px}
  .header h1{color:#fff;font-size:19px;font-weight:600;letter-spacing:.2px;line-height:1.45}
  .header p{color:#bfdbfe;font-size:13px;margin-top:5px}
  .body{padding:28px 32px}
  .greeting{font-size:17px;color:#1d4ed8;font-weight:600;margin-bottom:14px}
  .intro{line-height:1.8;color:#334155;margin-bottom:24px;font-size:15px}
  .dept-section{margin-bottom:4px}
  .dept-heading{font-size:15px;font-weight:700;color:#1e3a8a;background:#eff6ff;
    border-left:4px solid #2563eb;padding:9px 14px;border-radius:0 8px 8px 0;margin-bottom:14px}
  hr.dept-divider{border:none;border-top:1.5px solid #dbeafe;margin:20px 0}
  .month-block{margin-bottom:18px;border:1.5px solid #bfdbfe;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(30,58,138,.08)}
  .month-header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f0f7ff}
  .month-name{font-size:16px;font-weight:600;color:#1e3a8a;background:#dbeafe;
    padding:3px 10px;border-radius:6px}
  .badge{font-size:12px;font-weight:600;padding:4px 9px;border-radius:6px;display:inline-block;line-height:1.4;vertical-align:middle}
  .badge-ok{background:#dcfce7;color:#15803d}
  .badge-warn{background:#fee2e2;color:#b91c1c}
  .badge-none{background:#f1f5f9;color:#64748b}
  table.physician-table{width:100%;border-collapse:collapse}
  table.physician-table th{padding:7px 10px;font-size:15px;font-weight:600;color:#1d4ed8;
    text-align:left;border-bottom:2px solid #bfdbfe;background:#dbeafe}
  table.physician-table td{padding:9px 10px;font-size:15px;vertical-align:middle;
    border-bottom:1px solid #eff6ff}
  table.physician-table tr:last-child td{border-bottom:none}
  .note-box{margin-top:20px;font-size:13px;color:#64748b;line-height:1.7;
    border-top:1px solid #dbeafe;padding-top:16px;font-style:italic}
  .footer{border-top:1px solid #dbeafe;padding:15px 32px;background:#f0f9ff;
    text-align:center;font-size:12px;color:#60a5fa}
</style>
</head>
<body>
<div class="card">

  <div class="header">
    <h1>${headerTitle}</h1>
    <p>โรงพยาบาลสมุทรสาคร &nbsp;·&nbsp; ${reportDate}</p>
  </div>

  <div class="body">
    <p class="greeting">เรียน หัวหน้ากลุ่มงาน</p>
    <p class="intro">
      ระบบได้รวบรวมสถานะการส่งคะแนน P4P ของ 3 เดือนล่าสุดแล้ว กดชื่อแพทย์เพื่อเปิดไฟล์ Excel บน Google Drive
    </p>

    ${deptSections}

    <div class="note-box">
      <strong style="color:#1d4ed8;font-style:normal">หมายเหตุ</strong>
      อีเมลนี้ส่งอัตโนมัติทุกวันที่ 1 ของเดือน
    </div>
  </div>

  <div class="footer">อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ กรุณาอย่าตอบกลับ</div>

</div>
</body>
</html>`;
}
