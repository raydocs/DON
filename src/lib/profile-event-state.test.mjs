import assert from "node:assert/strict";
import test from "node:test";
import {
  updateAssignmentUsage,
  upsertProfileById,
} from "./profile-event-state.ts";

const profile = (id, overrides = {}) => ({ id, name: id, ...overrides });

test("profile updates replace only the matching item and preserve other references", () => {
  const first = profile("first");
  const second = profile("second");
  const updated = profile("first", { name: "updated" });

  const result = upsertProfileById([first, second], updated);

  assert.equal(result[0], updated);
  assert.equal(result[1], second);
});

test("an update for an unknown profile is appended without a full reload", () => {
  const first = profile("first");
  const added = profile("added");

  assert.deepEqual(upsertProfileById([first], added), [first, added]);
});

test("assignment usage moves one profile without rereading every profile", () => {
  const result = updateAssignmentUsage(
    {
      assignments: { first: "proxy-a", second: "proxy-a" },
      usage: { "proxy-a": 2 },
    },
    "first",
    "proxy-b",
  );

  assert.deepEqual(result.assignments, {
    first: "proxy-b",
    second: "proxy-a",
  });
  assert.deepEqual(result.usage, { "proxy-a": 1, "proxy-b": 1 });
});
