import { test } from "node:test";
import assert   from "node:assert/strict";
import { isValidDate } from "../supabase-client.js";

test("valid BE date returns true", () => {
  assert.equal(isValidDate("2569_02"), true);
});

test("null returns false", () => {
  assert.equal(isValidDate(null), false);
});

test("undefined returns false", () => {
  assert.equal(isValidDate(undefined), false);
});

test("empty string returns false", () => {
  assert.equal(isValidDate(""), false);
});

test("old 0000_00 sentinel returns false", () => {
  assert.equal(isValidDate("0000_00"), false);
});

test("month 00 returns false", () => {
  assert.equal(isValidDate("2569_00"), false);
});

test("month 13 returns false", () => {
  assert.equal(isValidDate("2569_13"), false);
});

test("year too low (pre-BE range) returns false", () => {
  assert.equal(isValidDate("1999_06"), false);
});

test("year too high returns false", () => {
  assert.equal(isValidDate("2800_01"), false);
});

test("valid boundary: year 2400, month 01", () => {
  assert.equal(isValidDate("2400_01"), true);
});

test("valid boundary: year 2700, month 12", () => {
  assert.equal(isValidDate("2700_12"), true);
});

test("wrong format (no underscore) returns false", () => {
  assert.equal(isValidDate("256902"), false);
});
