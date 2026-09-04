import type { ProfileImportBatchResult } from "@/types";

/**
 * Fold a retry's results back into the batch it came from.
 *
 * A retry only resubmits the items that failed, so the previous batch is still
 * authoritative for every other row. Replacing it wholesale would make the
 * successful imports disappear from the summary.
 */
export function mergeImportResults(
  previous: ProfileImportBatchResult,
  retry: ProfileImportBatchResult,
): ProfileImportBatchResult {
  const byPath = new Map(retry.results.map((item) => [item.source_path, item]));
  const results = previous.results.map(
    (item) => byPath.get(item.source_path) ?? item,
  );
  const count = (status: string) =>
    results.filter((item) => item.status === status).length;
  return {
    imported_count: count("imported"),
    skipped_count: count("skipped"),
    failed_count: count("failed"),
    results,
  };
}
