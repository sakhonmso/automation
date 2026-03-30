import { test } from "node:test";
import assert   from "node:assert/strict";
import { similarity } from "../supabase-client.js";

test("exact match returns 1.0", () => {
  assert.equal(similarity("สมชาย ใจดี", "สมชาย ใจดี"), 1.0);
});

test("completely different returns low score", () => {
  assert.ok(similarity("สมชาย ใจดี", "กานดา มีสุข") < 0.5);
});

test("token overlap with 2 tokens scores 0.9", () => {
  assert.equal(similarity("สมชาย ใจดี", "สมชาย ใจดี เพิ่มเติม"), 0.9);
});

test("single-token name does NOT get 0.9 bonus (prevents false positives)", () => {
  // "สมชาย" alone should NOT score 0.9 against "สมชาย สมบูรณ์"
  assert.ok(similarity("สมชาย", "สมชาย สมบูรณ์") < 0.9);
});

test("extra whitespace is normalised", () => {
  assert.equal(similarity("สมชาย  ใจดี", "สมชาย ใจดี"), 1.0);
});

test("case-insensitive for latin chars", () => {
  assert.equal(similarity("somchai jaidee", "SOMCHAI JAIDEE"), 1.0);
});

test("empty strings return 1.0 (both empty = same)", () => {
  assert.equal(similarity("", ""), 1.0);
});
