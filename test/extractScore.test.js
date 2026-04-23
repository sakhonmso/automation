import { test } from "node:test";
import assert   from "node:assert/strict";
import { extractScoreFromRows } from "../claude-analyst.js";

test("returns null for empty rows", () => {
  const { score } = extractScoreFromRows([]);
  assert.equal(score, null);
});

test("finds score from grand-total label row", () => {
  const rows = [
    { col_1: "ชื่อแพทย์", col_2: "กิจกรรม", col_5: "รวมแต้ม" },
    { col_1: null, col_2: "ตรวจผู้ป่วย", col_5: 100 },
    { col_1: "รวมแต้มทั้งหมด", col_5: 11011.5 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 11011.5);
  assert.match(method, /grand-total/);
});

test("finds score from sub-total label in first 3 cols", () => {
  const rows = [
    { col_1: "รวมแต้ม", col_4: 500 },
    { col_1: "รวมแต้ม", col_4: 800 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 800);
});

test("falls back to largest number when no label", () => {
  const rows = [
    { col_1: 10, col_2: 20 },
    { col_1: 5,  col_2: 999 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 999);
  assert.match(method, /largest/);
});

test("ignores year-like numbers", () => {
  const rows = [
    { col_1: 2569, col_2: 150 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 150);
});

test("grand-total label beats sub-total", () => {
  const rows = [
    { col_1: "รวมแต้ม", col_4: 500 },
    { col_1: "รวมแต้มทั้งหมด", col_4: 11011.5 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 11011.5);
  assert.match(method, /grand-total/);
});

test("extracts score when label and number share one cell", () => {
  // Real-world case: cell V75 = "รวมทั้งหมด  = 11011.5"
  // Other row data includes unrelated numbers (2200 threshold, day numbers)
  const rows = [
    { col_1: "เกณฑ์ขั้นต้น 2200 คะแนน" },
    { col_22: "รวมทั้งหมด  = 11011.5", col_3: "รับรองว่าผลถูกต้อง" },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 11011.5);
  assert.match(method, /grand-total/);
});

test("score in BE-year range (2400–2699) with decimals is not filtered as year-like", () => {
  // Bug: isYearLike(2408.56) was returning true because 2408 falls in the BE
  // range 2400–2699. But 2408.56 is a score (years are always integers).
  // The app was returning 2200 (threshold) instead of 2408.56.
  const rows = [
    { col_1: "เกณฑ์ขั้นต้น", col_2: 2200, col_3: "คะแนน" },
    { col_1: "item A", col_5: 1200.5 },
    { col_1: "item B", col_5: 1208.06 },
    { col_1: "รวมทั้งหมด", col_5: 2408.56 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2408.56);
  assert.match(method, /grand-total/);
});

test("integer score in BE-year range on a grand-total label row is not filtered", () => {
  // Bug: 2607 is an integer in the BE range (2400–2699), so isYearLike(2607)
  // returned true and the grand-total row was ignored. The app fell back to 2200.
  // Fix: year filter is skipped when the row is a confirmed grand-total label row.
  const rows = [
    { col_1: "เกณฑ์ขั้นต้น", col_2: 2200, col_3: "คะแนน" },
    { col_1: "item A", col_5: 800 },
    { col_1: "item B", col_5: 1807 },
    { col_1: "รวมแต้มทั้งหมด", col_5: 2607 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2607);
  assert.match(method, /grand-total/);
});
