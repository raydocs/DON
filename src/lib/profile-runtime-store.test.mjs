import assert from "node:assert/strict";
import test from "node:test";
import { createProfileRuntimeStore } from "./profile-runtime-store.ts";

const runtime = (overrides = {}) => ({
  isRunning: false,
  isLaunching: false,
  isStopping: false,
  isLockedByAnother: false,
  remoteHandoff: null,
  ...overrides,
});

test("runtime store notifies only the profile whose state changed", () => {
  const store = createProfileRuntimeStore({
    first: runtime(),
    second: runtime(),
  });
  let firstUpdates = 0;
  let secondUpdates = 0;
  store.subscribe("first", () => {
    firstUpdates += 1;
  });
  store.subscribe("second", () => {
    secondUpdates += 1;
  });

  store.replace({
    first: runtime({ isRunning: true }),
    second: runtime(),
  });

  assert.equal(firstUpdates, 1);
  assert.equal(secondUpdates, 0);
  assert.equal(store.getSnapshot("first")?.isRunning, true);
});

test("equivalent runtime snapshots keep their object identity", () => {
  const store = createProfileRuntimeStore({ first: runtime() });
  const before = store.getSnapshot("first");

  store.replace({ first: runtime() });

  assert.equal(store.getSnapshot("first"), before);
});
