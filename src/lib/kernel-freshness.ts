export interface KernelFreshnessInput {
  installedVersion?: string | null;
  wayfernVersion?: string | null;
  chromeStableVersion?: string | null;
  fingerprint?: string | null;
}

export interface KernelFreshness {
  observedVersion: string | null;
  wayfernVersion: string | null;
  chromeStableVersion: string | null;
  behindChromeMajors: number | null;
  behindWayfernMajors: number | null;
}

export function parseVersionMajor(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value)
    .trim()
    .match(/^(?:v)?(\d+)/i);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) ? major : null;
}

/** Parse the Chromium base echoed by Wayfern.getFingerprint. */
export function parseWayfernChromiumBase(
  fingerprint?: string | null,
): string | null {
  if (!fingerprint) return null;
  try {
    const parsed: unknown = JSON.parse(fingerprint);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const value =
      record.fingerprint && typeof record.fingerprint === "object"
        ? (record.fingerprint as Record<string, unknown>).brandVersion
        : record.brandVersion;
    if (typeof value !== "string" && typeof value !== "number") return null;
    return String(value).trim() || null;
  } catch {
    return null;
  }
}

function majorGap(baseline: string | null, observed: string | null) {
  const baselineMajor = parseVersionMajor(baseline);
  const observedMajor = parseVersionMajor(observed);
  if (baselineMajor == null || observedMajor == null) return null;
  return Math.max(0, baselineMajor - observedMajor);
}

export function assessKernelFreshness(
  input: KernelFreshnessInput,
): KernelFreshness {
  const fingerprintBase = parseWayfernChromiumBase(input.fingerprint);
  const observedVersion =
    input.installedVersion?.trim() || fingerprintBase || null;
  const wayfernVersion = input.wayfernVersion?.trim() || null;
  const chromeStableVersion = input.chromeStableVersion?.trim() || null;

  return {
    observedVersion,
    wayfernVersion,
    chromeStableVersion,
    behindChromeMajors: majorGap(chromeStableVersion, observedVersion),
    behindWayfernMajors: majorGap(wayfernVersion, observedVersion),
  };
}
