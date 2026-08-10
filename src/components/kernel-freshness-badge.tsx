"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { assessKernelFreshness } from "@/lib/kernel-freshness";
import { showErrorToast } from "@/lib/toast-utils";

interface KernelFreshnessBadgeProps {
  installedVersion?: string | null;
  wayfernVersion?: string | null;
  chromeStableVersion?: string | null;
  fingerprint?: string | null;
}

const warnedKernelStates = new Set<string>();

export function KernelFreshnessBadge({
  installedVersion,
  wayfernVersion,
  chromeStableVersion,
  fingerprint,
}: KernelFreshnessBadgeProps) {
  const { t } = useTranslation();
  const freshness = assessKernelFreshness({
    installedVersion,
    wayfernVersion,
    chromeStableVersion,
    fingerprint,
  });
  const behind = freshness.behindChromeMajors;
  const warningKey =
    behind != null && behind > 2
      ? `${freshness.observedVersion ?? "unknown"}:${freshness.chromeStableVersion ?? "unknown"}`
      : null;

  useEffect(() => {
    if (!warningKey || warnedKernelStates.has(warningKey)) return;
    warnedKernelStates.add(warningKey);

    const storageKey = `don.kernel-freshness.warned.${warningKey}`;
    try {
      if (window.localStorage.getItem(storageKey)) return;
      window.localStorage.setItem(storageKey, "1");
    } catch {
      // An unavailable localStorage must not block the badge.
    }

    showErrorToast(t("kernelFreshness.toastTitle"), {
      id: `kernel-freshness-${warningKey}`,
      description: t("kernelFreshness.toastDescription", { count: behind }),
      duration: 12000,
    });
  }, [behind, t, warningKey]);

  const detail = t("kernelFreshness.details", {
    installed: freshness.observedVersion ?? t("fingerprintAudit.notAvailable"),
    wayfern: freshness.wayfernVersion ?? t("fingerprintAudit.notAvailable"),
    chrome: freshness.chromeStableVersion ?? t("fingerprintAudit.notAvailable"),
  });

  if (behind == null) {
    return (
      <Badge variant="outline" title={detail}>
        {t("kernelFreshness.unknown")}
      </Badge>
    );
  }

  if (behind === 0) {
    return (
      <Badge
        variant="outline"
        className="border-success/50 bg-success/10 text-success-text"
        title={detail}
      >
        {t("kernelFreshness.current")}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={
        behind > 2
          ? "border-destructive/50 bg-destructive/10 text-destructive-text"
          : "border-warning/50 bg-warning/10 text-warning-text"
      }
      title={detail}
    >
      {t("kernelFreshness.behind", { count: behind })}
    </Badge>
  );
}
