import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import { planDownloadErrorToast } from "./download-error-toast.ts";

const BROWSER = "Wayfern";
const VERSION = "151.0.7922.71";

async function downloadHarness() {
  const listeners = new Map();
  const toasts = new Map();
  let rejectDownload;
  const pending = new Promise((_, reject) => {
    rejectDownload = reject;
  });
  const modules = {
    "@tauri-apps/api/core": {
      invoke: async (command) => {
        if (command === "is_browser_supported_on_platform") return true;
        if (command === "download_browser") return pending;
        return [];
      },
    },
    "@tauri-apps/api/event": {
      listen: async (name, callback) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
    react: {
      useCallback: (callback) => callback,
      useEffect: (callback) => callback(),
      useState: (initial) => [initial, () => {}],
    },
    "@/i18n": { t: (key) => key },
    "@/lib/browser-utils": { getBrowserDisplayName: () => BROWSER },
    "@/lib/download-error-toast": { planDownloadErrorToast },
    "@/lib/onboarding-signal": { isOnboardingActive: () => false },
    "@/lib/toast-utils": {
      dismissToast: (id) => toasts.delete(id),
      showErrorToast: (title, options) => {
        toasts.set(options?.id ?? Symbol(), { title, ...options });
      },
    },
  };
  const source = readFileSync(
    new URL("../hooks/use-browser-download.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const context = {
    exports: {},
    require: (name) => {
      assert.ok(modules[name], `unexpected import: ${name}`);
      return modules[name];
    },
    console: { error: () => {} },
  };
  vm.runInNewContext(outputText, context);
  // biome-ignore lint/correctness/useHookAtTopLevel: React hooks are stubbed in this isolated event harness.
  const hook = context.exports.useBrowserDownload();
  await Promise.resolve();
  return {
    hook,
    toasts,
    rejectDownload,
    emitError: (version = VERSION) =>
      listeners.get("download-progress")({
        payload: {
          browser: "wayfern",
          version,
          stage: "error",
          error_type: "download_failed",
        },
      }),
  };
}

for (const eventFirst of [true, false]) {
  test(`one error toast when progress ${eventFirst ? "precedes" : "follows"} invoke rejection`, async () => {
    const harness = await downloadHarness();
    const result = assert.rejects(
      harness.hook.downloadBrowser("wayfern", VERSION),
      /network unavailable/,
    );
    if (eventFirst) await harness.emitError();
    harness.rejectDownload(new Error("network unavailable"));
    await result;
    if (!eventFirst) await harness.emitError();
    assert.equal(harness.toasts.size, 1);
    assert.equal(
      [...harness.toasts.values()][0].title,
      "browserDownload.toast.downloadFailed",
    );
  });
}

test("background failures remain visible and different versions remain distinct", async () => {
  const harness = await downloadHarness();
  await harness.emitError();
  await harness.emitError("another-version");
  assert.equal(harness.toasts.size, 2);
});

test("invoke failure without a progress event still shows the concrete error", async () => {
  const harness = await downloadHarness();
  const result = assert.rejects(
    harness.hook.downloadBrowser("wayfern", VERSION),
    /network unavailable/,
  );
  harness.rejectDownload("network unavailable");
  await result;
  assert.equal(harness.toasts.size, 1);
  assert.equal(
    [...harness.toasts.values()][0].description,
    "network unavailable",
  );
});

test("extraction_failed keeps the extraction-specific label and description", () => {
  const plan = planDownloadErrorToast("extraction_failed", BROWSER, VERSION);
  assert.equal(plan.titleKey, "browserDownload.toast.extractionFailed");
  assert.equal(
    plan.descriptionKey,
    "browserDownload.toast.extractionFailedDescription",
  );
  assert.deepEqual(plan.titleParams, { browser: BROWSER, version: VERSION });
});

test("verification_failed uses the dedicated verification title and description", () => {
  const plan = planDownloadErrorToast("verification_failed", BROWSER, VERSION);
  assert.equal(plan.titleKey, "browserDownload.toast.verificationFailed");
  assert.equal(
    plan.descriptionKey,
    "browserDownload.toast.verificationFailedDescription",
  );
  assert.deepEqual(plan.titleParams, { browser: BROWSER, version: VERSION });
});

test("download_timeout uses the generic download-failed title with a timeout description", () => {
  const plan = planDownloadErrorToast("download_timeout", BROWSER, VERSION);
  assert.equal(plan.titleKey, "browserDownload.toast.downloadFailed");
  assert.equal(
    plan.descriptionKey,
    "browserDownload.toast.downloadTimeoutDescription",
  );
  assert.deepEqual(plan.titleParams, { browser: BROWSER, version: VERSION });
});

test("download_failed uses the generic download-failed title and description", () => {
  const plan = planDownloadErrorToast("download_failed", BROWSER, VERSION);
  assert.equal(plan.titleKey, "browserDownload.toast.downloadFailed");
  assert.equal(
    plan.descriptionKey,
    "browserDownload.toast.downloadFailedDescription",
  );
  assert.deepEqual(plan.titleParams, { browser: BROWSER, version: VERSION });
});

test("an unknown error_type falls back to the generic download-failed title with no extraction wording", () => {
  const plan = planDownloadErrorToast("some_future_error", BROWSER, VERSION);
  assert.equal(plan.titleKey, "browserDownload.toast.downloadFailed");
  assert.equal(
    plan.descriptionKey,
    "browserDownload.toast.downloadFailedDescription",
  );
  assert.deepEqual(plan.titleParams, { browser: BROWSER, version: VERSION });
});

test("a missing error_type (old backend / non-error race) falls back to the generic download-failed title", () => {
  const plan = planDownloadErrorToast(undefined, BROWSER, VERSION);
  assert.equal(plan.titleKey, "browserDownload.toast.downloadFailed");
  assert.equal(
    plan.descriptionKey,
    "browserDownload.toast.downloadFailedDescription",
  );
  assert.deepEqual(plan.titleParams, { browser: BROWSER, version: VERSION });
});

test("no plan ever carries the extraction description on a non-extraction error_type", () => {
  // The bug was that every `stage: "error"` event rendered the extraction label.
  // Guard against a regression where a non-extraction type accidentally pulls
  // the "corrupt file was deleted" description.
  for (const errorType of [
    "download_failed",
    "verification_failed",
    "download_timeout",
    "something_new",
    undefined,
  ]) {
    const plan = planDownloadErrorToast(errorType, BROWSER, VERSION);
    assert.notEqual(
      plan.descriptionKey,
      "browserDownload.toast.extractionFailedDescription",
      `error_type=${errorType} must not surface the extraction description`,
    );
    assert.notEqual(
      plan.titleKey,
      "browserDownload.toast.extractionFailed",
      `error_type=${errorType} must not surface the extraction title`,
    );
  }
});
