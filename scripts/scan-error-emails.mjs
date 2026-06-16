/**
 * Temporary diagnostic: scan all P4P Gmail Processor run logs for error emails.
 * Runs in GitHub Actions. LOG_DIR is pre-populated by the workflow step before this.
 * Outputs: error-email-log.json in repo root.
 * Delete this script after use.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const LOG_DIR = process.env.LOG_DIR ?? "./logs";
const RUN_META = JSON.parse(process.env.RUN_META_JSON ?? "[]");

// Error patterns to detect in logs
const ERROR_PATTERNS = [
  { type: "physician_not_found", regex: /physician[_\s]not[_\s]found|ไม่พบ.*แพทย์|not.*found.*physician|physician.*not.*matched/i },
  { type: "wrong_date",          regex: /wrong[_\s]date|วันที่ไม่ตรง|date.*mismatch|wrong.*month/i },
  { type: "supabase_error",      regex: /supabase.*error|table.*not.*found|relation.*does not exist|❌.*supabase/i },
  { type: "error_email_sent",    regex: /📧.*error|error.*email|alert.*email|แจ้งเตือน|ส่งอีเมลแจ้ง/i },
  { type: "general_error",       regex: /^.*(❌ (Fatal|Error)|throw new Error|Unhandled rejection).*/i },
];

function scanText(text, runMeta) {
  const errors = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Strip GitHub Actions timestamp prefix (2026-06-16T14:35:49.123Z  )
    const raw  = lines[i];
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, "").trim();
    if (!line) continue;

    for (const { type, regex } of ERROR_PATTERNS) {
      if (regex.test(line)) {
        const ctxLines = lines
          .slice(Math.max(0, i - 2), i + 4)
          .map(l => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, "").trim())
          .filter(Boolean);
        const context = ctxLines.join("\n");
        const emailMatch = context.match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i);
        errors.push({
          runId:     runMeta?.id     ?? null,
          runNumber: runMeta?.number ?? null,
          createdAt: runMeta?.createdAt ?? null,
          conclusion:runMeta?.conclusion ?? null,
          errorType: type,
          line,
          email:     emailMatch?.[0] ?? null,
          context,
        });
        break;
      }
    }
  }
  return errors;
}

// Read run metadata map: filename (run id) → meta
const metaMap = {};
for (const m of RUN_META) metaMap[String(m.id)] = m;

// Walk log directory: each run has its own subdirectory named by run ID
const allErrors = [];
let filesScanned = 0;

function walkDir(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(full);
    } else if (entry.endsWith(".txt") || entry.endsWith(".log") || !entry.includes(".")) {
      // Determine run ID from path
      const parts = full.replace(/\\/g, "/").split("/");
      // The run ID directory is the first numeric segment under LOG_DIR
      const logDirNorm = LOG_DIR.replace(/\\/g, "/");
      const rel = full.replace(/\\/g, "/").replace(logDirNorm + "/", "");
      const runId = rel.split("/")[0];
      const meta = metaMap[runId] ?? null;

      try {
        const text = readFileSync(full, "utf8");
        const errs = scanText(text, meta);
        allErrors.push(...errs);
        filesScanned++;
      } catch {}
    }
  }
}

walkDir(LOG_DIR);

console.log(`📂 Files scanned: ${filesScanned}`);
console.log(`⚠️  Raw error events: ${allErrors.length}`);

// Deduplicate
const seen = new Set();
const deduped = allErrors.filter(e => {
  const key = `${e.runId}|${e.errorType}|${e.line.slice(0, 100)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Sort newest first
deduped.sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));

console.log(`✅ Unique error events after dedup: ${deduped.length}`);

const byType = {};
for (const e of deduped) byType[e.errorType] = (byType[e.errorType] ?? 0) + 1;
console.log("📊 By type:", JSON.stringify(byType));

const output = {
  generatedAt:      new Date().toISOString(),
  workflowName:     "P4P Gmail Processor",
  totalRunsScanned: RUN_META.length,
  filesScanned,
  totalErrors:      deduped.length,
  byType,
  errors: deduped,
};

writeFileSync("error-email-log.json", JSON.stringify(output, null, 2), "utf8");
console.log("💾 Saved → error-email-log.json");
