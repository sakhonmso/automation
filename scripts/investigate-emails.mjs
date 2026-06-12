/**
 * scripts/investigate-emails.mjs — one-off diagnostic.
 * Pulls the original emails from the two senders whose files failed name-match,
 * and inspects the physician-name cell inside each attached Excel file.
 */
import { config as dotenvConfig } from "dotenv";
import { createGmailClient }      from "../gmail-client.js";
import ExcelJS                    from "exceljs";

dotenvConfig({ override: true });

const SENDERS = ["warawutmatee@gmail.com", "patika_j@yahoo.com"];

function fmt(s, n = 90) { return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n); }

async function inspectExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((ws) => {
    out.push(`    Sheet: "${ws.name}"  (${ws.rowCount} rows × ${ws.columnCount} cols)`);
    // Dump the first 6 rows, first 4 cols — physician name is usually in the header area
    for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
      const cells = [];
      for (let c = 1; c <= Math.min(4, ws.columnCount); c++) {
        const v = ws.getRow(r).getCell(c).value;
        if (v !== null && v !== undefined && String(v).trim() !== "")
          cells.push(`[${r},${c}]="${fmt(String(v), 50)}"`);
      }
      if (cells.length) out.push(`      ${cells.join("  ")}`);
    }
  });
  return out.join("\n");
}

async function main() {
  const gmail = createGmailClient();

  for (const sender of SENDERS) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  FROM: ${sender}`);
    console.log(`${"═".repeat(70)}`);

    // Search all mail (inbox, archived, spam) from this sender
    const ids = await gmail.listMessages({
      query: `from:${sender}`,
      labelIds: [],          // no label filter → search everywhere
      maxResults: 10,
    });

    if (!ids.length) { console.log("  (no messages found)"); continue; }

    for (const { id } of ids) {
      const { msg, attachments } = await gmail.getMessageWithAttachments(id);
      console.log(`\n  ── Message ${id} ─────────────────────────────`);
      console.log(`    Date:    ${msg.date}`);
      console.log(`    Subject: ${fmt(msg.subject)}`);
      console.log(`    From:    ${fmt(msg.from)}`);
      console.log(`    Body:    ${fmt(msg.body, 200) || "(empty)"}`);
      console.log(`    Attachments: ${attachments.length}`);
      for (const att of attachments) {
        console.log(`      • ${att.filename}  (${att.mimeType}, ${att.size} bytes)`);
        if (/\.xlsx?$/i.test(att.filename)) {
          try {
            const buf = await gmail.downloadAttachment(id, att.attachmentId);
            console.log(await inspectExcel(buf));
          } catch (e) {
            console.log(`      ⚠️  Could not parse Excel: ${e.message}`);
          }
        }
      }
    }
  }
  console.log();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
