/**
 * templates/score-report-email.js
 *
 * Builds the HTML notification email sent to a department head when P4P scores
 * are newly complete.  One email per unique head (a single head may oversee
 * multiple departments — all are included in one email).
 * Blue professional theme mirroring reply.js.
 *
 * @param {object} data
 * @param {Array}  data.depts        Array of per-department objects:
 *   {
 *     dept:                  string,    // department name
 *     newlyCompletedMonths:  string[],  // display names of newly-completed months
 *     monthsSummary:         Array<{ displayName: string, status: object|null }>
 *   }
 * @param {string} data.reportDate   Thai date string (e.g. "1 มิถุนายน 2569")
 */
export function buildScoreReportEmail({ depts, reportDate }) {
  const allNewlyCompleted = [...new Set(
    depts.flatMap(d => d.newlyCompletedMonths)
  )];

  // ── Per-department summary sections ────────────────────────────────────
  const deptSections = depts.map(({ dept, newlyCompletedMonths, monthsSummary }) => {
    const completedListHtml = newlyCompletedMonths
      .map(m => `<li style="padding:3px 0;color:#1e3a8a;font-weight:600">${m}</li>`)
      .join("");

    const tableRows = monthsSummary.map(({ displayName, status }) => {
      if (!status) {
        return `<tr>
          <td>${displayName}</td>
          <td colspan="3" style="text-align:center;color:#94a3b8;font-style:italic">ไม่พบข้อมูล</td>
          <td style="text-align:center"><span style="color:#94a3b8">—</span></td>
        </tr>`;
      }
      const badge = status.complete
        ? `<span style="background:#dcfce7;color:#16a34a;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">✓ ครบถ้วน</span>`
        : `<span style="background:#fee2e2;color:#dc2626;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">✗ ค้าง ${status.missing} คน</span>`;
      return `<tr>
        <td>${displayName}</td>
        <td style="text-align:center;font-weight:600">${status.total}</td>
        <td style="text-align:center;font-weight:700;color:#16a34a">${status.filled}</td>
        <td style="text-align:center;font-weight:700;color:${status.missing > 0 ? "#dc2626" : "#64748b"}">${status.missing}</td>
        <td style="text-align:center">${badge}</td>
      </tr>`;
    }).join("");

    return `
    <div class="dept-section">
      <div class="dept-heading">${dept}</div>

      ${newlyCompletedMonths.length ? `<div class="complete-banner">
        <div class="complete-banner-title">🎉 เดือนที่ครบถ้วนแล้ว (ใหม่)</div>
        <ul style="padding-left:20px;margin:0;list-style:disc">${completedListHtml}</ul>
      </div>` : ""}

      <table class="summary">
        <thead>
          <tr>
            <th style="width:38%">เดือน</th>
            <th>ทั้งหมด</th>
            <th>ส่งแล้ว</th>
            <th>ค้างส่ง</th>
            <th style="width:26%">สถานะ</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
  }).join("<hr class=\"dept-divider\">");

  // Subject hint for the greeting — list all dept names
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
  .card{background:#fff;max-width:620px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(30,58,138,.15)}
  .header{background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:28px 32px}
  .header h1{color:#fff;font-size:19px;font-weight:600;letter-spacing:.2px;line-height:1.45}
  .header p{color:#bfdbfe;font-size:13px;margin-top:5px;font-weight:400}
  .body{padding:28px 32px}
  .greeting{font-size:17px;color:#1d4ed8;font-weight:600;margin-bottom:14px}
  .intro{line-height:1.8;color:#334155;margin-bottom:20px;font-size:15px}
  .dept-section{margin-bottom:4px}
  .dept-heading{font-size:15px;font-weight:700;color:#1e3a8a;
    background:#eff6ff;border-left:4px solid #2563eb;
    padding:9px 14px;border-radius:0 8px 8px 0;margin-bottom:12px}
  .complete-banner{background:#eff6ff;border:1.5px solid #93c5fd;border-radius:10px;
    padding:12px 16px;margin-bottom:12px}
  .complete-banner-title{font-size:13px;font-weight:700;color:#1d4ed8;margin-bottom:6px}
  table.summary{width:100%;border-collapse:collapse;margin-bottom:4px}
  table.summary th{padding:8px 7px;font-size:12px;font-weight:700;color:#1d4ed8;
    text-align:left;border-bottom:2px solid #bfdbfe;background:#dbeafe}
  table.summary th:not(:first-child){text-align:center}
  table.summary td{padding:8px 7px;font-size:14px;vertical-align:middle;border-bottom:1px solid #dbeafe}
  table.summary tr:last-child td{border-bottom:none}
  hr.dept-divider{border:none;border-top:1.5px solid #dbeafe;margin:20px 0}
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
      ระบบได้ตรวจสอบสถานะการส่งคะแนน P4P เรียบร้อยแล้ว<br>
      สรุปผล 4 เดือนล่าสุดของแต่ละกลุ่มงานแสดงอยู่ด้านล่าง
      และมีไฟล์ PDF รายละเอียดแนบมาด้วย
    </p>

    ${deptSections}

    <p style="margin-top:16px;color:#334155;font-size:14px">
      ดูรายชื่อแพทย์ที่ค้างส่งได้ในไฟล์ PDF ที่แนบมา
    </p>

    <div class="note-box">
      <strong style="color:#1d4ed8;font-style:normal">หมายเหตุ</strong>
      อีเมลนี้ส่งอัตโนมัติเมื่อคะแนนของกลุ่มงานครบถ้วนเป็นครั้งแรก
      ระบบจะไม่ส่งซ้ำสำหรับเดือนที่รายงานแล้ว
    </div>
  </div>

  <div class="footer">อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ กรุณาอย่าตอบกลับ</div>

</div>
</body>
</html>`;
}
