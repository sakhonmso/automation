import { test } from "node:test";
import assert   from "node:assert/strict";
import { resolvePhysicianName, resolvePhysicianNameFromSheet } from "../claude-analyst.js";

// ── Compound เดือน<month> should not be treated as a lastname ────────────────

test("เดือนมกราคม compound is not extracted as lastname", () => {
  // Filename: "P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx"
  // "เดือนมกราคม" = "month January" — not a lastname.
  // Expected: firstname-only "ศุภศรัณย์" (single-token for Supabase lookup)
  assert.equal(
    resolvePhysicianName("P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx", "", ""),
    "ศุภศรัณย์"
  );
});

test("each Thai month compound returns firstname only", () => {
  const months = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
  ];
  for (const month of months) {
    const result = resolvePhysicianName(`P4P พ ศุภศรัณย์ เดือน${month} 2569.xlsx`, "", "");
    assert.equal(result, "ศุภศรัณย์", `failed for เดือน${month}`);
  }
});

// ── Bare month name (no เดือน prefix) still rejected as lastname ─────────────

test("bare month name after firstname returns firstname only", () => {
  // "ศุภศรัณย์ มกราคม" — month is a separate token, not a lastname
  assert.equal(
    resolvePhysicianName("P4P ศุภศรัณย์ มกราคม 2569.xlsx", "", ""),
    "ศุภศรัณย์"
  );
});

// ── Normal two-word names still work ─────────────────────────────────────────

test("normal firstname lastname still extracted", () => {
  assert.equal(
    resolvePhysicianName("P4P นพ.สมชาย ใจดี มกราคม 2569.xlsx", "", ""),
    "สมชาย ใจดี"
  );
});

test("two-word name without title still extracted", () => {
  assert.equal(
    resolvePhysicianName("P4P_สมชาย_ใจดี_2569.xlsx", "", ""),
    "สมชาย ใจดี"
  );
});

// ── Firstname-only with title (Pattern 1 single-token) ───────────────────────

test("title prefix with firstname only and month discards month", () => {
  assert.equal(
    resolvePhysicianName("P4P นพ.ศุภศรัณย์ มีนาคม 2569.xlsx", "", ""),
    "ศุภศรัณย์"
  );
});

// ── Department name in filename is not treated as a lastname ──────────────────
// Real case: sender named the file "P4P วราวุธ อายุรกรรม เม.ย. 69.xlsx",
// putting the department ("อายุรกรรม") where the surname should go.

test("department word after firstname returns firstname only", () => {
  assert.equal(
    resolvePhysicianName("P4P วราวุธ อายุรกรรม เม.ย. 69.xlsx", "", ""),
    "วราวุธ"
  );
});

// ── Sheet-based fallback resolver ────────────────────────────────────────────

test("recovers titled name from a ชื่อแพทย์ header cell", () => {
  // Real case: filename mis-named, but the cell holds the correct name.
  const rows = [{ col_1: "ชื่อแพทย์ นพ. วราวุธ เมธีศิริวัฒน์" }];
  const got = resolvePhysicianNameFromSheet(rows, "รายงานP4Pสำหรับแพทย์");
  assert.ok(got.includes("วราวุธ เมธีศิริวัฒน์"), `got ${JSON.stringify(got)}`);
});

test("recovers name from the worksheet tab name", () => {
  // Real case: cell label is just dotted placeholder; name is the sheet tab.
  const rows = [{ col_1: "ชื่อแพทย์........................." }];
  const got = resolvePhysicianNameFromSheet(rows, "ปัทมิกา เจียรวุฒิสาร เมย.69");
  assert.ok(got.includes("ปัทมิกา เจียรวุฒิสาร"), `got ${JSON.stringify(got)}`);
});

test("dotted ชื่อแพทย์ placeholder yields no junk candidate", () => {
  // The label word itself must never become a candidate name.
  const rows = [{ col_1: "ชื่อแพทย์........................." }];
  const got = resolvePhysicianNameFromSheet(rows, "Sheet1");
  assert.ok(!got.includes("ชื่อแพทย์"), `got ${JSON.stringify(got)}`);
});
