/**
 * templates/error-reply.js
 *
 * Builds the HTML alert-reply email sent to the sender when P4P processing fails.
 * Content is driven by errorType — no raw technical details are exposed to the user.
 *
 * @param {object} data
 * @param {string} data.safeFilename    Attachment filename(s), HTML-escaped (may be empty)
 * @param {"wrong_extension"|"file_link"|"wrong_date"|"physician_not_found"|"other"} data.errorType
 * @param {string} [data.detectedDate]  Date string extracted from file, shown when errorType="wrong_date"
 * @param {string} [data.detectedName]  Name extracted from file, shown when errorType="physician_not_found"
 */
export function buildHtmlErrorReply({ safeFilename = "", errorType = "other", detectedDate = "", detectedName = "" }) {
  const CONTENT = {
    wrong_extension: {
      bannerTitle  : "ประเภทไฟล์ไม่ถูกต้อง",
      bannerBody   : "ระบบรองรับเฉพาะไฟล์ <strong>.xlsx</strong> เท่านั้น<br>กรุณาแปลงไฟล์ให้ถูกต้องแล้วส่งมาใหม่อีกครั้ง",
      instruction  : "กรุณาเปิดไฟล์ใน Microsoft Excel แล้วบันทึกเป็นฟอร์แมต <strong>.xlsx</strong> ก่อนส่งใหม่อีกครั้ง",
    },
    file_link: {
      bannerTitle  : "ตรวจพบลิงก์ไฟล์แทนไฟล์จริง",
      bannerBody   : "ระบบไม่สามารถเข้าถึงไฟล์ผ่านลิงก์ได้<br>กรุณาแนบไฟล์ <strong>.xlsx</strong> โดยตรงในอีเมล",
      instruction  : "กรุณาดาวน์โหลดไฟล์ก่อน แล้วแนบไฟล์ <strong>.xlsx</strong> โดยตรงในอีเมล — ไม่ใช่ลิงก์",
    },
    zero_score: {
      bannerTitle  : "คะแนนรวมเป็นศูนย์",
      bannerBody   : "ระบบตรวจพบว่าคะแนนรวมในไฟล์มีค่าเป็น 0<br>กรุณาตรวจสอบว่าไฟล์ P4P มีข้อมูลคะแนนครบถ้วน",
      instruction  : "กรุณาตรวจสอบไฟล์ว่าคอลัมน์คะแนนมีข้อมูลและสูตรคำนวณถูกต้อง แล้วส่งไฟล์ใหม่อีกครั้ง",
    },
    wrong_date: {
      bannerTitle  : "วันที่/เดือน/ปี ในไฟล์ไม่ถูกต้อง",
      bannerBody   : "ระบบไม่พบข้อมูลสำหรับช่วงเวลาที่ระบุในไฟล์<br>กรุณาตรวจสอบว่าไฟล์ P4P ตรงกับเดือนและปีที่ถูกต้อง",
      instruction  : "กรุณาตรวจสอบชื่อไฟล์และข้อมูลภายในว่าระบุเดือน/ปีถูกต้อง แล้วส่งไฟล์ใหม่อีกครั้ง",
    },
    physician_not_found: {
      bannerTitle  : "ไม่พบชื่อแพทย์ในระบบ",
      bannerBody   : "ระบบไม่สามารถจับคู่ชื่อแพทย์จากไฟล์ที่ส่งมากับฐานข้อมูลได้<br>ไฟล์ยังไม่ถูกจัดเก็บและยังไม่มีการบันทึกคะแนน",
      instruction  : "กรุณาตรวจสอบว่าชื่อในไฟล์ตรงกับชื่อที่ลงทะเบียนในระบบ หากพบปัญหา กรุณาติดต่อเจ้าหน้าที่องค์กรแพทย์",
    },
    other: {
      bannerTitle  : "เกิดข้อผิดพลาดในการประมวลผล",
      bannerBody   : "ระบบไม่สามารถประมวลผลไฟล์ที่แนบมาได้<br>กรุณาตรวจสอบไฟล์และส่งใหม่อีกครั้ง",
      instruction  : "หากท่านเชื่อว่าไฟล์ถูกต้อง กรุณาติดต่อเจ้าหน้าที่องค์กรแพทย์เพื่อดำเนินการต่อไป",
    },
  };

  const c = CONTENT[errorType] ?? CONTENT.other;

  const filenameRow = safeFilename
    ? `<tr>
          <td>ไฟล์ที่แนบ</td>
          <td>${safeFilename}</td>
        </tr>`
    : "";

  const dateRow = detectedDate
    ? `<tr>
          <td>วันที่ที่ตรวจพบ</td>
          <td>${detectedDate}</td>
        </tr>`
    : "";

  const nameRow = detectedName
    ? `<tr>
          <td>ชื่อที่ตรวจพบ</td>
          <td>${detectedName}</td>
        </tr>`
    : "";

  const detailRows = filenameRow + dateRow + nameRow;

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#fdf2f2;font-family:'Sarabun',sans-serif;font-size:15px;color:#2d1a1a;padding:32px 16px}
  .card{background:#fff;max-width:540px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(180,30,30,.14)}
  .header{background:linear-gradient(135deg,#b91c1c,#dc2626);padding:28px 32px}
  .header h1{color:#fff;font-size:19px;font-weight:700;letter-spacing:.2px;line-height:1.4}
  .header p{color:#fca5a5;font-size:13px;margin-top:4px;font-weight:400}
  .body{padding:28px 32px}
  .alert-banner{background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;padding:16px 20px;margin-bottom:22px}
  .banner-title{font-size:15px;font-weight:700;color:#b91c1c;margin-bottom:5px}
  .banner-body{font-size:14px;color:#7f1d1d;line-height:1.7}
  .detail-card{background:#fff8f8;border-left:4px solid #dc2626;border-radius:0 10px 10px 0;padding:18px 22px;margin-bottom:24px}
  .detail-title{font-size:11.5px;font-weight:700;color:#b45454;text-transform:uppercase;letter-spacing:.7px;margin-bottom:13px}
  table{width:100%;border-collapse:collapse}
  td{padding:9px 0;font-size:14px;vertical-align:top}
  td:first-child{color:#92534e;width:38%;white-space:nowrap}
  td:last-child{font-weight:600;color:#5a1a1a;word-break:break-word}
  tr+tr td{border-top:1px solid #fecaca}
  .note{color:#92534e;line-height:1.8;font-size:14px;margin-bottom:8px}
  .footer{border-top:1px solid #fecaca;padding:15px 32px;background:#fff8f8;text-align:center;font-size:12px;color:#c07070}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>ไม่สามารถประมวลผลไฟล์ P4P ได้</h1>
    <p>อีเมลตอบกลับอัตโนมัติ — โรงพยาบาลสมุทรสาคร</p>
  </div>
  <div class="body">
    <div class="alert-banner">
      <div class="banner-title">${c.bannerTitle}</div>
      <div class="banner-body">${c.bannerBody}</div>
    </div>
    ${detailRows ? `<div class="detail-card">
      <div class="detail-title">รายละเอียด</div>
      <table>${detailRows}</table>
    </div>` : ""}
    <p class="note">${c.instruction}</p>
  </div>
  <div class="footer">อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ กรุณาอย่าตอบกลับ</div>
</div>
</body>
</html>`;
}
