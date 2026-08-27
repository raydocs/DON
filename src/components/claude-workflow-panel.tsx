"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuLoaderCircle,
  LuShield,
  LuSparkles,
  LuWrench,
  LuZap,
} from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RippleButton } from "@/components/ui/ripple";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type AutoClaudeProfilePlan,
  assessAllClaudeProfiles,
  buildIsolationWayfernConfig,
  CLAUDE_DEFAULT_START_URL,
  CLAUDE_ISOLATION_RULES,
  canFlagFix,
  type HealthSeverity,
  isClaudeProfile,
  mergeClaudeTags,
  needsFingerprintRegen,
  PROXY_REUSE_COOLDOWN_DAYS,
  type ProfileHealth,
  pickAvailableProxy,
  planAutoClaudeProfile,
} from "@/lib/claude-workflow";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import { resolveWayfernWebRtcMode } from "@/lib/wayfern-defaults";
import type {
  BrowserProfile,
  BrowserReleaseTypes,
  ConsistencyResult,
  ParsedProxyLine,
  ProxyParseResult,
  StoredProxy,
  WayfernConfig,
} from "@/types";

interface ClaudeWorkflowPanelProps {
  isOpen: boolean;
  onClose: () => void;
  profiles: BrowserProfile[];
  proxies: StoredProxy[];
  onCreateProfile: () => void;
  /** Optional: parent refresh after auto-create (events usually cover this). */
  onProfileCreated?: (profile: BrowserProfile) => void;
}

function proxyLabelFromInput(input: string): string | null {
  try {
    const fragment = new URL(input).hash.slice(1);
    const label = decodeURIComponent(fragment)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 80);
    return label || null;
  } catch {
    return null;
  }
}

function severityBadge(score: HealthSeverity) {
  if (score === "ok")
    return (
      <Badge className="bg-emerald-600/15 text-emerald-700 dark:text-emerald-300">
        OK
      </Badge>
    );
  if (score === "warn")
    return (
      <Badge className="bg-amber-500/15 text-amber-800 dark:text-amber-200">
        WARN
      </Badge>
    );
  return (
    <Badge className="bg-destructive/15 text-destructive-text">BLOCK</Badge>
  );
}

function HealthRow({
  health,
  profile,
  busy,
  onFixFlags,
  onRegenFingerprint,
}: {
  health: ProfileHealth;
  profile: BrowserProfile | undefined;
  busy: boolean;
  onFixFlags: () => void;
  onRegenFingerprint: () => void;
}) {
  const [open, setOpen] = useState(health.score !== "ok");
  const showFix = profile && canFlagFix(health);
  const showRegen = profile && needsFingerprintRegen(health);

  return (
    <div className="rounded-md border p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span className="font-medium">{health.profileName}</span>
        {severityBadge(health.score)}
      </button>
      {open && health.issues.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {health.issues.map((issue) => (
            <li key={issue.code} className="flex gap-2">
              {issue.severity === "block" ? (
                <LuCircleAlert className="mt-0.5 size-4 shrink-0 text-destructive-text" />
              ) : issue.severity === "warn" ? (
                <LuCircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              ) : (
                <LuCircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              )}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
      {open && health.issues.length === 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          Isolation checks passed for this profile.
        </p>
      )}
      {open && (showFix || showRegen) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {showFix && (
            <RippleButton
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onFixFlags();
              }}
            >
              {busy ? (
                <LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
              ) : (
                <LuWrench className="mr-1 size-3.5" />
              )}
              Fix flags
            </RippleButton>
          )}
          {showRegen && (
            <RippleButton
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onRegenFingerprint();
              }}
            >
              {busy ? (
                <LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
              ) : (
                <LuWrench className="mr-1 size-3.5" />
              )}
              Regen fingerprint (DPR)
            </RippleButton>
          )}
        </div>
      )}
      {open && health.issues.some((i) => i.code === "SHARED_PROXY") && (
        <p className="mt-2 text-xs text-destructive-text">
          Shared proxy cannot auto-fix — assign a unique 家宽 IP to this profile
          first.
        </p>
      )}
    </div>
  );
}

interface QuickReport {
  profile: BrowserProfile;
  result: ConsistencyResult | null;
  probeError: string | null;
}

function parseFingerprint(
  profile: BrowserProfile,
): Record<string, unknown> | null {
  const raw = profile.wayfern_config?.fingerprint;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function QuickReportCard({
  report,
  busy,
  onMatch,
  onRetry,
}: {
  report: QuickReport;
  busy: boolean;
  onMatch: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const fp = parseFingerprint(report.profile);
  const result = report.result;
  const ua = typeof fp?.userAgent === "string" ? fp.userAgent : null;
  const dpr =
    typeof fp?.devicePixelRatio === "number" ? fp.devicePixelRatio : null;
  const screenW = typeof fp?.screenWidth === "number" ? fp.screenWidth : null;
  const screenH = typeof fp?.screenHeight === "number" ? fp.screenHeight : null;
  const webRtcMode = resolveWayfernWebRtcMode(report.profile.wayfern_config);
  const webRtcSafe = webRtcMode === "proxy" || webRtcMode === "off";
  const tzMismatch = result?.mismatches.includes("timezone") ?? false;
  const langMismatch = result?.mismatches.includes("language") ?? false;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">
          {t("claudeWorkflow.reportTitle")}
        </h4>
        {result?.checked &&
          (result.consistent ? (
            <Badge className="bg-success/15 text-success">OK</Badge>
          ) : (
            <Badge className="bg-destructive/15 text-destructive-text">
              MISMATCH
            </Badge>
          ))}
      </div>

      {!result && !report.probeError && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LuLoaderCircle className="size-3.5 animate-spin" />
          {t("claudeWorkflow.reportChecking")}
        </p>
      )}

      {report.probeError && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-destructive-text">
            {t("claudeWorkflow.reportProbeFailed", {
              message: report.probeError,
            })}
          </p>
          <RippleButton
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onRetry}
          >
            {t("common.buttons.retry")}
          </RippleButton>
        </div>
      )}

      {result && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">
            {t("claudeWorkflow.reportExitIp")}
          </dt>
          <dd className="font-mono">{result.exit_ip ?? "—"}</dd>
          <dt className="text-muted-foreground">
            {t("claudeWorkflow.reportCountry")}
          </dt>
          <dd>{result.exit_country_code ?? "—"}</dd>
          <dt className="text-muted-foreground">
            {t("claudeWorkflow.reportExitTimezone")}
          </dt>
          <dd>{result.exit_timezone ?? "—"}</dd>
          <dt className="text-muted-foreground">
            {t("claudeWorkflow.reportFpTimezone")}
          </dt>
          <dd className={tzMismatch ? "text-destructive-text" : undefined}>
            {result.fingerprint_timezone ?? "—"}
          </dd>
          <dt className="text-muted-foreground">
            {t("claudeWorkflow.reportFpLanguage")}
          </dt>
          <dd className={langMismatch ? "text-destructive-text" : undefined}>
            {result.fingerprint_language ?? "—"}
          </dd>
          <dt className="text-muted-foreground">WebRTC</dt>
          <dd>
            {webRtcSafe
              ? t("claudeWorkflow.reportWebrtcBlocked")
              : t("claudeWorkflow.reportWebrtcOpen")}
          </dd>
          {ua && (
            <>
              <dt className="text-muted-foreground">UA</dt>
              <dd className="break-all font-mono">{ua}</dd>
            </>
          )}
          {dpr != null && (
            <>
              <dt className="text-muted-foreground">DPR</dt>
              <dd>{dpr}</dd>
            </>
          )}
          {screenW != null && screenH != null && (
            <>
              <dt className="text-muted-foreground">
                {t("claudeWorkflow.reportScreen")}
              </dt>
              <dd>
                {screenW}×{screenH}
              </dd>
            </>
          )}
        </dl>
      )}

      {result?.checked && result.consistent && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <LuCircleCheck className="size-3.5" />
          {t("claudeWorkflow.reportConsistent")}
        </p>
      )}

      {result?.checked && !result.consistent && (
        <div className="space-y-1.5">
          {tzMismatch && (
            <p className="text-xs text-destructive-text">
              {t("claudeWorkflow.reportTzMismatch", {
                exit: result.exit_timezone ?? "?",
                fp: result.fingerprint_timezone ?? "?",
              })}
            </p>
          )}
          {langMismatch && (
            <p className="text-xs text-destructive-text">
              {t("claudeWorkflow.reportLangMismatch", {
                country: result.exit_country_code ?? "?",
                lang: result.fingerprint_language ?? "?",
              })}
            </p>
          )}
          {result.exit_ip && (
            <RippleButton
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onMatch}
            >
              {busy ? (
                <LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
              ) : (
                <LuWrench className="mr-1 size-3.5" />
              )}
              {t("claudeWorkflow.reportMatchCta")}
            </RippleButton>
          )}
        </div>
      )}

      {result && !result.checked && (
        <p className="text-xs text-muted-foreground">
          {t("claudeWorkflow.reportNotChecked")}
        </p>
      )}
    </div>
  );
}

export function ClaudeWorkflowPanel({
  isOpen,
  onClose,
  profiles,
  proxies,
  onCreateProfile,
  onProfileCreated,
}: ClaudeWorkflowPanelProps) {
  const { t } = useTranslation();
  const hostDpr =
    typeof window !== "undefined" ? window.devicePixelRatio : undefined;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [quickProxyInput, setQuickProxyInput] = useState("");
  const [quickCreating, setQuickCreating] = useState(false);
  const [quickReport, setQuickReport] = useState<QuickReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const freeProxy = useMemo(
    () => pickAvailableProxy(proxies, profiles),
    [proxies, profiles],
  );

  const autoPlanPreview = useMemo(() => {
    const plan = planAutoClaudeProfile({ proxies, profiles });
    return "error" in plan ? null : plan;
  }, [proxies, profiles]);

  const [showClaudeOnly, setShowClaudeOnly] = useState(true);

  const health = useMemo(
    () => assessAllClaudeProfiles(profiles, proxies, hostDpr),
    [profiles, proxies, hostDpr],
  );

  const profileById = useMemo(() => {
    const m = new Map<string, BrowserProfile>();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  const hasClaudeProfiles = useMemo(
    () => profiles.some((p) => isClaudeProfile(p)),
    [profiles],
  );

  const filteredHealth = useMemo(() => {
    if (!showClaudeOnly || !hasClaudeProfiles) return health;
    return health.filter((h) => {
      const p = profileById.get(h.profileId);
      return p ? isClaudeProfile(p) : false;
    });
  }, [health, showClaudeOnly, hasClaudeProfiles, profileById]);

  const counts = useMemo(() => {
    return {
      total: filteredHealth.length,
      block: filteredHealth.filter((h) => h.score === "block").length,
      warn: filteredHealth.filter((h) => h.score === "warn").length,
      ok: filteredHealth.filter((h) => h.score === "ok").length,
    };
  }, [filteredHealth]);

  const applyFlagFix = useCallback(async (profile: BrowserProfile) => {
    const nextConfig = buildIsolationWayfernConfig(profile.wayfern_config);
    await invoke("update_wayfern_config", {
      profileId: profile.id,
      config: nextConfig,
    });
    const tags = mergeClaudeTags(profile.tags);
    await invoke("update_profile_tags", {
      profileId: profile.id,
      tags,
    });
  }, []);

  const applyRegen = useCallback(async (profile: BrowserProfile) => {
    const base = buildIsolationWayfernConfig(profile.wayfern_config);
    const configJson = JSON.stringify(base);
    const fingerprint = await invoke<string>("generate_sample_fingerprint", {
      browser: profile.browser || "wayfern",
      version: profile.version,
      configJson,
    });
    const next: WayfernConfig = {
      ...base,
      fingerprint,
      randomize_fingerprint_on_launch: false,
    };
    await invoke("update_wayfern_config", {
      profileId: profile.id,
      config: next,
    });
    await invoke("update_profile_tags", {
      profileId: profile.id,
      tags: mergeClaudeTags(profile.tags),
    });
  }, []);

  const handleFixFlags = useCallback(
    async (profileId: string) => {
      const profile = profileById.get(profileId);
      if (!profile) return;
      setBusyId(profileId);
      try {
        await applyFlagFix(profile);
        showSuccessToast(
          t("claudeWorkflow.fixFlagsOk", {
            defaultValue: `Fixed isolation flags on ${profile.name}`,
          }),
        );
      } catch (err) {
        console.error(err);
        showErrorToast(
          t("claudeWorkflow.fixFailed", {
            defaultValue: `Fix failed: ${String(err)}`,
          }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [applyFlagFix, profileById, t],
  );

  const handleRegen = useCallback(
    async (profileId: string) => {
      const profile = profileById.get(profileId);
      if (!profile) return;
      setBusyId(profileId);
      try {
        await applyRegen(profile);
        showSuccessToast(
          t("claudeWorkflow.regenOk", {
            defaultValue: `Regenerated fingerprint for ${profile.name}`,
          }),
        );
      } catch (err) {
        console.error(err);
        showErrorToast(
          t("claudeWorkflow.fixFailed", {
            defaultValue: `Regen failed: ${String(err)}`,
          }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [applyRegen, profileById, t],
  );

  const handleBulkFixFlags = useCallback(async () => {
    const targets = health
      .filter((h) => canFlagFix(h))
      .map((h) => profileById.get(h.profileId))
      .filter((p): p is BrowserProfile => Boolean(p));
    if (targets.length === 0) {
      showSuccessToast("No flag-fixable profiles");
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const p of targets) {
      try {
        await applyFlagFix(p);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBulkBusy(false);
    showSuccessToast(`Fixed flags: ${ok} ok, ${fail} failed`);
  }, [applyFlagFix, health, profileById]);

  const createProfileFromPlan = useCallback(
    async (plan: AutoClaudeProfilePlan): Promise<BrowserProfile> => {
      let version: string | null = null;
      const releaseType = "stable";
      try {
        const releaseTypes = await invoke<BrowserReleaseTypes>(
          "get_browser_release_types",
          { browserStr: "wayfern" },
        );
        if (releaseTypes.stable) {
          version = releaseTypes.stable;
        }
      } catch {
        /* fall through to downloaded list */
      }
      if (!version) {
        const downloaded = await invoke<string[]>(
          "get_downloaded_browser_versions",
          { browserStr: "wayfern" },
        );
        version = downloaded[0] ?? null;
      }
      if (!version) {
        throw new Error(
          "No Wayfern browser version available — download Wayfern first",
        );
      }

      const profile = await invoke<BrowserProfile>(
        "create_browser_profile_new",
        {
          name: plan.name,
          browserStr: "wayfern",
          version,
          releaseType,
          proxyId: plan.proxyId,
          vpnId: null,
          wayfernConfig: plan.wayfernConfig,
          groupId: null,
          ephemeral: false,
          dnsBlocklist: null,
          launchHook: null,
        },
      );

      try {
        await invoke("update_profile_tags", {
          profileId: profile.id,
          tags: plan.tags,
        });
      } catch (err) {
        console.error("Failed to set Claude tags:", err);
      }
      try {
        await invoke("update_profile_note", {
          profileId: profile.id,
          note: plan.note,
        });
      } catch (err) {
        console.error("Failed to set Claude note:", err);
      }
      return profile;
    },
    [],
  );

  const handleAutoCreate = useCallback(async () => {
    const plan = planAutoClaudeProfile({ proxies, profiles });
    if ("error" in plan) {
      showErrorToast(plan.error);
      return;
    }
    setAutoCreating(true);
    try {
      const profile = await createProfileFromPlan(plan);
      onProfileCreated?.(profile);
      showSuccessToast(
        t("claudeWorkflow.autoCreateOk", {
          defaultValue: `Created ${plan.name} → ${plan.proxyName} · ${plan.cardLabel} · opens ${CLAUDE_DEFAULT_START_URL}`,
        }),
      );
    } catch (err) {
      console.error(err);
      showErrorToast(
        t("claudeWorkflow.autoCreateFailed", {
          defaultValue: `Auto-create failed: ${String(err)}`,
        }),
      );
    } finally {
      setAutoCreating(false);
    }
  }, [createProfileFromPlan, onProfileCreated, profiles, proxies, t]);

  const runConsistencyCheck = useCallback(async (profile: BrowserProfile) => {
    try {
      const result = await invoke<ConsistencyResult>(
        "check_profile_consistency_now",
        { profileId: profile.id },
      );
      setQuickReport({ profile, result, probeError: null });
    } catch (err) {
      setQuickReport({ profile, result: null, probeError: String(err) });
    }
  }, []);

  const handleQuickCreate = useCallback(async () => {
    const text = quickProxyInput.trim();
    if (!text) {
      showErrorToast(t("claudeWorkflow.quickInvalid"));
      return;
    }
    setQuickCreating(true);
    setQuickReport(null);
    try {
      const results = await invoke<ProxyParseResult[]>("parse_txt_proxies", {
        content: text,
      });
      const first = results[0];
      let parsed: ParsedProxyLine | null = null;
      if (first?.status === "parsed") {
        parsed = first;
      } else if (first?.status === "ambiguous") {
        // Prefer host:port:user:pass over user:pass:host:port.
        const parts = first.line.split(":");
        if (parts.length === 4) {
          parsed = {
            proxy_type: "socks5",
            host: parts[0],
            port: Number.parseInt(parts[1], 10),
            username: parts[2],
            password: parts[3],
            original_line: first.line,
          };
        }
      }
      if (!parsed) {
        showErrorToast(t("claudeWorkflow.quickInvalid"));
        return;
      }

      // Quick-create is deliberately SOCKS5-only. SOCKS5 is the browser's
      // remote-DNS path; accepting HTTP here would make the safety guarantee
      // of this one-click flow false.
      const proxyType = text.includes("://") ? parsed.proxy_type : "socks5";
      if (proxyType.toLowerCase() !== "socks5") {
        showErrorToast(t("claudeWorkflow.quickSocksOnly"));
        return;
      }

      const existingNames = new Set(proxies.map((p) => p.name.toLowerCase()));
      let proxyName = proxyLabelFromInput(text) ?? parsed.host;
      let suffix = 2;
      while (existingNames.has(proxyName.toLowerCase())) {
        proxyName = `${parsed.host}-${suffix}`;
        suffix += 1;
      }
      const createdProxy = await invoke<StoredProxy>("create_stored_proxy", {
        name: proxyName,
        proxySettings: {
          proxy_type: proxyType,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username || undefined,
          password: parsed.password || undefined,
          vless_uri: parsed.vless_uri || undefined,
        },
      });

      // Fingerprint geo stamping needs the MaxMind DB; the auto-create path
      // does not ensure it, so do it here.
      const geoReady = await invoke<boolean>("is_geoip_database_available");
      if (!geoReady) {
        await invoke("download_geoip_database");
      }

      const plan = planAutoClaudeProfile({
        proxies: [...proxies, createdProxy],
        profiles,
        proxyId: createdProxy.id,
      });
      if ("error" in plan) {
        showErrorToast(plan.error);
        return;
      }
      const profile = await createProfileFromPlan(plan);
      onProfileCreated?.(profile);
      setQuickProxyInput("");
      showSuccessToast(t("claudeWorkflow.quickOk", { name: plan.name }));

      setQuickReport({ profile, result: null, probeError: null });
      await runConsistencyCheck(profile);
    } catch (err) {
      console.error(err);
      showErrorToast(t("claudeWorkflow.quickFailed", { message: String(err) }));
    } finally {
      setQuickCreating(false);
    }
  }, [
    createProfileFromPlan,
    onProfileCreated,
    profiles,
    proxies,
    quickProxyInput,
    runConsistencyCheck,
    t,
  ]);

  const handleReportRetry = useCallback(async () => {
    if (!quickReport) return;
    setReportBusy(true);
    try {
      await runConsistencyCheck(quickReport.profile);
    } finally {
      setReportBusy(false);
    }
  }, [quickReport, runConsistencyCheck]);

  const handleReportMatch = useCallback(async () => {
    const exitIp = quickReport?.result?.exit_ip;
    if (!quickReport || !exitIp) return;
    setReportBusy(true);
    try {
      await invoke("match_profile_fingerprint_to_exit", {
        profileId: quickReport.profile.id,
        exitIp,
      });
      await runConsistencyCheck(quickReport.profile);
      showSuccessToast(t("claudeWorkflow.reportMatchedOk"));
    } catch (err) {
      showErrorToast(t("claudeWorkflow.quickFailed", { message: String(err) }));
    } finally {
      setReportBusy(false);
    }
  }, [quickReport, runConsistencyCheck, t]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-[min(40rem,calc(100%-2rem))] flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LuShield className="size-5" />
            {t("claudeWorkflow.title", {
              defaultValue: "Claude isolation workflow",
            })}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 py-2 pr-3">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                {t("claudeWorkflow.rulesTitle", {
                  defaultValue: "Hard rules (1 · 1 · 1 · 1)",
                })}
              </h3>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {CLAUDE_ISOLATION_RULES.map((rule) => (
                  <li key={rule} className="flex gap-2">
                    <LuCircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                {t("claudeWorkflow.stepsTitle", {
                  defaultValue: "Create a new Claude profile",
                })}
              </h3>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>
                  Auto-create picks a free 家宽 node (no active{" "}
                  {PROXY_REUSE_COOLDOWN_DAYS}-day lease).
                </li>
                <li>
                  Same node can be reused only after {PROXY_REUSE_COOLDOWN_DAYS}{" "}
                  days.
                </li>
                <li>
                  Card label auto-assigned (card-A/B…) — never paste full PAN.
                </li>
                <li>Launch opens {CLAUDE_DEFAULT_START_URL} by default.</li>
                <li>
                  DON forces: geoip from proxy, WebRTC blocked, fixed
                  fingerprint, host DPR.
                </li>
              </ol>
              {autoPlanPreview && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Next auto:{" "}
                  <span className="font-medium text-foreground">
                    {autoPlanPreview.name}
                  </span>
                  {" · "}
                  {autoPlanPreview.proxyName}
                  {" · "}
                  {autoPlanPreview.cardLabel}
                  {" · "}
                  {autoPlanPreview.startUrl}
                </p>
              )}
              {!freeProxy && (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  No free node right now — all proxies are inside the{" "}
                  {PROXY_REUSE_COOLDOWN_DAYS}-day lease window.
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <RippleButton
                  disabled={autoCreating || !freeProxy}
                  onClick={() => {
                    void handleAutoCreate();
                  }}
                >
                  {autoCreating ? (
                    <LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <LuSparkles className="mr-1 size-3.5" />
                  )}
                  {t("claudeWorkflow.autoCreateCta", {
                    defaultValue: "Auto-create Claude profile",
                  })}
                </RippleButton>
                <RippleButton
                  variant="outline"
                  onClick={() => {
                    onClose();
                    onCreateProfile();
                  }}
                >
                  {t("claudeWorkflow.createCta", {
                    defaultValue: "Manual create…",
                  })}
                </RippleButton>
                <RippleButton
                  variant="outline"
                  disabled={bulkBusy}
                  onClick={() => {
                    void handleBulkFixFlags();
                  }}
                >
                  {bulkBusy ? (
                    <LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <LuWrench className="mr-1 size-3.5" />
                  )}
                  Fix all flags
                </RippleButton>
              </div>

              <div className="mt-3 space-y-2 rounded-md border p-3">
                <Label
                  htmlFor="quick-proxy-input"
                  className="text-xs font-medium"
                >
                  {t("claudeWorkflow.quickTitle")}
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="quick-proxy-input"
                    value={quickProxyInput}
                    onChange={(e) => {
                      setQuickProxyInput(e.target.value);
                    }}
                    placeholder={t("claudeWorkflow.quickPlaceholder")}
                    disabled={quickCreating}
                    className="min-w-0 flex-1 font-mono text-xs"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Badge variant="outline">SOCKS5</Badge>
                  <RippleButton
                    disabled={quickCreating || !quickProxyInput.trim()}
                    onClick={() => {
                      void handleQuickCreate();
                    }}
                  >
                    {quickCreating ? (
                      <LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <LuZap className="mr-1 size-3.5" />
                    )}
                    {t("claudeWorkflow.quickCta")}
                  </RippleButton>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("claudeWorkflow.quickSocksOnly")}
                </p>
                {quickReport && (
                  <QuickReportCard
                    report={quickReport}
                    busy={reportBusy}
                    onMatch={() => {
                      void handleReportMatch();
                    }}
                    onRetry={() => {
                      void handleReportRetry();
                    }}
                  />
                )}
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">
                    {t("claudeWorkflow.healthTitle", {
                      defaultValue: "Profile health scan",
                    })}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {counts.total} profiles · {counts.ok} ok · {counts.warn}{" "}
                    warn · {counts.block} block
                  </span>
                </div>
                {hasClaudeProfiles && (
                  <div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
                    <button
                      type="button"
                      className={cn(
                        "rounded px-2 py-0.5 font-medium transition-colors",
                        showClaudeOnly
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setShowClaudeOnly(true)}
                    >
                      Claude only
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "rounded px-2 py-0.5 font-medium transition-colors",
                        !showClaudeOnly
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setShowClaudeOnly(false)}
                    >
                      All profiles
                    </button>
                  </div>
                )}
              </div>
              {filteredHealth.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No profiles match the filter. Create one with a dedicated 家宽
                  proxy.
                </p>
              ) : (
                <div className="space-y-2">
                  {filteredHealth.map((h) => (
                    <HealthRow
                      key={h.profileId}
                      health={h}
                      profile={profileById.get(h.profileId)}
                      busy={busyId === h.profileId || bulkBusy}
                      onFixFlags={() => {
                        void handleFixFlags(h.profileId);
                      }}
                      onRegenFingerprint={() => {
                        void handleRegen(h.profileId);
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

            <p
              className={cn(
                "rounded-md border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground",
              )}
            >
              Isolation reduces network/device linking. Claude may still ban for
              payment reuse, content policy, or bulk automation. One card per
              profile is operational discipline — DON only stores your labels.
              Shared proxies and DPR mismatches block launch until fixed.
            </p>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
