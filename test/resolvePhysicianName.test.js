import { test } from "node:test";
import assert   from "node:assert/strict";
import { resolvePhysicianName } from "../claude-analyst.js";

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
