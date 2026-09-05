/**
 * Discriminator the Rust backend attaches to terminal `stage: "error"`
 * `download-progress` events. The backend uses `stage: "error"` as a generic
 * marker for several unrelated failure modes, so `DownloadProgress.error_type`
 * carries the specific cause and this helper maps it to an accurate toast
 * label instead of treating every error as an extraction failure.
 */
export type DownloadErrorType =
  | "download_failed"
  | "extraction_failed"
  | "verification_failed"
  | "download_timeout";

export interface DownloadErrorToastPlan {
  /** i18n key for the toast title. */
  titleKey: string;
  /** Interpolation params for {@link titleKey}. */
  titleParams: { browser: string; version: string };
  /** i18n key for the toast description. Every error type has one. */
  descriptionKey: string;
}

/**
 * Plans the toast content for a `download-progress` event whose `stage` is
 * `"error"`. The Rust backend emits `stage: "error"` for download-phase
 * failures, extraction failures, verification failures, and background
 * auto-download timeouts; without an `error_type` the listener cannot tell
 * them apart and historically mislabeled all of them as "extraction failed".
 *
 * `extraction_failed` keeps the existing extraction-specific label and
 * description, which are accurate for that one path. The other types map to a
 * generic "download failed" title (verification gets its own title), with no
 * factually-wrong "corrupt file was deleted" wording. Unknown / missing
 * `errorType` values fall back to the generic `downloadFailed` keys so a future
 * backend error type is never mislabeled as an extraction failure.
 */
export function planDownloadErrorToast(
  errorType: string | undefined,
  browser: string,
  version: string,
): DownloadErrorToastPlan {
  const titleParams = { browser, version };
  switch (errorType) {
    case "extraction_failed":
      return {
        titleKey: "browserDownload.toast.extractionFailed",
        titleParams,
        descriptionKey: "browserDownload.toast.extractionFailedDescription",
      };
    case "verification_failed":
      return {
        titleKey: "browserDownload.toast.verificationFailed",
        titleParams,
        descriptionKey: "browserDownload.toast.verificationFailedDescription",
      };
    case "download_timeout":
      return {
        titleKey: "browserDownload.toast.downloadFailed",
        titleParams,
        descriptionKey: "browserDownload.toast.downloadTimeoutDescription",
      };
    // "download_failed" and any unknown/missing value are generic download
    // failures from the listener's perspective, so they share the generic
    // download-failed label. Keeping them in the default branch guarantees a
    // future backend error_type is never mislabeled as an extraction failure.
    default:
      return {
        titleKey: "browserDownload.toast.downloadFailed",
        titleParams,
        descriptionKey: "browserDownload.toast.downloadFailedDescription",
      };
  }
}
