import assert from "node:assert/strict";
import test from "node:test";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import { withApp } from "../lib/app.mjs";

// E2E for the cookie export dialog when a domain holds same-name cookies that
// differ by path (the bug: selection was keyed on `name` only). Seeds the
// collision through the real `import_pasted_cookies` command — the same path
// the dialog's data comes from — so the rows reach the frontend exactly as a
// user's profile would, then drives the export UI to confirm granular
// per-row toggling and an accurate "X of Y selected" counter.

async function createWayfernProfile(app, name) {
  // CRUD-focused suites use a deterministic stored fingerprint so they don't
  // need the real Wayfern binary on disk (which isn't present in this env).
  return app.invoke("create_browser_profile_new", {
    name,
    browserStr: "wayfern",
    version: "150.0.7871.100",
    releaseType: "stable",
    proxyId: null,
    vpnId: null,
    wayfernConfig: { fingerprint: "{}" },
    groupId: null,
    ephemeral: false,
    dnsBlocklist: null,
    launchHook: null,
  });
}

const SEED = JSON.stringify([
  {
    name: "sid",
    value: "root-value",
    domain: "fixture.local",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    expirationDate: 2_000_000_000,
  },
  {
    name: "sid",
    value: "app-value",
    domain: "fixture.local",
    path: "/app",
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    expirationDate: 2_000_000_000,
  },
  {
    name: "uid",
    value: "uid-value",
    domain: "fixture.local",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    expirationDate: 2_000_000_000,
  },
]);

function selectionStatus(selected, total) {
  return en.cookies.management.selectionStatus
    .replace("{{selected}}", String(selected))
    .replace("{{total}}", String(total));
}

const PATH_PREFIX = `${en.cookies.export.pathLabel}: `;

// Selector for the per-cookie checkboxes inside the export dialog. Radix
// Checkbox renders a button with role="checkbox"; older builds may use a
// native-ish control, so we match either.
const CHECKBOX_SELECTOR =
  '[role="dialog"] [role="checkbox"], [role="dialog"] button[type="button"][data-state]';

test("cookie export dialog toggles same-name cookies granularly and the counter matches", async () => {
  await withApp("ui-cookie-export-collisions", async (app) => {
    const profile = await createWayfernProfile(app, "Cookie Cols");
    const profileId = profile.id;

    // Seed the collision through the real write path the dialog's data comes
    // from. Two `sid` rows on different paths must both persist under the
    // backend unique index on (host_key, top_frame_site_key, name, path).
    const imported = await app.invoke("import_pasted_cookies", {
      profileId,
      content: SEED,
      site: null,
      mode: "merge",
      includeExpired: false,
    });
    assert.equal(imported.added, 3);

    const read = await app.invoke("read_profile_cookies", { profileId });
    assert.equal(read.total_count, 3);
    const domain = read.domains.find((d) => d.domain === "fixture.local");
    assert.ok(domain, "fixture.local domain present");
    assert.equal(domain.cookie_count, 3, "cookie_count counts rows, not names");
    assert.deepEqual(domain.cookies.map((c) => `${c.name}@${c.path}`).sort(), [
      "sid@/",
      "sid@/app",
      "uid@/",
    ]);

    // ---- Drive the dialog UI ----
    // The Cookie Management dialog is reached from the profile info dialog:
    // open it, switch to the Cookies section, and click its "Import" button,
    // which is wired to the `manageCookies` action that opens the dialog.
    await app.waitForText(profile.name);
    await app.clickText(en.profiles.aria.profileInfo, { roles: ["button"] });
    await app.waitForText(en.profileInfo.title);

    await app.clickText(en.profileInfo.sections.cookies, {
      exact: false,
      roles: ["button"],
    });
    await app.waitForText(en.profileInfo.sectionDesc.cookies);

    await app.clickText(en.common.buttons.import, { roles: ["button"] });
    await app.waitForText(en.cookies.management.title);

    // Switch to the Export tab; the dialog lazily loads cookies on first open.
    await app.clickText(en.cookies.management.tabExport, { roles: ["tab"] });

    // Initial selection: every row selected, counter reads "(3 of 3 selected)".
    await app.waitForText(selectionStatus(3, 3), 30_000);
    await app.waitForText(en.cookies.management.cookiesLabel);

    // Expand the fixture.local domain so its rows render.
    await app.clickText("fixture.local", { exact: false, roles: ["button"] });

    // Both same-name rows must be distinguishable by their rendered path.
    await app.waitForText(`${en.cookies.export.pathLabel}: /`, 20_000);
    await app.waitForText(`${en.cookies.export.pathLabel}: /app`);

    // Click the checkbox belonging to the `sid` row on path "/" specifically.
    // Selecting by visible text is ambiguous (two `sid` rows), so target the
    // checkbox inside the row whose path label is exactly "Path: /".
    await app.execute(
      `
      const prefix = arguments[0];
      const target = [...document.querySelectorAll(${JSON.stringify(CHECKBOX_SELECTOR)})]
        .find((el) => {
          const row = el.closest('div.flex.items-center');
          if (!row) return false;
          const spans = [...row.querySelectorAll('span')].map((s) => s.textContent.trim());
          return spans.includes(prefix + '/') && spans.includes('sid') &&
                 !spans.includes(prefix + '/app');
        });
      if (!target) throw new Error('sid@/ checkbox not found in export dialog');
      target.click();
      return true;
    `,
      [PATH_PREFIX],
    );

    // After unchecking exactly `sid` on `/`: 2 of 3 selected, and the `sid`
    // on `/app` row must remain checked (granular — the bug toggled both).
    await app.waitForText(selectionStatus(2, 3), 10_000);

    const granular = await app.execute(
      `
      const prefix = arguments[0];
      const rows = {};
      for (const el of document.querySelectorAll(${JSON.stringify(CHECKBOX_SELECTOR)})) {
        const row = el.closest('div.flex.items-center');
        if (!row) continue;
        const spans = [...row.querySelectorAll('span')].map((s) => s.textContent.trim());
        const pathSpan = spans.find((t) => t.startsWith(prefix));
        const nameSpan = spans.find((t) => t === 'sid' || t === 'uid');
        if (!pathSpan || !nameSpan) continue;
        const path = pathSpan.slice(prefix.length);
        const checked = el.getAttribute('aria-checked') === 'true' || el.dataset.state === 'checked';
        rows[nameSpan + '@' + path] = checked;
      }
      return rows;
    `,
      [PATH_PREFIX],
    );
    assert.equal(
      granular["sid@/"],
      false,
      "the clicked sid@/ row must be deselected",
    );
    assert.equal(
      granular["sid@/app"],
      true,
      "the same-name sid@/app row must stay selected (granular toggle)",
    );
    assert.equal(
      granular["uid@/"],
      true,
      "the unrelated uid row stays selected",
    );

    // ---- T11: the reset-to-all-selected path (used on reopen) re-keys every
    // row correctly. The "Select all" link re-runs the same
    // `initSelectionFromCookieData` that handleClose→reopen uses, so a partial
    // state must snap back to all-selected without losing the colliding row.
    // (Close/reopen via the layered dialogs is fragile to scope via WebDriver,
    // so the reset guarantee is exercised through the equivalent re-init path.)
    await app.clickText(en.cookies.management.selectAll, { roles: ["button"] });
    await app.waitForText(selectionStatus(3, 3), 10_000);
    // Closing the management dialog must work (resetExportState path).
    await app.execute(
      `
      const title = arguments[0];
      const cancel = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [data-slot="button"]')]
        .find((el) => {
          const dlg = el.closest('[role="dialog"]');
          return dlg && dlg.textContent.includes(title) && (el.innerText || el.textContent || '').trim() === ${JSON.stringify(en.common.buttons.cancel)};
        });
      if (!cancel) throw new Error('Cookie Management Cancel button not found');
      cancel.click();
      return true;
    `,
      [en.cookies.management.title],
    );
    await app.waitFor(
      async () => {
        const gone = await app.execute(
          `return [...document.querySelectorAll('[role="dialog"]')].every((d) => !d.textContent.includes(${JSON.stringify(en.cookies.management.title)}))`,
        );
        return gone === true;
      },
      { description: "Cookie Management dialog to close", timeoutMs: 10_000 },
    );
  });
});

const DISTINCT_SEED = JSON.stringify([
  {
    name: "token",
    value: "t1",
    domain: "fixture.local",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    expirationDate: 2_000_000_000,
  },
  {
    name: "theme",
    value: "dark",
    domain: "fixture.local",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    expirationDate: 2_000_000_000,
  },
]);

test("cookie export dialog keeps the distinct-name path unchanged (regression)", async () => {
  await withApp("ui-cookie-export-distinct", async (app) => {
    const profile = await createWayfernProfile(app, "Cookie Distinct");
    const profileId = profile.id;

    const imported = await app.invoke("import_pasted_cookies", {
      profileId,
      content: DISTINCT_SEED,
      site: null,
      mode: "merge",
      includeExpired: false,
    });
    assert.equal(imported.added, 2);

    const read = await app.invoke("read_profile_cookies", { profileId });
    assert.equal(read.total_count, 2);

    await app.waitForText(profile.name);
    await app.clickText(en.profiles.aria.profileInfo, { roles: ["button"] });
    await app.waitForText(en.profileInfo.title);
    await app.clickText(en.profileInfo.sections.cookies, {
      exact: false,
      roles: ["button"],
    });
    await app.waitForText(en.profileInfo.sectionDesc.cookies);
    await app.clickText(en.common.buttons.import, { roles: ["button"] });
    await app.waitForText(en.cookies.management.title);
    await app.clickText(en.cookies.management.tabExport, { roles: ["tab"] });

    // Distinct names: all-selected counter equals the row count, and toggling
    // one row drops the counter by exactly one (the pre-fix behaviour).
    await app.waitForText(selectionStatus(2, 2), 30_000);
    await app.clickText("fixture.local", { exact: false, roles: ["button"] });
    await app.waitForText(`${en.cookies.export.pathLabel}: /`, 20_000);

    // Toggle one of the two distinct rows: counter must read "1 of 2 selected".
    await app.execute(
      `
      const prefix = arguments[0];
      const target = [...document.querySelectorAll(${JSON.stringify(CHECKBOX_SELECTOR)})]
        .find((el) => {
          const row = el.closest('div.flex.items-center');
          if (!row) return false;
          const spans = [...row.querySelectorAll('span')].map((s) => s.textContent.trim());
          return spans.includes('token');
        });
      if (!target) throw new Error('token checkbox not found');
      target.click();
      return true;
    `,
      [PATH_PREFIX],
    );
    await app.waitForText(selectionStatus(1, 2), 10_000);
  });
});
