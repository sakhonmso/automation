/**
 * scripts/backfill-submissions.mjs
 *
 * One-off backfill of the p4p_submissions table for past months.
 *
 * Strategy (no Claude re-analysis needed):
 *   1. List all threads labelled "เอกสาร P4P" since BACKFILL_AFTER.
 *   2. In each thread, find the bot's SUCCESS auto-reply
 *      (subject "องค์กรแพทย์ รพ. สค."; body has "ชื่อแพทย์:" + "เดือน/ปี:").
 *      That reply proves the submission was processed successfully and
 *      carries the matched physician name + work month.
 *   3. Re-run matchName() against the month table to recover the canonical
 *      "firstname lastname" + department — identical to what the live hook
 *      in index.js stores, so backfilled rows are consistent with new ones.
 *   4. submitted_at = date of the physician's email that triggered that reply
 *      (latest non-bot message at/just before the reply).
 *   5. logSubmission() upserts (idempotent — safe to re-run).
 *
 * Only work months in TARGET_MONTHS are written (default: May→March 2569).
 *
 * Required env (GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 * Optional:
 *   TARGET_MONTHS   comma list, e.g. "2569_05,2569_04,2569_03" (default this)
 *   BACKFILL_AFTER  Gmail date, e.g. "2026/03/01" (default this)
 *   DRY_RUN         "true" to print without writing
 */

import { google }              from "googleapis";
import { config as dotenvConfig } from "dotenv";
import { appendFileSync }       from "fs";
import { createGmailClient }    from "../gmail-client.js";
import { matchName, logSubmission } from "../supabase-client.js";

dotenvConfig({ override: true });

const THAI_MONTHS = [
  "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม",
];
const THAI_MONTH_NUM = Object.fromEntries(THAI_MONTHS.map((m, i) => [m, i + 1]));

const BOT_ADDRESSES  = new Set(["sakhonmso@gmail.com"]);
const SUCCESS_SUBJECT = "องค์กรแพทย์";        // bot success reply subject contains this
const TARGET_MONTHS  = new Set(
  (process.env.TARGET_MONTHS || "2569_05,2569_04,2569_03").split(",").map((s) => s.trim())
);
const BACKFILL_AFTER = process.env.BACKFILL_AFTER || "2026/03/01";
const DRY_RUN        = /^true$/i.test(process.env.DRY_RUN || "");
const CONCURRENCY    = 8;

// ── Helpers ──────────────────────────────────────────────────────────────
const addrOf = (fromHeader) =>
  (fromHeader.match(/<(.+?)>/) ?? [, fromHeader])[1].trim().toLowerCase();

const isBot = (fromHeader) => BOT_ADDRESSES.has(addrOf(fromHeader));

const isExcel = (att) =>
  /\.xlsx$/i.test(att.filename || "") ||
  /spreadsheetml\.sheet|wps-office\.xlsx/i.test(att.mimeType || "");

/** Parse the bot success-reply body → { rawName, workMonth } or null. */
function parseSuccessReply(body) {
  const nameM = body.match(/ชื่อแพทย์:\s*([^\n\r]+)/);
  const dateM = body.match(/เดือน\/ปี:\s*([^\n\r]+)/);
  if (!nameM || !dateM) return null;

  const rawName = nameM[1].trim();
  const parts   = dateM[1].trim().split(/\s+/);
  const monthName = parts.find((p) => THAI_MONTH_NUM[p]);
  const yearTok   = parts.find((p) => /^\d{4}$/.test(p));
  if (!monthName || !yearTok) return null;

  const workMonth = `${yearTok}_${String(THAI_MONTH_NUM[monthName]).padStart(2, "0")}`;
  return { rawName, workMonth };
}

/** Strip prefix titles + collapse whitespace from a reply display name. */
function cleanName(raw) {
  let tokens = raw.replace(/\s+/g, " ").trim().split(" ");
  // drop leading prefix tokens: anything ending in "." or a known title word
  const TITLES = new Set(["นาย","นาง","นางสาว","นพ","พญ","ดร","ศ","รศ","ผศ"]);
  while (tokens.length > 2 && (tokens[0].includes(".") || TITLES.has(tokens[0].replace(/\./g, "")))) {
    tokens.shift();
  }
  return tokens.join(" ");
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const gmail  = google.gmail({ version: "v1", auth });
  const client = createGmailClient();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  P4P submission backfill`);
  console.log(`  Target months : ${[...TARGET_MONTHS].join(", ")}`);
  console.log(`  After         : ${BACKFILL_AFTER}`);
  console.log(`  Mode          : ${DRY_RUN ? "DRY RUN (no writes)" : "WRITE"}`);
  console.log(`${"═".repeat(60)}\n`);

  // 1. List candidate threads (paginated)
  const q = `label:"เอกสาร P4P" after:${BACKFILL_AFTER}`;
  const threads = [];
  let pageToken;
  do {
    const r = await gmail.users.threads.list({ userId: "me", q, maxResults: 500, pageToken });
    threads.push(...(r.data.threads ?? []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  console.log(`📨  ${threads.length} candidate thread(s)\n`);

  // 2-4. Extract submissions from each thread
  const found = []; // { physicianName, department, workMonth, submittedAt, threadId, filename }
  let scanned = 0;

  await mapLimit(threads, CONCURRENCY, async (t) => {
    let msgs;
    try {
      msgs = await client.getThreadMessages(t.id); // chronological (oldest first)
    } catch (e) {
      console.warn(`⚠️  thread ${t.id}: ${e.message}`);
      return;
    }
    scanned++;

    // attach a parsed timestamp to each message
    const withDates = msgs.map((m) => ({ ...m, _ts: new Date(m.msg.date).getTime() }));

    for (const reply of withDates) {
      if (!isBot(reply.msg.from)) continue;
      if (!reply.msg.subject.includes(SUCCESS_SUBJECT)) continue;
      const parsed = parseSuccessReply(reply.msg.body || "");
      if (!parsed) continue;
      if (!TARGET_MONTHS.has(parsed.workMonth)) continue;

      // physician's triggering message: latest non-bot message at/just before reply
      const candidates = withDates
        .filter((m) => !isBot(m.msg.from) && m._ts <= reply._ts)
        .sort((a, b) => b._ts - a._ts);
      const trigger = candidates[0] ?? withDates.find((m) => !isBot(m.msg.from));
      if (!trigger) continue;

      // filename (best effort): an xlsx in the trigger message, else any in thread
      const xAtt =
        (trigger.attachments || []).find(isExcel) ||
        withDates.flatMap((m) => m.attachments || []).find(isExcel);

      // 3. canonical name + department via the same matcher the live hook uses
      let physicianName = cleanName(parsed.rawName);
      let department = null;
      try {
        const m = await matchName(physicianName, parsed.workMonth);
        if (m) { physicianName = m.matchedName; department = m.department ?? null; }
      } catch { /* table missing/other — keep cleaned name */ }

      found.push({
        physicianName,
        department,
        workMonth   : parsed.workMonth,
        submittedAt : new Date(trigger.msg.date).toISOString(),
        threadId    : t.id,
        filename    : xAtt?.filename ?? null,
      });
    }
  });

  // De-dup within this run: keep earliest submittedAt per (name, month)
  const byKey = new Map();
  for (const s of found) {
    const k = `${s.physicianName}||${s.workMonth}`;
    const prev = byKey.get(k);
    if (!prev || s.submittedAt < prev.submittedAt) byKey.set(k, s);
  }
  const submissions = [...byKey.values()];

  // Report per month
  const perMonth = {};
  for (const s of submissions) (perMonth[s.workMonth] ??= []).push(s);

  console.log(`🔎  Scanned ${scanned} threads → ${submissions.length} unique submission(s)\n`);
  for (const month of [...TARGET_MONTHS]) {
    const list = (perMonth[month] ?? []).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    console.log(`📅  ${month}: ${list.length} submission(s)`);
    list.forEach((s, i) =>
      console.log(`     ${String(i + 1).padStart(2)}. ${s.submittedAt}  ${s.physicianName}  (${s.department ?? "—"})`)
    );
    console.log();
  }

  // 5. Write
  let written = 0, failed = 0;
  if (!DRY_RUN) {
    for (const s of submissions) {
      try { await logSubmission(s); written++; }
      catch (e) { failed++; console.error(`❌  ${s.physicianName} ${s.workMonth}: ${e.message}`); }
    }
    console.log(`💾  Upserted ${written} row(s)${failed ? `, ${failed} failed` : ""}.`);
  } else {
    console.log(`🟡  DRY RUN — nothing written.`);
  }

  // Step summary
  const sp = process.env.GITHUB_STEP_SUMMARY;
  if (sp) {
    let md = `# 🗂️ P4P Submission Backfill\n\n`;
    md += `**Mode:** ${DRY_RUN ? "DRY RUN" : "WRITE"} · **Threads scanned:** ${scanned} · **Submissions:** ${submissions.length}`;
    if (!DRY_RUN) md += ` · **Upserted:** ${written}${failed ? ` (${failed} failed)` : ""}`;
    md += `\n\n`;
    for (const month of [...TARGET_MONTHS]) {
      const list = (perMonth[month] ?? []).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
      md += `## ${month} — ${list.length} ราย\n\n`;
      if (list.length) {
        md += `| # | เวลาส่ง | ชื่อ | แผนก |\n|---|---|---|---|\n`;
        list.forEach((s, i) => {
          md += `| ${i + 1} | ${s.submittedAt} | ${s.physicianName} | ${s.department ?? "—"} |\n`;
        });
      } else md += `_ไม่พบ_\n`;
      md += `\n`;
    }
    appendFileSync(sp, md, "utf8");
    console.log("\n📊 Step summary written");
  }
}

main().catch((err) => { console.error("\n❌ Fatal:", err.message); process.exit(1); });
