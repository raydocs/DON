import assert from "node:assert/strict";
import test from "node:test";

import { planDownloadErrorToast } from "./download-error-toast.ts";

const BROWSER = "Wayfern";
const VERSION = "151.0.7922.71";

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
