"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowRight,
  LuFingerprint,
  LuLoaderCircle,
  LuPlus,
  LuShield,
  LuWrench,
} from "react-icons/lu";
import { FingerprintAuditDialog } from "@/components/fingerprint-audit-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsPanel } from "@/components/ui/settings-panel";
import { translateBackendError } from "@/lib/backend-errors";
import {
  type AutoClaudeProfilePlan,
  assessAllClaudeProfiles,
  buildIsolationWayfernConfig,
  buildResidentialUsage,
  canFlagFix,
  isClaudeProfile,
  mergeClaudeTags,
  needsFingerprintRegen,
  planAutoClaudeProfile,
  type ResidentialObservation,
} from "@/lib/claude-workflow";
import { showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import { getCurrentOS } from "@/lib/wayfern-defaults";
import type {
  BrowserProfile,
  ConsistencyResult,
  ProxyParseResult,
  StoredProxy,
} from "@/types";

interface ClaudeWorkflowPanelProps {
  isOpen: boolean;
  onClose: () => void;
  profiles: BrowserProfile[];
  proxies: StoredProxy[];
  onCreateProfile: () => void;
  onProfileCreated?: (profile: BrowserProfile) => void;
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
  const [tab, setTab] = useState<"check" | "usage" | "create">("check");
  const [usageFilter, setUsageFilter] = useState<"all" | "label" | "ip">("all");
  const [observations, setObservations] = useState<ResidentialObservation[]>(
    [],
  );
  const [observationError, setObservationError] = useState<string | null>(null);
  const [observationLoading, setObservationLoading] = useState(true);
  const [nowSecs, setNowSecs] = useState(() => Date.now() / 1000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyInput, setProxyInput] = useState("");
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [auditProfile, setAuditProfile] = useState<BrowserProfile | null>(null);
  const [probe, setProbe] = useState<{
    profileId: string;
    result: ConsistencyResult;
  } | null>(null);
  const hostDpr =
    typeof window === "undefined" ? undefined : window.devicePixelRatio;
  const health = useMemo(
    () => assessAllClaudeProfiles(profiles, proxies, hostDpr),
    [profiles, proxies, hostDpr],
  );
  const visible = health.filter(
    (h) =>
      showAll ||
      profiles.some((p) => p.id === h.profileId && isClaudeProfile(p)),
  );
  const selected =
    visible.find((h) => h.profileId === selectedId) ?? visible[0];
  const profile = profiles.find((p) => p.id === selected?.profileId);
  const selectedProxy = proxies.find((p) => p.id === profile?.proxy_id);
  const plan = planAutoClaudeProfile({ profiles, proxies });
  const result = probe && probe.profileId === profile?.id ? probe.result : null;
  const usage = buildResidentialUsage(profiles, observations, nowSecs);
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const refresh = () => {
      void invoke<ResidentialObservation[]>("get_profile_exit_observations")
        .then((next) => {
          if (!active) return;
          setObservations(next);
          setNowSecs(Date.now() / 1000);
          setObservationError(null);
        })
        .catch((reason) => {
          if (active) {
            setObservations([]);
            setObservationError(translateBackendError(t, reason));
          }
        })
        .finally(() => active && setObservationLoading(false));
    };
    setObservationLoading(true);
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isOpen, t]);
  let fingerprint: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(profile?.wayfern_config?.fingerprint ?? "{}");
    fingerprint = parsed.fingerprint ?? parsed;
  } catch {
    /* The health check reports a missing/invalid stored fingerprint. */
  }

  async function action(id: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(translateBackendError(t, reason));
    } finally {
      setBusy(null);
    }
  }

  async function create(plan: AutoClaudeProfilePlan) {
    const downloaded = await invoke<string[]>(
      "get_downloaded_browser_versions",
      { browserStr: "wayfern" },
    );
    if (!downloaded[0]) throw new Error(t("isolation.downloadFirst"));
    const created = await invoke<BrowserProfile>("create_browser_profile_new", {
      name: plan.name,
      browserStr: "wayfern",
      version: downloaded[0],
      releaseType: "stable",
      proxyId: plan.proxyId,
      vpnId: null,
      wayfernConfig: plan.wayfernConfig,
      groupId: null,
      ephemeral: false,
      dnsBlocklist: null,
      launchHook: null,
      startUrls: [plan.startUrl],
    });
    onProfileCreated?.(created);
    setSelectedId(created.id);
    setTab("check");
    // Never hide a partially configured profile or delete data on a failure.
    try {
      await invoke("update_profile_tags", {
        profileId: created.id,
        tags: plan.tags,
      });
      await invoke("update_profile_note", {
        profileId: created.id,
        note: plan.note,
      });
    } catch {
      throw new Error(t("isolation.partialCreate", { name: created.name }));
    }
    showSuccessToast(t("claudeWorkflow.quickOk", { name: created.name }));
  }

  async function quickCreate() {
    const text = proxyInput.trim();
    const parsed = await invoke<ProxyParseResult[]>("parse_txt_proxies", {
      content: text,
    });
    if (
      parsed.length !== 1 ||
      parsed[0].status !== "parsed" ||
      parsed[0].proxy_type.toLowerCase() !== "socks5"
    ) {
      throw new Error(t("isolation.explicitSocks"));
    }
    const item = parsed[0];
    const createdProxy = await invoke<StoredProxy>("create_stored_proxy", {
      name: `Claude-${item.host}-${Date.now()}`,
      proxySettings: {
        proxy_type: "socks5",
        host: item.host,
        port: item.port,
        username: item.username,
        password: item.password,
      },
    });
    setProxyInput("");
    const next = planAutoClaudeProfile({
      profiles,
      proxies: [...proxies, createdProxy],
      proxyId: createdProxy.id,
    });
    if ("error" in next)
      throw new Error(
        t("isolation.proxyRetained", { name: createdProxy.name }),
      );
    try {
      await create(next);
    } catch (reason) {
      throw new Error(
        `${translateBackendError(t, reason)} ${t("isolation.proxyRetained", { name: createdProxy.name })}`,
      );
    }
  }

  async function repair(regenerate: boolean, target = profile) {
    if (!target) return;
    const fresh = (
      await invoke<BrowserProfile[]>("list_browser_profiles")
    ).find((p) => p.id === target.id);
    if (!fresh) throw new Error(t("isolation.profileMissing"));
    const config = buildIsolationWayfernConfig(fresh.wayfern_config);
    if (regenerate) {
      if ((!config.os || config.os === getCurrentOS()) && hostDpr) {
        config.expected_device_pixel_ratio = hostDpr;
      }
      config.fingerprint = await invoke<string>("generate_sample_fingerprint", {
        browser: fresh.browser,
        version: fresh.version,
        configJson: JSON.stringify(config),
      });
    }
    await invoke("update_wayfern_config", { profileId: fresh.id, config });
    await invoke("update_profile_tags", {
      profileId: fresh.id,
      tags: mergeClaudeTags(fresh.tags),
    });
    setProbe(null);
    setConfirmRegen(false);
    showSuccessToast(t("isolation.repaired"));
  }

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => !open && !busy && onClose()}
      >
        <DialogContent className="flex h-[min(850px,92vh)] max-w-[min(1080px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <LuShield className="size-5" />
              {t("claudeWorkflow.title")}
            </DialogTitle>
            <DialogDescription>{t("isolation.description")}</DialogDescription>
          </DialogHeader>
          <div
            className="flex items-center gap-2 border-b px-6 py-3"
            role="tablist"
            aria-label={t("claudeWorkflow.title")}
          >
            {(["check", "usage", "create"] as const).map((value) => (
              <Button
                key={value}
                role="tab"
                aria-selected={tab === value}
                variant={tab === value ? "secondary" : "ghost"}
                disabled={Boolean(busy)}
                onClick={() => {
                  setTab(value);
                  setError(null);
                }}
              >
                {t(`isolation.${value}`)}
              </Button>
            ))}
            <span className="ml-auto text-xs text-muted-foreground">
              {t("isolation.localOnly")}
            </span>
          </div>
          {error && (
            <div
              role="alert"
              className="mx-6 mt-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-text"
            >
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <Button variant="ghost" size="sm" onClick={() => setError(null)}>
                {t("common.buttons.close")}
              </Button>
            </div>
          )}
          {tab === "usage" ? (
            <div className="min-h-0 flex-1 space-y-5 overflow-auto p-6">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("residential.title")}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("residential.scope")}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  [
                    "residential.labelDuplicates",
                    usage.duplicateLabelProfiles.length,
                  ],
                  [
                    "residential.ipDuplicates",
                    usage.duplicateIpProfiles.length,
                  ],
                  ["residential.unknown", usage.unknownIp.count],
                  ["residential.expired", usage.expiredIp.count],
                ].map(([label, count]) => (
                  <SettingsPanel key={String(label)} className="border">
                    <p className="text-xs text-muted-foreground">
                      {t(String(label))}
                    </p>
                    <p className="mt-2 text-xl font-semibold">
                      {observationLoading ? "—" : count}
                    </p>
                  </SettingsPanel>
                ))}
              </div>
              <fieldset className="flex flex-wrap gap-2">
                <legend className="sr-only">{t("residential.filters")}</legend>
                {(["all", "label", "ip"] as const).map((filter) => (
                  <Button
                    key={filter}
                    variant={usageFilter === filter ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={usageFilter === filter}
                    onClick={() => setUsageFilter(filter)}
                  >
                    {t(`residential.filter.${filter}`)}
                  </Button>
                ))}
              </fieldset>
              {observationLoading && (
                <p role="status" className="text-sm">
                  {t("common.buttons.loading")}
                </p>
              )}
              {observationError && (
                <p role="alert" className="text-sm text-destructive-text">
                  {observationError}
                </p>
              )}
              {[
                {
                  title: "residential.labels",
                  groups:
                    usageFilter === "label"
                      ? usage.byLabel.filter((g) => g.count > 1)
                      : [
                          ...usage.byLabel,
                          {
                            ...usage.unknownLabel,
                            key: t("residential.unknownLabel"),
                          },
                        ],
                  hidden: usageFilter === "ip",
                },
                {
                  title: "residential.exits",
                  groups:
                    usageFilter === "ip"
                      ? usage.byIp.filter((g) => g.count > 1)
                      : [
                          ...usage.byIp,
                          { ...usage.expiredIp, key: t("residential.expired") },
                          usage.unknownIp,
                        ],
                  hidden: usageFilter === "label",
                },
              ]
                .filter((section) => !section.hidden)
                .map((section) => {
                  const groups = section.groups.filter(
                    (group) => group.count > 0,
                  );
                  return (
                    <section key={section.title} className="space-y-3">
                      <h3 className="text-sm font-semibold">
                        {t(section.title)}
                      </h3>
                      {groups.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          {t("residential.empty")}
                        </p>
                      )}
                      {groups.map((group) => (
                        <SettingsPanel
                          key={group.key ?? "unknown"}
                          className="space-y-3 border"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="break-all text-sm font-medium">
                              {group.key ?? t("residential.unknown")}
                            </span>
                            <Badge variant="outline">
                              {t("residential.count", { count: group.count })}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t("residential.lastObserved", {
                              time: group.lastObservedAt
                                ? new Date(
                                    group.lastObservedAt * 1000,
                                  ).toLocaleString()
                                : t("residential.unknown"),
                            })}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {group.profiles.map((member) => (
                              <Button
                                key={member.id}
                                variant="outline"
                                size="sm"
                                className="max-w-full"
                                onClick={() => {
                                  setSelectedId(member.id);
                                  setShowAll(true);
                                  setTab("check");
                                }}
                              >
                                <span className="truncate">{member.name}</span>
                                <LuArrowRight className="size-3 shrink-0" />
                              </Button>
                            ))}
                          </div>
                        </SettingsPanel>
                      ))}
                    </section>
                  );
                })}
            </div>
          ) : tab === "check" ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[260px_minmax(0,1fr)] md:overflow-hidden">
              <aside className="flex min-h-0 flex-col border-b bg-muted/20 md:border-r md:border-b-0">
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <span className="text-xs font-medium">
                    {t("isolation.profiles", { count: visible.length })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={showAll}
                    onClick={() => setShowAll(!showAll)}
                  >
                    {t(showAll ? "isolation.claudeOnly" : "isolation.showAll")}
                  </Button>
                </div>
                <div className="max-h-52 overflow-auto p-2 md:max-h-none md:flex-1">
                  {visible.map((h) => (
                    <button
                      type="button"
                      key={h.profileId}
                      disabled={Boolean(busy)}
                      aria-pressed={selected?.profileId === h.profileId}
                      onClick={() => {
                        setSelectedId(h.profileId);
                        setConfirmRegen(false);
                        setError(null);
                      }}
                      className={cn(
                        "mb-1 flex w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary",
                        selected?.profileId === h.profileId &&
                          "border-border bg-background shadow-sm",
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          h.score === "ok"
                            ? "bg-muted-foreground"
                            : h.score === "block"
                              ? "bg-destructive"
                              : "bg-warning",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {h.profileName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(
                            h.issues.length
                              ? "isolation.issueCount"
                              : "isolation.configClear",
                            { count: h.issues.length },
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                  {visible.length === 0 && (
                    <p className="p-3 text-sm text-muted-foreground">
                      {t("isolation.empty")}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  className="m-3"
                  onClick={() => setTab("create")}
                >
                  <LuPlus className="size-4" />
                  {t("isolation.create")}
                </Button>
                <Button
                  variant="ghost"
                  className="mx-3 mb-3"
                  disabled={
                    Boolean(busy) ||
                    !health.some(
                      (h) =>
                        canFlagFix(h) &&
                        profiles.some(
                          (p) =>
                            p.id === h.profileId &&
                            isClaudeProfile(p) &&
                            !p.process_id,
                        ),
                    )
                  }
                  onClick={() =>
                    void action("bulk", async () => {
                      const targets = health
                        .filter(canFlagFix)
                        .flatMap((h) =>
                          profiles.filter(
                            (p) =>
                              p.id === h.profileId &&
                              isClaudeProfile(p) &&
                              !p.process_id,
                          ),
                        );
                      for (const target of targets) await repair(false, target);
                    })
                  }
                >
                  {t("isolation.fixAllFlags")}
                </Button>
              </aside>
              <div className="min-w-0 space-y-5 overflow-auto p-5 md:p-6">
                {profile && selected ? (
                  <>
                    <div>
                      <h2 className="truncate text-lg font-semibold">
                        {profile.name}
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("isolation.configNotProof")}
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <SettingsPanel className="border">
                        <p className="text-xs text-muted-foreground">
                          {t("isolation.configCheck")}
                        </p>
                        <p className="mt-2 text-xl font-semibold">
                          {t(
                            selected.issues.length
                              ? "isolation.issueCount"
                              : "isolation.configClear",
                            { count: selected.issues.length },
                          )}
                        </p>
                      </SettingsPanel>
                      <SettingsPanel className="border">
                        <p className="text-xs text-muted-foreground">
                          {t("isolation.runtime")}
                        </p>
                        <p className="mt-2 text-sm font-medium">
                          {t("isolation.notVerified")}
                        </p>
                        <Button
                          className="mt-2"
                          variant="outline"
                          size="sm"
                          disabled={Boolean(busy)}
                          onClick={() => setAuditProfile(profile)}
                        >
                          <LuFingerprint className="size-4" />
                          {t("fingerprintAudit.run")}
                        </Button>
                      </SettingsPanel>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4 text-xs sm:grid-cols-3">
                      {[
                        [
                          t("isolation.route"),
                          selectedProxy?.name ??
                            t(
                              profile.proxy_id
                                ? "isolation.missingRoute"
                                : "isolation.noRoute",
                            ),
                        ],
                        [
                          t("isolation.savedDpr"),
                          String(fingerprint.devicePixelRatio ?? "—"),
                        ],
                        [
                          t("isolation.expectedDpr"),
                          String(
                            profile.wayfern_config
                              ?.expected_device_pixel_ratio ??
                              hostDpr ??
                              "—",
                          ),
                        ],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="mt-1 break-words font-medium">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <section className="space-y-2">
                      <h3 className="text-sm font-semibold">
                        {t("isolation.repairTitle")}
                      </h3>
                      {selected.issues.map((issue) => (
                        <div key={issue.code} className="rounded-lg border p-3">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={
                                issue.severity === "block"
                                  ? "text-destructive-text"
                                  : "text-warning-text"
                              }
                            >
                              {t(
                                issue.severity === "block"
                                  ? "isolation.attention"
                                  : "isolation.review",
                              )}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {issue.code}
                            </span>
                          </div>
                          <p className="mt-2 text-sm">
                            {t(`isolation.issues.${issue.code}`)}
                          </p>
                        </div>
                      ))}
                      {!selected.issues.length && (
                        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                          {t("isolation.noIssues")}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            Boolean(busy) ||
                            Boolean(profile.process_id) ||
                            !canFlagFix(selected)
                          }
                          onClick={() =>
                            void action("repair", () => repair(false))
                          }
                        >
                          {busy === "repair" ? (
                            <LuLoaderCircle className="size-4 animate-spin" />
                          ) : (
                            <LuWrench className="size-4" />
                          )}
                          {t("isolation.fixFlags")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            Boolean(busy) ||
                            Boolean(profile.process_id) ||
                            !needsFingerprintRegen(selected)
                          }
                          onClick={() => setConfirmRegen(!confirmRegen)}
                        >
                          {t("isolation.regenerate")}
                        </Button>
                      </div>
                      {profile.process_id && (
                        <p className="text-xs text-muted-foreground">
                          {t("isolation.stopFirst")}
                        </p>
                      )}
                      {confirmRegen && (
                        <SettingsPanel className="space-y-3 border border-warning/40">
                          <p className="text-sm">
                            {t("isolation.regenWarning")}
                          </p>
                          <Button
                            disabled={Boolean(busy)}
                            size="sm"
                            onClick={() =>
                              void action("regenerate", () => repair(true))
                            }
                          >
                            {t("isolation.confirmRegen")}
                          </Button>
                        </SettingsPanel>
                      )}
                    </section>
                    <section className="space-y-3 rounded-xl border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">
                          {t("isolation.exitCheck")}
                        </h3>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={Boolean(busy) || !selectedProxy}
                          onClick={() =>
                            void action("probe", async () => {
                              setProbe(null);
                              const next = await invoke<ConsistencyResult>(
                                "check_profile_consistency_now",
                                { profileId: profile.id },
                              );
                              setProbe({ profileId: profile.id, result: next });
                            })
                          }
                        >
                          {busy === "probe" && (
                            <LuLoaderCircle className="size-4 animate-spin" />
                          )}
                          {t("isolation.checkExit")}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("isolation.exitScope")}
                      </p>
                      {result ? (
                        <>
                          <p role="status" className="text-sm">
                            {t(
                              !result.checked
                                ? "claudeWorkflow.reportNotChecked"
                                : result.consistent
                                  ? "claudeWorkflow.reportConsistent"
                                  : "isolation.exitMismatch",
                            )}
                          </p>
                          <p className="break-words font-mono text-xs">
                            {result.exit_ip ?? "—"} ·{" "}
                            {result.exit_timezone ?? "—"} /{" "}
                            {result.fingerprint_timezone ?? "—"}
                          </p>
                          {result.checked &&
                            !result.consistent &&
                            result.exit_ip && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  Boolean(busy) || Boolean(profile.process_id)
                                }
                                onClick={() =>
                                  void action("match", async () => {
                                    await invoke(
                                      "match_profile_fingerprint_to_exit",
                                      {
                                        profileId: profile.id,
                                        exitIp: result.exit_ip,
                                      },
                                    );
                                    setProbe(null);
                                    showSuccessToast(
                                      t("isolation.recheckRequired"),
                                    );
                                  })
                                }
                              >
                                {t("claudeWorkflow.reportMatchCta")}
                              </Button>
                            )}
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {t("isolation.notVerified")}
                        </p>
                      )}
                    </section>
                  </>
                ) : (
                  <div className="flex min-h-60 flex-col items-center justify-center gap-3 text-center">
                    <LuShield className="size-8 text-muted-foreground" />
                    <h2 className="font-semibold">
                      {t("isolation.emptyTitle")}
                    </h2>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      {t("isolation.empty")}
                    </p>
                    <Button onClick={() => setTab("create")}>
                      {t("isolation.create")}
                      <LuArrowRight className="size-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-0 space-y-5 overflow-auto p-6">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("isolation.createTitle")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("isolation.createDescription")}
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <SettingsPanel className="space-y-4 border">
                  <h3 className="text-sm font-semibold">
                    {t("isolation.existingProxy")}
                  </h3>
                  {"error" in plan ? (
                    <p className="text-sm text-muted-foreground">
                      {t("isolation.noFreeProxy")}
                    </p>
                  ) : (
                    <dl className="space-y-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          {t("isolation.route")}
                        </dt>
                        <dd>{plan.proxyName}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          {t("isolation.profileName")}
                        </dt>
                        <dd>{plan.name}</dd>
                      </div>
                    </dl>
                  )}
                  <Button
                    disabled={Boolean(busy) || "error" in plan}
                    onClick={() => {
                      if (!("error" in plan))
                        void action("create", () => create(plan));
                    }}
                  >
                    {busy === "create" && (
                      <LuLoaderCircle className="size-4 animate-spin" />
                    )}
                    {t("claudeWorkflow.autoCreateCta")}
                  </Button>
                </SettingsPanel>
                <SettingsPanel className="space-y-4 border">
                  <Label htmlFor="quick-proxy-input">
                    {t("claudeWorkflow.quickTitle")}
                  </Label>
                  <Input
                    id="quick-proxy-input"
                    type="password"
                    value={proxyInput}
                    onChange={(e) => setProxyInput(e.target.value)}
                    placeholder={t("claudeWorkflow.quickPlaceholder")}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={Boolean(busy)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("isolation.explicitSocks")}
                  </p>
                  <Button
                    disabled={Boolean(busy) || !proxyInput.trim()}
                    onClick={() => void action("quick", quickCreate)}
                  >
                    {busy === "quick" && (
                      <LuLoaderCircle className="size-4 animate-spin" />
                    )}
                    {t("claudeWorkflow.quickCta")}
                  </Button>
                </SettingsPanel>
              </div>
              <SettingsPanel className="space-y-3 border">
                <h3 className="text-sm font-semibold">
                  {t("isolation.preserved")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("isolation.boundaries")}
                </p>
                <Button
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    onClose();
                    onCreateProfile();
                  }}
                >
                  {t("claudeWorkflow.createCta")}
                </Button>
              </SettingsPanel>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <FingerprintAuditDialog
        key={auditProfile?.id ?? "none"}
        isOpen={Boolean(auditProfile)}
        profile={auditProfile}
        onClose={() => setAuditProfile(null)}
      />
    </>
  );
}
