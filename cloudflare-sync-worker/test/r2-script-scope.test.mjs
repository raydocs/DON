import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

for (const name of [
  "backup-profiles-to-r2.sh",
  "restore-profiles-from-r2.sh",
]) {
  test(`${name} keeps R2 operations explicitly remote`, () => {
    const script = readFileSync(
      new URL(`../../scripts/${name}`, import.meta.url),
      "utf8",
    );
    const commands = script.match(/^npx wrangler r2 object (?:put|get) .+$/gm);
    assert.ok(commands?.length, "expected R2 object commands");
    for (const command of commands) {
      assert.match(command, /(?:^|\s)--remote(?:\s|$)/);
    }
  });
}
