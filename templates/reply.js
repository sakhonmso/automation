/**
 * templates/reply.js
 *
 * Builds the HTML auto-reply email sent to physicians after P4P processing.
 * Keeping the template separate from business logic makes both easier to
 * maintain and style without touching pipeline code.
 *
 * @param {object} data
 * @param {string} data.displayName   Full name with prefix, already HTML-escaped
 * @param {string} data.safeDepartment Department string, HTML-escaped (may be empty)
 * @param {string} data.safeDisplayDate "เดือน ปี" string, HTML-escaped
 * @param {string} data.safeScore      Formatted score string, HTML-escaped
 */
export function buildHtmlReply({ displayName, safeDepartment, safeDisplayDate, safeScore }) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#e6f2ec;font-family:'Sarabun',sans-serif;font-size:15px;color:#1a2e22;padding:32px 16px}
  .card{background:#fff;max-width:540px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(5,104,57,.15)}
  .header{background:linear-gradient(135deg,#056839,#0a8a4a);padding:28px 32px}
  .header h1{color:#fff;font-size:19px;font-weight:600;letter-spacing:.2px}
  .header p{color:#a8d5bc;font-size:13px;margin-top:5px;font-weight:400}
  .body{padding:28px 32px}
  .greeting{font-size:17px;color:#056839;font-weight:600;margin-bottom:14px}
  .intro{line-height:1.8;color:#3a5a44;margin-bottom:22px;font-size:15px}
  .line-btn{display:block;background:#06c755;border-radius:10px;padding:13px 20px;margin-bottom:24px;text-decoration:none}
  .line-btn span{color:#fff;font-weight:600;font-size:14px;letter-spacing:.2px}
  .detail-card{background:#eef7f2;border-left:4px solid #056839;border-radius:0 10px 10px 0;padding:18px 22px;margin-bottom:24px}
  .detail-title{font-size:11.5px;font-weight:700;color:#6a9e7e;text-transform:uppercase;letter-spacing:.7px;margin-bottom:13px}
  table{width:100%;border-collapse:collapse}
  td{padding:9px 0;font-size:14px;vertical-align:middle}
  td:first-child{color:#4a7a5a;width:42%}
  td:last-child{font-weight:600;color:#033d21;text-align:right}
  tr+tr td{border-top:1px solid #cce8d8}
  .score-val{font-size:14px;color:#056839;font-weight:700}
  .thanks{color:#3a5a44;line-height:1.8;font-size:15px;margin-bottom:8px}
  .footer{border-top:1px solid #d4ebe0;padding:15px 32px;background:#f4fbf7;text-align:center;font-size:12px;color:#7aaa8a}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div>
        <h1>แจ้งผลการส่ง P4P ของแพทย์<br>โรงพยาบาลสมุทรสาคร</h1>
        <p>อีเมลตอบกลับอัตโนมัติ</p>
      </div>
    </div>
  </div>
  <div class="body">
    <p class="greeting">เรียน ${displayName}</p>
    <p class="intro">
      องค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว<br>
      ท่านสามารถตรวจสอบสถานะการส่งได้ที่
    </p>
    <a href="https://line.me/R/ti/p/%40703emfui" class="line-btn">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" valign="middle">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">
                  <img src="https://upload.wikimedia.org/wikipedia/commons/4/41/LINE_logo.svg" width="28" height="28" alt="LINE" style="display:block;border-radius:6px;background:#fff;padding:2px"/>
                </td>
                <td width="12"></td>
                <td valign="middle" style="color:#fff;font-weight:600;font-size:14px;letter-spacing:.2px;white-space:nowrap">LINE OA : SAKHONMSO</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </a>
    <div class="detail-card">
      <div class="detail-title">รายละเอียดไฟล์</div>
      <table>
        <tr>
          <td>ชื่อแพทย์</td>
          <td>${displayName}</td>
        </tr>
        ${safeDepartment ? `<tr>
          <td>กลุ่มงาน</td>
          <td>${safeDepartment}</td>
        </tr>` : ""}
        <tr>
          <td>เดือน / ปี</td>
          <td>${safeDisplayDate}</td>
        </tr>
        <tr>
          <td>คะแนนรวม</td>
          <td class="score-val">${safeScore}</td>
        </tr>
      </table>
    </div>
    <p class="thanks">ขอบคุณที่ให้ความร่วมมือเป็นอย่างดี</p>
    <p style="margin-top:18px;font-size:13px;color:#7a9a82;line-height:1.7;border-top:1px solid #d4ebe0;padding-top:16px;font-style:italic">
      <strong style="color:#056839;font-style:normal">หมายเหตุ</strong> หากท่านส่งไฟล์ฉบับแก้ไข หรือส่งไฟล์เดิมซ้ำ ระบบจะจัดเก็บไฟล์ใหม่นี้ แทนที่ไฟล์ของเดิม ทั้งนี้ เมื่อมีการเซ็นชื่อแล้ว จะไม่สามารถเปลี่ยนแปลงข้อมูลได้
    </p>
  </div>
  <div class="footer">อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ กรุณาอย่าตอบกลับ</div>
</div>
</body>
</html>`;
}
