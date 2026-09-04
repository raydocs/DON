import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `DeleteGroupDialog` is always-mounted and reused across groups within a
 * single `GroupManagementDialog` session, and its `open` state is driven by a
 * controlled prop. Because the project's `useControlledState` does not re-fire
 * `onChange` when the parent flips the controlled `open` prop, the only
 * reliable reset paths are (a) `handleClose` on user-initiated closes and
 * (b) the open `useEffect` on (re)open. If the successful-delete branch closes
 * via the parent's `onClose()` directly, the destructive `deleteAction`
 * selection from a *previous* group leaks into the next group's dialog and can
 * cause permanent, unintended profile deletion.
 *
 * These tests pin the close-path wiring at the source level (the only
 * component-test idiom available in this repo, which has no React-rendering
 * test infrastructure) so the data-loss regression cannot silently return.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../components/delete-group-dialog.tsx", import.meta.url),
  ),
  "utf8",
);

function sliceCallback(name) {
  const start = SOURCE.indexOf(`const ${name} = useCallback`);
  assert.ok(start !== -1, `${name} must be defined`);
  const end = SOURCE.indexOf("\n  }, [", start);
  assert.ok(end !== -1, `${name} callback body must be found`);
  return SOURCE.slice(start, end);
}

test("handleClose resets the dialog to the safe default before closing", () => {
  const body = sliceCallback("handleClose");
  assert.match(body, /setError\(null\)/, "handleClose must clear the error");
  assert.match(
    body,
    /setDeleteAction\("move"\)/,
    'handleClose must reset deleteAction to the safe default "move"',
  );
  assert.match(
    body,
    /setAssociatedProfiles\(\[\]\)/,
    "handleClose must clear associatedProfiles",
  );
  assert.match(body, /onClose\(\)/, "handleClose must call the parent onClose");
});

test("the successful delete path closes via handleClose so internal state resets", () => {
  assert.match(
    SOURCE,
    /onGroupDeleted\(\);\s*\n\s*handleClose\(\);/,
    "the success branch must route through handleClose() so deleteAction is reset before the dialog closes",
  );
  assert.doesNotMatch(
    SOURCE,
    /onGroupDeleted\(\);\s*\n\s*onClose\(\);/,
    "the success branch must not bypass handleClose() by calling onClose() directly",
  );
});

test("handleDelete depends on handleClose (not onClose) so the reset is part of its memoized closure", () => {
  assert.match(
    SOURCE,
    /}, \[group, deleteAction, associatedProfiles, onGroupDeleted, handleClose, t\]\);/,
    "handleDelete's dependency array must include handleClose (the bare onClose is no longer a direct dependency)",
  );
  const body = sliceCallback("handleDelete");
  assert.doesNotMatch(
    body,
    /onClose\(\)/,
    "handleDelete must not call onClose() directly anymore",
  );
});

test("the dialog defensively resets deleteAction whenever it opens for any group", () => {
  assert.match(
    SOURCE,
    /useEffect\(\(\) => \{\s*if \(isOpen && group\) \{\s*setDeleteAction\("move"\);\s*void loadAssociatedProfiles\(\);\s*\}\s*\}, \[isOpen, group, loadAssociatedProfiles\]\);/,
    'the open effect must reset deleteAction to "move" before loading profiles so a stale selection from a prior group cannot leak into a new group',
  );
});

test("handleClose is declared before handleDelete to avoid a temporal-dead-zone dependency", () => {
  const handleCloseIdx = SOURCE.indexOf("const handleClose = useCallback");
  const handleDeleteIdx = SOURCE.indexOf("const handleDelete = useCallback");
  assert.ok(handleCloseIdx !== -1 && handleDeleteIdx !== -1);
  assert.ok(
    handleCloseIdx < handleDeleteIdx,
    "handleClose must be defined before handleDelete because handleDelete now depends on it",
  );
});

test("user-initiated close paths still reset state through handleClose", () => {
  assert.match(
    SOURCE,
    /<Dialog open=\{isOpen\} onOpenChange=\{handleClose\}>/,
    "Dialog.onOpenChange must keep routing through handleClose (Esc/overlay/X closes reset state)",
  );
  assert.match(
    SOURCE,
    /RippleButton[\s\S]*?variant="outline"[\s\S]*?onClick=\{handleClose\}/,
    "the Cancel button must keep routing through handleClose",
  );
});
