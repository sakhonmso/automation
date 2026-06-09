/**
 * templates/score-report-email.js
 *
 * Builds the HTML notification email sent to a department head when P4P scores
 * are newly complete for one or more months.  Blue professional theme — mirrors
 * the card/table structure of reply.js.
 *
 * @param {object}   data
 * @param {string}   data.dept                     Department name (e.g. "OPD")
 * @param {string[]} data.newlyCompletedMonths      Display names of newly-completed months
 * @param {Array}    data.monthsSummary             Array of { displayName, status } covering all 4 months
 *   status = null  → table had no rows for this dept
 *   status = { total, filled, missing, complete }
 * @param {string}   data.reportDate               Thai date string (e.g. "1 มิถุนายน 2569")
 */
export function buildScoreReportEmail({ dept, newlyCompletedMonths, monthsSummary, reportDate }) {

  // ── Summary table rows ──────────────────────────────────────────────────
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

  // ── Newly-completed month list ───────────────────────────────────────────
  const completedListHtml = newlyCompletedMonths
    .map(m => `<li style="padding:3px 0;color:#1e3a8a;font-weight:600">${m}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#eff6ff;font-family:'Sarabun',sans-serif;font-size:15px;color:#1e293b;padding:32px 16px}
  .card{background:#fff;max-width:600px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(30,58,138,.15)}
  .header{background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:28px 32px}
  .header h1{color:#fff;font-size:19px;font-weight:600;letter-spacing:.2px;line-height:1.45}
  .header p{color:#bfdbfe;font-size:13px;margin-top:5px;font-weight:400}
  .body{padding:28px 32px}
  .greeting{font-size:17px;color:#1d4ed8;font-weight:600;margin-bottom:14px}
  .intro{line-height:1.8;color:#334155;margin-bottom:20px;font-size:15px}
  .complete-banner{background:#eff6ff;border:1.5px solid #93c5fd;border-radius:10px;padding:14px 18px;margin-bottom:22px}
  .complete-banner-title{font-size:14px;font-weight:700;color:#1d4ed8;margin-bottom:7px}
  .complete-banner ul{padding-left:20px;margin:0;list-style:disc}
  .detail-card{background:#eff6ff;border-left:4px solid #2563eb;border-radius:0 10px 10px 0;padding:18px 22px;margin-bottom:24px}
  .detail-title{font-size:11.5px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.7px;margin-bottom:13px}
  table.summary{width:100%;border-collapse:collapse}
  table.summary th{padding:9px 8px;font-size:12px;font-weight:700;color:#1d4ed8;text-align:left;border-bottom:2px solid #bfdbfe;background:#dbeafe}
  table.summary th:not(:first-child){text-align:center}
  table.summary td{padding:9px 8px;font-size:14px;vertical-align:middle;border-bottom:1px solid #dbeafe}
  table.summary tr:last-child td{border-bottom:none}
  .thanks{color:#334155;line-height:1.8;font-size:15px;margin-bottom:8px}
  .note-box{margin-top:18px;font-size:13px;color:#64748b;line-height:1.7;border-top:1px solid #dbeafe;padding-top:16px;font-style:italic}
  .footer{border-top:1px solid #dbeafe;padding:15px 32px;background:#f0f9ff;text-align:center;font-size:12px;color:#60a5fa}
</style>
</head>
<body>
<div class="card">

  <div class="header">
    <h1>รายงานสถานะคะแนน P4P<br>กลุ่มงาน ${dept}</h1>
    <p>โรงพยาบาลสมุทรสาคร &nbsp;·&nbsp; ${reportDate}</p>
  </div>

  <div class="body">
    <p class="greeting">เรียน หัวหน้ากลุ่มงาน ${dept}</p>
    <p class="intro">
      ระบบได้ตรวจสอบสถานะการส่งคะแนน P4P ของกลุ่มงาน <strong>${dept}</strong> เรียบร้อยแล้ว<br>
      สรุปผล 4 เดือนล่าสุดแสดงอยู่ด้านล่าง และมีรายละเอียดครบถ้วนในไฟล์ PDF ที่แนบมาด้วย
    </p>

    ${newlyCompletedMonths.length ? `<div class="complete-banner">
      <div class="complete-banner-title">🎉 เดือนที่ครบถ้วนแล้ว (ใหม่)</div>
      <ul>${completedListHtml}</ul>
    </div>` : ""}

    <div class="detail-card">
      <div class="detail-title">สรุปสถานะ 4 เดือนล่าสุด</div>
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
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <p class="thanks">ดูรายชื่อแพทย์ที่ค้างส่งได้ในเอกสาร PDF ที่แนบมาพร้อมอีเมลนี้</p>

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
