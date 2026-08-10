"use client";

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuDownload,
  LuFingerprint,
  LuRefreshCw,
  LuTriangleAlert,
} from "react-icons/lu";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type {
  BrowserProfile,
  FingerprintAuditItem,
  FingerprintAuditReport,
} from "@/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";

interface FingerprintAuditDialogProps {
  isOpen: boolean;
  onClose: () => void;
  profile: BrowserProfile | null;
  subPage?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  navigator: "fingerprintAudit.categories.navigator",
  screen: "fingerprintAudit.categories.screen",
  window: "fingerprintAudit.categories.window",
  timezone: "fingerprintAudit.categories.timezone",
  webgl: "fingerprintAudit.categories.webgl",
  media: "fingerprintAudit.categories.media",
  color: "fingerprintAudit.categories.color",
  storage: "fingerprintAudit.categories.storage",
  battery: "fingerprintAudit.categories.battery",
  fonts: "fingerprintAudit.categories.fonts",
  browser: "fingerprintAudit.categories.browser",
  network: "fingerprintAudit.categories.network",
  performance: "fingerprintAudit.categories.performance",
  observation: "fingerprintAudit.categories.observation",
};

const FIELD_LABELS: Record<string, string> = {
  userAgent: "fingerprint.userAgent",
  platform: "fingerprint.platform",
  platformVersion: "fingerprint.platformVersion",
  brand: "fingerprint.brand",
  brandVersion: "fingerprint.brandVersion",
  hardwareConcurrency: "fingerprint.hardwareConcurrency",
  maxTouchPoints: "fingerprint.maxTouchPoints",
  deviceMemory: "fingerprint.deviceMemory",
  language: "fingerprint.primaryLanguage",
  languages: "fingerprint.languages",
  doNotTrack: "fingerprint.doNotTrack",
  cookieEnabled: "fingerprint.cookieEnabled",
  webdriver: "fingerprint.webdriver",
  pdfViewerEnabled: "fingerprint.pdfViewerEnabled",
  screenWidth: "fingerprint.screenWidth",
  screenHeight: "fingerprint.screenHeight",
  screenAvailWidth: "fingerprint.availableWidth",
  screenAvailHeight: "fingerprint.availableHeight",
  screenColorDepth: "fingerprint.colorDepth",
  screenPixelDepth: "fingerprint.pixelDepth",
  devicePixelRatio: "fingerprint.devicePixelRatio",
  windowOuterWidth: "fingerprint.outerWidth",
  windowOuterHeight: "fingerprint.outerHeight",
  windowInnerWidth: "fingerprint.innerWidth",
  windowInnerHeight: "fingerprint.innerHeight",
  screenX: "fingerprint.screenX",
  screenY: "fingerprint.screenY",
  timezone: "fingerprint.timezoneIana",
  webglVendor: "fingerprint.webglVendor",
  webglRenderer: "fingerprint.webglRenderer",
  webglVersion: "fingerprint.webglVersion",
  webglShadingLanguageVersion: "fingerprint.webglShadingLanguageVersion",
  prefersReducedMotion: "fingerprint.prefersReducedMotion",
  prefersDarkMode: "fingerprint.prefersDarkMode",
  prefersContrast: "fingerprint.prefersContrast",
  prefersReducedData: "fingerprint.prefersReducedData",
  colorGamutSrgb: "fingerprint.colorGamutSrgb",
  colorGamutP3: "fingerprint.colorGamutP3",
  colorGamutRec2020: "fingerprint.colorGamutRec2020",
  hdrSupport: "fingerprint.hdrSupport",
  localStorage: "fingerprint.localStorage",
  sessionStorage: "fingerprint.sessionStorage",
  indexedDb: "fingerprint.indexedDb",
  batteryCharging: "fingerprint.charging",
  batteryChargingTime: "fingerprint.chargingTime",
  batteryDischargingTime: "fingerprint.dischargingTime",
  batteryLevel: "fingerprint.batteryLevel",
  fonts: "fingerprint.fontsJson",
  plugins: "fingerprint.pluginsJson",
  mimeTypes: "fingerprint.mimeTypesJson",
  voices: "fingerprint.voicesJson",
  connectionEffectiveType: "fingerprint.connectionEffectiveType",
  connectionDownlink: "fingerprint.connectionDownlink",
  connectionRtt: "fingerprint.connectionRtt",
  performanceMemory: "fingerprint.performanceMemory",
  audioHash: "fingerprintAudit.observationLabels.audioHash",
  mediaDevices: "fingerprintAudit.observationLabels.mediaDevices",
  webrtcCandidates: "fingerprintAudit.observationLabels.webrtcCandidates",
  webglParameters: "fingerprintAudit.observationLabels.webglParameters",
};

function formatValue(value: unknown, notAvailable: string): string {
  if (value === null || value === undefined) return notAvailable;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function statusClass(status: string): string {
  switch (status) {
    case "match":
      return "border-success/30 bg-success/10 text-success-text";
    case "mismatch":
      return "border-destructive/30 bg-destructive/10 text-destructive-text";
    case "observed":
      return "border-primary/30 bg-primary/10 text-primary-text";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function statusLabelKey(status: string): string {
  switch (status) {
    case "match":
      return "fingerprintAudit.statusMatch";
    case "mismatch":
      return "fingerprintAudit.statusMismatch";
    case "observed":
      return "fingerprintAudit.statusObserved";
    case "cross_origin_frame":
      return "fingerprintAudit.statusCrossOriginFrame";
    case "frame_present":
      return "fingerprintAudit.statusFramePresent";
    default:
      return "fingerprintAudit.statusUnknown";
  }
}

function AuditItemRow({
  item,
  t,
}: {
  item: FingerprintAuditItem;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const fieldLabel = FIELD_LABELS[item.key];
  const categoryLabel = CATEGORY_LABELS[item.category];
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3 @md:grid-cols-[minmax(10rem,1fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_auto] @md:items-center">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {categoryLabel ? t(categoryLabel) : item.category}
        </p>
        <p className="truncate text-sm font-medium">
          {fieldLabel ? t(fieldLabel) : item.key}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {t("fingerprintAudit.expected")}
        </p>
        <p className="truncate font-mono text-xs">
          {formatValue(item.expected, t("fingerprintAudit.notAvailable"))}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {t("fingerprintAudit.actual")}
        </p>
        <p className="truncate font-mono text-xs">
          {formatValue(item.actual, t("fingerprintAudit.notAvailable"))}
        </p>
      </div>
      <Badge variant="outline" className={statusClass(item.status)}>
        {t(statusLabelKey(item.status))}
      </Badge>
      {item.detail && (
        <p className="col-span-full text-xs text-muted-foreground">
          {item.detail}
        </p>
      )}
    </div>
  );
}

export function FingerprintAuditDialog({
  isOpen,
  onClose,
  profile,
  subPage = false,
}: FingerprintAuditDialogProps) {
  const { t } = useTranslation();
  const [report, setReport] = useState<FingerprintAuditReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAudit = useCallback(async () => {
    if (!profile) return;
    setIsRunning(true);
    setError(null);
    try {
      const next = await invoke<FingerprintAuditReport>(
        "run_fingerprint_audit",
        { profileId: profile.id },
      );
      setReport(next);
    } catch (reason) {
      setError(translateBackendError(t as never, reason));
    } finally {
      setIsRunning(false);
    }
  }, [profile, t]);

  useEffect(() => {
    if (!isOpen) {
      setReport(null);
      setError(null);
      setIsRunning(false);
      return;
    }
    void runAudit();
  }, [isOpen, runAudit]);

  const handleExport = useCallback(async () => {
    if (!report || !profile) return;
    try {
      const path = await save({
        defaultPath: `${profile.name}_fingerprint_audit.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await writeTextFile(path, JSON.stringify(report, null, 2));
      showSuccessToast(t("fingerprintAudit.exportSuccess"));
    } catch (reason) {
      showErrorToast(translateBackendError(t as never, reason));
    }
  }, [profile, report, t]);

  const mismatchItems = useMemo(
    () => report?.items.filter((item) => item.status === "mismatch") ?? [],
    [report],
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => !open && onClose()}
      subPage={subPage}
    >
      <DialogContent className="flex min-h-0 flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <LuFingerprint className="size-4" />
            {t("fingerprintAudit.title")}
          </DialogTitle>
          <DialogDescription>
            {t("fingerprintAudit.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => void runAudit()}
            disabled={isRunning || !profile}
          >
            <LuRefreshCw
              className={isRunning ? "size-3.5 animate-spin" : "size-3.5"}
            />
            {isRunning
              ? t("fingerprintAudit.running")
              : report
                ? t("fingerprintAudit.runAgain")
                : t("fingerprintAudit.run")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => void handleExport()}
            disabled={!report || isRunning}
          >
            <LuDownload className="size-3.5" />
            {t("fingerprintAudit.export")}
          </Button>
          {report && (
            <span className="text-xs text-muted-foreground">
              {report.profile_name} · {report.target}
            </span>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-text">
            <LuTriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1 pr-3">
          {isRunning && !report ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
              {t("fingerprintAudit.running")}
            </div>
          ) : report ? (
            <div className="space-y-4 pb-2">
              {mismatchItems.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-text">
                  <LuTriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <span>{t("fingerprintAudit.mismatchNotice")}</span>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("fingerprintAudit.summary")}
                </p>
                <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
                  <SummaryCard
                    label={t("fingerprintAudit.total")}
                    value={report.summary.total}
                  />
                  <SummaryCard
                    label={t("fingerprintAudit.matches")}
                    value={report.summary.matches}
                    icon={<LuCheck className="size-3.5 text-success-text" />}
                  />
                  <SummaryCard
                    label={t("fingerprintAudit.mismatches")}
                    value={report.summary.mismatches}
                    icon={
                      <LuTriangleAlert className="size-3.5 text-destructive-text" />
                    }
                  />
                  <SummaryCard
                    label={t("fingerprintAudit.unknown")}
                    value={report.summary.unknown}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("fingerprintAudit.details")}
                </p>
                <div className="space-y-2">
                  {report.items.map((item) => (
                    <AuditItemRow
                      key={`${item.category}-${item.key}`}
                      item={item}
                      t={t}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("fingerprintAudit.observations")}
                </p>
                <div className="space-y-2">
                  {report.observations.map((item) => (
                    <AuditItemRow key={item.key} item={item} t={t} />
                  ))}
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {t("fingerprintAudit.oopif")}
                  </p>
                  <Badge
                    variant="outline"
                    className={statusClass(report.oopif.status)}
                  >
                    {t(statusLabelKey(report.oopif.status))}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("fingerprintAudit.oopifDescription")}
                </p>
                <div className="grid grid-cols-1 gap-2 @md:grid-cols-3">
                  <SummaryCard
                    label={t("fingerprintAudit.frameCount")}
                    value={report.oopif.frame_count}
                  />
                  <SummaryCard
                    label={t("fingerprintAudit.childDevicePixelRatio")}
                    value={
                      report.oopif.child_device_pixel_ratio ??
                      t("fingerprintAudit.notAvailable")
                    }
                  />
                  <SummaryCard
                    label={t("fingerprintAudit.childScreenWidth")}
                    value={
                      report.oopif.child_screen_width ??
                      t("fingerprintAudit.notAvailable")
                    }
                  />
                </div>
                {report.oopif.children.length > 0 && (
                  <div className="space-y-2">
                    {report.oopif.children.map((child) => (
                      <div
                        className="rounded-md border border-border/70 bg-background/40 p-2"
                        key={child.origin}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium">
                            {child.origin}
                          </span>
                          <Badge
                            variant="outline"
                            className={statusClass(child.status)}
                          >
                            {t(statusLabelKey(child.status))}
                          </Badge>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <SummaryCard
                            label={t("fingerprintAudit.childDevicePixelRatio")}
                            value={
                              child.device_pixel_ratio ??
                              t("fingerprintAudit.notAvailable")
                            }
                          />
                          <SummaryCard
                            label={t("fingerprintAudit.childScreenWidth")}
                            value={
                              child.screen_width ??
                              t("fingerprintAudit.notAvailable")
                            }
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {report.oopif.detail && (
                  <p className="text-xs text-muted-foreground">
                    {report.oopif.detail}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
              {t("fingerprintAudit.noReport")}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            {t("common.buttons.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] tracking-wide text-muted-foreground uppercase">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
