// Run against the real, freshly built E2E app and a supervised tauri-wd driver.
// All application state and screenshots belong to an isolated temporary root.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppSession } from "./lib/app.mjs";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "don-desktop-review-"));
const application = path.join(
  cwd,
  "e2e/app/target/debug",
  process.platform === "win32" ? "donutbrowser-e2e.exe" : "donutbrowser-e2e",
);
const driverUrl = process.env.DONUT_E2E_DRIVER_URL;
assert.ok(
  driverUrl,
  "DONUT_E2E_DRIVER_URL must point to the local test driver",
);
const axeSource = process.env.DONUT_REVIEW_AXE_PATH
  ? await readFile(process.env.DONUT_REVIEW_AXE_PATH, "utf8")
  : null;
const results = { platform: process.platform, surfaces: [], navigationMs: [] };

async function inspect(app, name) {
  // Capture the settled surface; navigation timings are measured separately.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await app.capture(name);
  const surface = await app.execute(`
    const nav = document.querySelector('nav');
    const main = document.querySelector('main');
    const rect = main?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      mainBounds: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
      navWidth: nav?.getBoundingClientRect().width,
      activePages: nav?.querySelectorAll('[aria-current="page"]').length,
      unnamedNavButtons: [...(nav?.querySelectorAll('button') ?? [])]
        .filter(el => !el.getAttribute('aria-label') && !el.textContent.trim()).length,
      paints: performance.getEntriesByType('paint').map(p => ({name: p.name, ms: p.startTime})),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      dialogBackground: (() => {
        const el = document.querySelector('[role="dialog"]');
        return el ? getComputedStyle(el).backgroundColor : null;
      })()
    };
  `);
  assert.equal(surface.unnamedNavButtons, 0);
  if (surface.mainBounds) {
    assert.ok(surface.mainBounds[0] >= 0);
    assert.ok(surface.mainBounds[2] <= surface.viewport[0]);
  }
  if (axeSource) {
    await app.execute(axeSource);
    surface.accessibility = await app.session.executeAsync(`
      const done = arguments[arguments.length - 1];
      axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa']}})
        .then(result => done(result.violations.map(v => ({
          id: v.id, impact: v.impact,
          nodes: v.nodes.map(n => ({target: n.target, summary: n.failureSummary}))
        })))).catch(error => done({error: String(error)}));
    `);
  }
  results.surfaces.push({ name, ...surface });
}

async function review(onboardingCompleted) {
  const app = new AppSession({
    name: onboardingCompleted ? "workspace" : "welcome",
    root: path.join(root, onboardingCompleted ? "workspace" : "welcome"),
    application,
    driverUrl,
    cwd,
    onboardingCompleted,
  });
  try {
    const start = performance.now();
    await app.start();
    await app.waitForText(
      onboardingCompleted ? "No profiles yet" : "Welcome to Donut Browser",
    );
    results[onboardingCompleted ? "workspaceReadyMs" : "welcomeReadyMs"] =
      performance.now() - start;
    await app.session.command("POST", "/window/rect", {
      width: 1280,
      height: 800,
    });
    await inspect(app, onboardingCompleted ? "workspace-wide" : "welcome-wide");
    if (!onboardingCompleted) {
      await app.session.command("POST", "/window/rect", {
        width: 640,
        height: 480,
      });
      await inspect(app, "welcome-compact");
      await app.execute(`
        const dialog = document.querySelector('[role="dialog"]');
        dialog.scrollTop = dialog.scrollHeight;
      `);
      await inspect(app, "welcome-compact-actions");
      await app.clickText("Next", { roles: ["button"] });
      await app.waitForText("Licensing");
      await app.clickText("I understand", { roles: ["button"] });
      await app.waitFor(
        async () =>
          /Setting things up|Setup failed|Allow microphone/.test(
            await app.bodyText(),
          ),
        {
          description: "setup state",
        },
      );
      await inspect(app, "welcome-setup");
      // Fault injection at the real Tauri event boundary, not a mock page or
      // a claim that a published browser download was tested successfully.
      await app.invoke("plugin:event|emit", {
        event: "download-progress",
        payload: {
          browser: "wayfern",
          version: "desktop-review-fixture",
          stage: "error",
          downloaded_bytes: 0,
          total_bytes: null,
          percentage: 0,
          speed_bytes_per_sec: 0,
        },
      });
      await app.waitForText("Setup failed");
      assert.ok(
        await app.execute(
          "return Boolean(document.querySelector('[role=alert]'))",
        ),
      );
      await inspect(app, "welcome-error-event");
      return;
    }
    await app.clickText("Create profile", { roles: ["button"] });
    await inspect(app, "create-profile");
    await app.pressShortcut({ key: "Escape" });
    for (const label of [
      "Network",
      "Settings",
      "Profiles",
      "Settings",
      "Profiles",
    ]) {
      const elapsed = await app.session.executeAsync(
        `
        const label = arguments[0];
        const done = arguments[arguments.length - 1];
        const start = performance.now();
        document.querySelector('nav [aria-label="' + label + '"]').click();
        requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - start)));
      `,
        [label],
      );
      results.navigationMs.push({ label, ms: elapsed });
      await app.waitFor(
        () =>
          app.execute(
            "return document.querySelector('nav [aria-current=page]')?.getAttribute('aria-label') === arguments[0]",
            [label],
          ),
        { description: `navigation to ${label}` },
      );
      if (label !== "Profiles") await inspect(app, label.toLowerCase());
    }
    await app.clickSelector('[aria-label="More"]');
    assert.ok(
      await app.execute(
        "return Boolean(document.querySelector('[role=menu]'))",
      ),
    );
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(
      () => app.execute("return !document.querySelector('[role=menu]')"),
      { description: "menu dismissal including its exit transition" },
    );
    assert.equal(
      await app.execute(
        "return document.activeElement.getAttribute('aria-label')",
      ),
      "More",
    );
    await app.pressShortcut({ key: "\uE015" });
    await app.waitFor(
      () =>
        app.execute(
          "return document.activeElement.getAttribute('role') === 'menuitem'",
        ),
      { description: "ArrowDown opens More and focuses its first item" },
    );
    await inspect(app, "more-keyboard");
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(
      () => app.execute("return !document.querySelector('[role=menu]')"),
      { description: "keyboard menu closes" },
    );
    await app.session.command("POST", "/window/rect", {
      width: 800,
      height: 600,
    });
    await inspect(app, "workspace-compact");
    await app.pressShortcut({ key: "\uE004" });
    results.keyboardFocus = await app.execute(`
      const el = document.activeElement;
      return {tag: el.tagName, visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle};
    `);
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText("Appearance");
    await app.clickSelector("#theme-select");
    await app.clickText("Dark", { roles: ["option"] });
    await app.clickText("Save Settings", { roles: ["button"] });
    await app.waitFor(
      () =>
        app.execute(
          "return document.documentElement.classList.contains('dark') && !document.querySelector('#theme-select')",
        ),
      { description: "saved dark theme" },
    );
    await app.session.command("POST", "/window/rect", {
      width: 1280,
      height: 800,
    });
    await inspect(app, "workspace-dark");
  } finally {
    await app.close();
  }
}

try {
  await review(true);
  await review(false);
} finally {
  await writeFile(
    path.join(root, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(`Desktop review artifacts: ${root}`);
  console.log(JSON.stringify(results, null, 2));
}

if (axeSource) {
  for (const surface of results.surfaces) {
    assert.deepEqual(surface.accessibility, [], `${surface.name} WCAG audit`);
  }
}
