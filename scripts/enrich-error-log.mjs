/**
 * Temporary diagnostic: enrich error-email-log.json with Gmail thread data.
 * For each real error sender, searches label "เอกสาร P4P" for their thread,
 * then adds threadId, subject, originalFilename to the JSON.
 * Delete after use.
 */
import { readFileSync, writeFileSync } from "fs";
import { google } from "googleapis";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN)
  throw new Error("Missing Google OAuth env vars");

const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth });

// Real error senders only (exclude no-reply@accounts.google.com and sakhonmso@gmail.com relay msgs)
const REAL_ERROR_SENDERS = [
  "warawutmatee@gmail.com",
  "patika_j@yahoo.com",
  "my_fatty@hotmail.com",
  "artery_med@hotmail.com",
  "mumagiovo@gmail.com",
  "msirineen@gmail.com",
  "y.sasima@gmail.com",
  "my-ammy@hotmail.com",
  "pwtn_@docchula.com",
  "skch1136@gmail.com",
  "innzmd92@gmail.com",
];

// Find label ID for "เอกสาร P4P"
const labelsRes = await gmail.users.labels.list({ userId: "me" });
const label = (labelsRes.data.labels ?? []).find(l => l.name === "เอกสาร P4P");
if (!label) throw new Error('Label "เอกสาร P4P" not found');
console.log(`✅ Label id: ${label.id}`);

async function getAttachmentFilenames(messageId) {
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const parts = msg.data.payload?.parts ?? [];
  const filenames = [];
  function walk(ps) {
    for (const p of ps) {
      if (p.filename && p.filename.length > 0) filenames.push(p.filename);
      if (p.parts) walk(p.parts);
    }
  }
  walk(parts);
  // Also check top-level
  if (msg.data.payload?.filename) filenames.push(msg.data.payload.filename);
  return filenames;
}

async function getThreadSubjectAndFiles(threadId) {
  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata",
    metadataHeaders: ["Subject", "From", "Date"] });
  const msgs = thread.data.messages ?? [];
  // Find first message with xlsx attachment (original sender message)
  let subject = null;
  let originalFilenames = [];
  let from = null;
  let date = null;

  for (const msg of msgs) {
    const subjectHeader = msg.payload?.headers?.find(h => h.name === "Subject");
    const fromHeader    = msg.payload?.headers?.find(h => h.name === "From");
    const dateHeader    = msg.payload?.headers?.find(h => h.name === "Date");
    if (!subject && subjectHeader) subject = subjectHeader.value;
    if (!from && fromHeader) from = fromHeader.value;
    if (!date && dateHeader) date = dateHeader.value;
    // Get full message to find attachments
    const fullMsg = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const parts = fullMsg.data.payload?.parts ?? [];
    function walk(ps) {
      for (const p of ps) {
        if (p.filename?.match(/\.(xlsx|xls|csv)$/i)) originalFilenames.push(p.filename);
        if (p.parts) walk(p.parts);
      }
    }
    walk(parts);
    if (originalFilenames.length) break; // stop at first message with xlsx
  }

  return { subject, from, date, originalFilenames };
}

// Search threads per sender
const senderThreadMap = {}; // email → [{threadId, subject, originalFilenames, date}]

for (const sender of REAL_ERROR_SENDERS) {
  console.log(`\n🔍 Searching threads from: ${sender}`);
  const q = `from:${sender} label:เอกสาร-P4P`;
  let threads = [];
  let pageToken;
  do {
    const res = await gmail.users.threads.list({ userId: "me", q, maxResults: 50, pageToken });
    threads.push(...(res.data.threads ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`   Found ${threads.length} thread(s)`);
  const results = [];
  for (const t of threads) {
    try {
      const info = await getThreadSubjectAndFiles(t.id);
      results.push({ threadId: t.id, ...info });
      console.log(`   Thread ${t.id}: "${info.subject}" | files: ${info.originalFilenames.join(", ") || "none"}`);
    } catch (e) {
      console.warn(`   ⚠️ Thread ${t.id}: ${e.message}`);
    }
  }
  senderThreadMap[sender] = results;
}

// Load error log
const log = JSON.parse(readFileSync("error-email-log.json", "utf8"));

// Enrich: for each error entry with a real sender email, find matching threads
// Match by sender email and approximate date (within 3 days of run)
for (const entry of log.errors) {
  const sender = entry.email;
  if (!sender || !REAL_ERROR_SENDERS.includes(sender)) {
    entry.threadId         = null;
    entry.originalSubject  = null;
    entry.originalFilename = null;
    entry.originalFrom     = null;
    entry.rootCause        = classifyRootCause(entry);
    entry.testResult       = null;
    continue;
  }

  const threads = senderThreadMap[sender] ?? [];
  const runDate = new Date(entry.createdAt);

  // Pick the thread closest to the run date (within 7 days before)
  let best = null;
  let bestDiff = Infinity;
  for (const t of threads) {
    const tDate = t.date ? new Date(t.date) : null;
    if (!tDate) continue;
    const diff = runDate - tDate; // positive = run happened after email
    if (diff >= 0 && diff < 7 * 86400_000 && diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }

  // Fallback: just pick the most recent thread if no date match
  if (!best && threads.length > 0) best = threads[0];

  entry.threadId         = best?.threadId        ?? null;
  entry.originalSubject  = best?.subject         ?? null;
  entry.originalFilename = best?.originalFilenames?.[0] ?? null;
  entry.originalFrom     = best?.from            ?? null;
  entry.rootCause        = classifyRootCause(entry);
  entry.testResult       = null;
}

function classifyRootCause(entry) {
  if (!REAL_ERROR_SENDERS.includes(entry.email)) return "noise_google_alert";
  if (entry.errorType === "supabase_error" && !entry.email) return "transient_502";
  if (entry.errorType === "wrong_date") return "wrong_date_in_file";
  if (entry.errorType === "physician_not_found") return "wrong_filename_pattern";
  if (entry.errorType === "supabase_error") return "supabase_table_not_found";
  return "unknown";
}

// Update metadata
log.generatedAt   = new Date().toISOString();
log.enrichedAt    = new Date().toISOString();
log.senderThreads = senderThreadMap;

writeFileSync("error-email-log.json", JSON.stringify(log, null, 2), "utf8");
console.log("\n💾 Saved enriched error-email-log.json");

// Print summary
console.log("\n📋 Thread lookup summary:");
for (const [sender, threads] of Object.entries(senderThreadMap)) {
  console.log(`  ${sender}: ${threads.length} thread(s) found`);
  for (const t of threads) {
    console.log(`    → [${t.threadId}] "${t.subject}" | ${t.originalFilenames.join(", ")}`);
  }
}
