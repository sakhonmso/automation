/**
 * Temporary: forward original attachments from error threads to sakhonmso@gmail.com
 * to create fresh test cases for the current P4P processor.
 *
 * Only forwards the SPECIFIC message+attachment that caused each physician_not_found error.
 * Skips wrong_date cases (those are correct behaviour, no fix needed).
 * Delete after use.
 */
import { google } from "googleapis";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ override: true });

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN)
  throw new Error("Missing Google OAuth env vars");

const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth });

// Test cases: threadId → which attachment file to pick (by filename substring)
// Using the thread that was closest to the error run
const TEST_CASES = [
  {
    sender: "my_fatty@hotmail.com",
    threadId: "19e964bfb0ded2d5",  // สฤษดิ์ชัย เมษายน 2569 .xlsx
    fileSubstring: "เมษายน",
    label: "สฤษดิ์ชัย (my_fatty) — firstname-only filename",
  },
  {
    sender: "artery_med@hotmail.com",
    threadId: "19de18b9652e8fe4",  // P4P จิรภัทร ชล เมษา2569.xlsx
    fileSubstring: "เมษา",
    label: "จิรภัทร (artery_med) — firstname + English/abbreviated month",
  },
  {
    sender: "mumagiovo@gmail.com",
    threadId: "19e67d9787b0862e",  // P4P ศวิตตา กุมาร เมษายน 69.xlsx
    fileSubstring: "กุมาร",
    label: "ศวิตตา (mumagiovo) — dept name parsed as surname",
  },
  {
    sender: "msirineen@gmail.com",
    threadId: "19c5207760fd2bf3",  // พ สิรินีร ตค 68.xlsx
    fileSubstring: "สิรินีร",
    label: "สิรินีร (msirineen) — title prefix + firstname only",
  },
  {
    sender: "y.sasima@gmail.com",
    threadId: "19cd8935f854d348",  // ศศิมา หยิบ ก.พ.69.xlsx
    fileSubstring: "หยิบ",
    label: "ศศิมา (y.sasima) — abbreviated surname",
  },
  {
    sender: "my-ammy@hotmail.com",
    threadId: "19daddaf619bc4eb",  // P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx
    fileSubstring: "มกราคม",
    label: "ศุภศรัณย์ (my-ammy) — firstname only",
  },
];

async function getAttachment(messageId, fileSubstring) {
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const parts = msg.data.payload?.parts ?? [];

  function walk(ps) {
    for (const p of ps) {
      if (p.filename?.includes(fileSubstring) && p.body?.attachmentId) return p;
      if (p.parts) {
        const found = walk(p.parts);
        if (found) return found;
      }
    }
    return null;
  }

  const part = walk(parts);
  if (!part) return null;

  const attRes = await gmail.users.messages.attachments.get({
    userId: "me", messageId, id: part.body.attachmentId,
  });

  return { filename: part.filename, data: attRes.data.data, mimeType: part.mimeType };
}

async function getFirstMessageWithFile(threadId, fileSubstring) {
  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  for (const msg of thread.data.messages ?? []) {
    const att = await getAttachment(msg.id, fileSubstring);
    if (att) return att;
  }
  return null;
}

function buildRaw(to, subject, filename, mimeType, b64data) {
  const boundary = "----=_Part_Test_" + Date.now();
  const parts = [
    `To: ${to}`,
    `From: ${to}`,
    `Subject: [TEST] ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `[ระบบทดสอบ] ส่งซ้ำไฟล์ P4P เพื่อทดสอบ physician_not_found fix`,
    `Original sender: (forwarded for testing)`,
    ``,
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64data,
    `--${boundary}--`,
  ].join("\r\n");

  return Buffer.from(parts).toString("base64url");
}

const ME = "sakhonmso@gmail.com";

for (const tc of TEST_CASES) {
  console.log(`\n📎  ${tc.label}`);
  console.log(`    Thread: ${tc.threadId}`);

  const att = await getFirstMessageWithFile(tc.threadId, tc.fileSubstring);
  if (!att) {
    console.warn(`    ⚠️  Attachment not found — skipping`);
    continue;
  }

  console.log(`    File: ${att.filename}`);

  const raw = buildRaw(
    ME,
    `ส่ง P4P (ทดสอบ) — ${att.filename}`,
    att.filename,
    att.mimeType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    att.data,
  );

  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`    ✅  Sent to inbox`);
}

console.log("\n✅ All test emails sent. Trigger P4P Gmail Processor to validate.");
