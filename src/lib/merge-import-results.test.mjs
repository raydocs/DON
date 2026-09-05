import assert from "node:assert/strict";
import test from "node:test";
import { mergeImportResults } from "./merge-import-results.ts";

const row = (source_path, overrides = {}) => ({
  name: source_path,
  source_path,
  status: "imported",
  profile_id: `pid-${source_path}`,
  error: null,
  ...overrides,
});

const batch = (results) => ({
  imported_count: results.filter((r) => r.status === "imported").length,
  skipped_count: results.filter((r) => r.status === "skipped").length,
  failed_count: results.filter((r) => r.status === "failed").length,
  results,
});

test("a retried row overrides the previous row with the same source_path", () => {
  const previous = batch([
    row("a", { status: "imported" }),
    row("b", { status: "failed", error: "IMPORT_SOURCE_BROWSER_RUNNING" }),
  ]);
  const retry = batch([row("b", { status: "imported", error: null })]);

  const merged = mergeImportResults(previous, retry);

  assert.equal(merged.results.length, 2);
  const b = merged.results.find((r) => r.source_path === "b");
  assert.equal(b.status, "imported");
  assert.equal(b.error, null);
  assert.equal(merged.imported_count, 2);
  assert.equal(merged.failed_count, 0);
});

test("a non-retried row keeps its previous status verbatim", () => {
  const prevReport = { warnings: [], copied: [], skipped: [] };
  const previous = batch([
    row("a", {
      status: "imported",
      report: prevReport,
      profile_id: "keep-a",
    }),
    row("b", { status: "failed", error: "IMPORT_SOURCE_BROWSER_RUNNING" }),
  ]);
  const retry = batch([row("b", { status: "imported", error: null })]);

  const merged = mergeImportResults(previous, retry);

  const a = merged.results.find((r) => r.source_path === "a");
  assert.equal(a.status, "imported");
  assert.equal(a.profile_id, "keep-a");
  assert.deepEqual(a.report, prevReport);
});

test("counts are recomputed from the merged results, not either input batch", () => {
  const previous = batch([
    row("a", { status: "imported" }),
    row("b", { status: "failed", error: "IMPORT_SOURCE_BROWSER_RUNNING" }),
    row("c", { status: "failed", error: "IMPORT_SOURCE_BROWSER_RUNNING" }),
  ]);
  const retry = batch([
    row("b", { status: "imported" }),
    row("c", { status: "skipped" }),
  ]);

  const merged = mergeImportResults(previous, retry);

  assert.equal(merged.imported_count, 2);
  assert.equal(merged.skipped_count, 1);
  assert.equal(merged.failed_count, 0);
  assert.notEqual(merged.imported_count, previous.imported_count);
  assert.notEqual(merged.imported_count, retry.imported_count);
});

test("an empty retry leaves the previous results fully intact", () => {
  const previous = batch([
    row("a", { status: "imported" }),
    row("b", { status: "skipped" }),
    row("c", { status: "failed", error: "x" }),
  ]);
  const retry = batch([]);

  const merged = mergeImportResults(previous, retry);

  assert.deepEqual(merged.results, previous.results);
  assert.equal(merged.imported_count, 1);
  assert.equal(merged.skipped_count, 1);
  assert.equal(merged.failed_count, 1);
});

test("disjoint source_path sets leave all previous rows and counts unchanged", () => {
  const previous = batch([
    row("a", { status: "imported" }),
    row("b", { status: "failed", error: "IMPORT_SOURCE_BROWSER_RUNNING" }),
  ]);
  const retry = batch([row("z", { status: "imported" })]);

  const merged = mergeImportResults(previous, retry);

  const a = merged.results.find((r) => r.source_path === "a");
  const b = merged.results.find((r) => r.source_path === "b");
  assert.equal(a.status, "imported");
  assert.equal(b.status, "failed");
  assert.equal(b.error, "IMPORT_SOURCE_BROWSER_RUNNING");
  assert.equal(merged.results.length, 2);
  assert.equal(merged.imported_count, 1);
  assert.equal(merged.failed_count, 1);
});

test("row order follows the previous batch, not the retry batch", () => {
  const previous = batch([
    row("a", { status: "imported" }),
    row("b", { status: "failed", error: "IMPORT_SOURCE_BROWSER_RUNNING" }),
    row("c", { status: "skipped" }),
  ]);
  const retry = batch([
    row("c", { status: "imported" }),
    row("b", { status: "imported" }),
  ]);

  const merged = mergeImportResults(previous, retry);

  assert.deepEqual(
    merged.results.map((r) => r.source_path),
    ["a", "b", "c"],
  );
});
