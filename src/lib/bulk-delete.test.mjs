import assert from "node:assert/strict";
import test from "node:test";
import { selectBulkDeletable } from "./bulk-delete.ts";

const item = (id, rest = {}) => ({ id, ...rest });

test("selectBulkDeletable keeps items with zero usage", () => {
  const items = [item("a"), item("b"), item("c")];
  assert.deepEqual(selectBulkDeletable(items, {}), items);
  assert.deepEqual(selectBulkDeletable(items, { a: 0, b: 0, c: 0 }), items);
});

test("selectBulkDeletable drops items used by any profile, synced or not", () => {
  const free = item("free");
  const usedByOne = item("used-one");
  const usedByMany = item("used-many");
  const usage = { "used-one": 1, "used-many": 4 };

  assert.deepEqual(selectBulkDeletable([free, usedByOne, usedByMany], usage), [
    free,
  ]);
});

test("missing usage entries are treated as zero, so the item is deletable", () => {
  const a = item("a");
  const b = item("b");
  assert.deepEqual(selectBulkDeletable([a, b], { a: 3 }), [b]);
});

test("selectBulkDeletable preserves selection order and item identity", () => {
  const a = item("a");
  const b = item("b");
  const c = item("c");
  const out = selectBulkDeletable([a, b, c], { b: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0], a);
  assert.equal(out[1], c);
});

test("selectBulkDeletable returns [] when every selected item is in use", () => {
  const items = [item("a"), item("b")];
  const usage = { a: 1, b: 2 };
  assert.deepEqual(selectBulkDeletable(items, usage), []);
});

test("the all-profiles gate is strictly broader than a synced-only gate", () => {
  const usedOnlyByNonSynced = item("x");
  const usedOnlyBySynced = item("y");
  const allProfilesUsage = { x: 1, y: 1 };
  const syncedOnlyInUse = { x: false, y: true };

  assert.deepEqual(
    selectBulkDeletable(
      [usedOnlyByNonSynced, usedOnlyBySynced],
      allProfilesUsage,
    ),
    [],
  );

  const syncedGateWouldAllow = [usedOnlyByNonSynced, usedOnlyBySynced].filter(
    (i) => !syncedOnlyInUse[i.id],
  );
  assert.deepEqual(syncedGateWouldAllow, [usedOnlyByNonSynced]);

  assert.ok(
    syncedGateWouldAllow.length >
      selectBulkDeletable(
        [usedOnlyByNonSynced, usedOnlyBySynced],
        allProfilesUsage,
      ).length,
  );
});
