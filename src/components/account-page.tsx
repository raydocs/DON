"use client";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCloud,
  LuExternalLink,
  LuEye,
  LuEyeOff,
  LuShieldCheck,
} from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { SyncSettings } from "@/types";

const DEFAULT_SERVER_URL = "https://don-sync-worker.ppop.workers.dev";
const ADMIN_CONSOLE_URL = "https://don-sync-worker.ppop.workers.dev/admin";

interface AccountPageProps {
  isOpen: boolean;
  onClose: () => void;
  subPage?: boolean;
  onOpenSignIn: () => void;
}

type ConnectionStatus = "unknown" | "testing" | "connected" | "error";

export function AccountPage({ isOpen, onClose, subPage }: AccountPageProps) {
  const { t } = useTranslation();

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("unknown");

  const probeServer = useCallback(async (url: string) => {
    const base = url.replace(/\/$/, "");
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.status === 404) {
        const health = await fetch(`${base}/health`);
        return { ok: health.ok };
      }
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }, []);

  const testConnection = useCallback(
    async (url: string) => {
      setConnectionStatus("testing");
      try {
        const result = await probeServer(url || DEFAULT_SERVER_URL);
        setConnectionStatus(result.ok ? "connected" : "error");
      } catch {
        setConnectionStatus("error");
      }
    },
    [probeServer],
  );

  const loadSettings = useCallback(async () => {
    try {
      const settings = await invoke<SyncSettings>("get_sync_settings");
      const url = settings.sync_server_url || DEFAULT_SERVER_URL;
      setServerUrl(url);
      setToken(settings.sync_token ?? "");
      if (settings.sync_token) {
        void testConnection(url);
      }
    } catch (error) {
      console.error("Failed to load sync settings:", error);
    }
  }, [testConnection]);

  useEffect(() => {
    if (isOpen) {
      void loadSettings();
    }
  }, [isOpen, loadSettings]);

  const handleTestConnection = async () => {
    const targetUrl = serverUrl || DEFAULT_SERVER_URL;
    setIsTestingConnection(true);
    setConnectionStatus("testing");
    try {
      const result = await probeServer(targetUrl);
      if (result.ok) {
        setConnectionStatus("connected");
        showSuccessToast(t("account.donCloud.toasts.connectionSuccess"));
      } else {
        setConnectionStatus("error");
        showErrorToast(t("account.donCloud.toasts.connectionFailed"));
      }
    } catch {
      setConnectionStatus("error");
      showErrorToast(t("account.donCloud.toasts.connectionTimeout"));
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    const targetUrl = serverUrl || DEFAULT_SERVER_URL;
    try {
      await invoke<SyncSettings>("save_sync_settings", {
        syncServerUrl: targetUrl,
        syncToken: token || null,
      });
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      showSuccessToast(t("account.donCloud.toasts.settingsSaved"));
      void testConnection(targetUrl);
    } catch (error) {
      console.error("Failed to save sync settings:", error);
      showErrorToast(t("account.donCloud.toasts.saveFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setIsSaving(true);
    try {
      await invoke<SyncSettings>("save_sync_settings", {
        syncServerUrl: null,
        syncToken: null,
      });
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      setToken("");
      setConnectionStatus("unknown");
      showSuccessToast(t("account.donCloud.toasts.disconnected"));
    } catch (error) {
      console.error("Failed to disconnect:", error);
      showErrorToast(t("account.donCloud.toasts.disconnectFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenAdmin = async () => {
    try {
      const url = token
        ? `${ADMIN_CONSOLE_URL}?token=${encodeURIComponent(token)}`
        : ADMIN_CONSOLE_URL;
      await openUrl(url);
    } catch (e) {
      console.error("Failed to open admin URL:", e);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
      <DialogContent className="flex max-h-[calc(100vh-5rem)] max-w-2xl flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              subPage && "mx-auto w-full max-w-3xl",
              "space-y-6 py-2",
            )}
          >
            <div className="flex items-center gap-3">
              <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <LuCloud className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold tracking-tight">
                  {t("account.donCloud.title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("account.donCloud.description")}
                </p>
              </div>
            </div>

            {/* Cloud Status Panel */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-success" />
                  </span>
                  <span className="font-semibold text-sm">
                    {t("account.donCloud.clusterName")}
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className="border-success/30 bg-success/10 font-mono text-[10px] text-success uppercase"
                >
                  {t("account.donCloud.clusterStatus")}
                </Badge>
              </div>

              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-muted-foreground pt-1 border-t border-border/40">
                <span>{t("account.donCloud.serverLabel")}</span>
                <code className="font-mono text-foreground truncate">
                  {serverUrl}
                </code>
                <span>{t("account.donCloud.storageLabel")}</span>
                <span className="text-foreground">
                  {t("account.donCloud.storageValue")}
                </span>
                <span>{t("account.donCloud.permissionsLabel")}</span>
                <span className="text-foreground">
                  {t("account.donCloud.permissionsValue")}
                </span>
                <span>{t("account.donCloud.connectionLabel")}</span>
                <span className="text-foreground font-medium">
                  {connectionStatus === "connected" && (
                    <span className="text-success">
                      {t("account.donCloud.status.connected")}
                    </span>
                  )}
                  {connectionStatus === "testing" && (
                    <span className="text-muted-foreground">
                      {t("account.donCloud.status.testing")}
                    </span>
                  )}
                  {connectionStatus === "error" && (
                    <span className="text-destructive">
                      {t("account.donCloud.status.error")}
                    </span>
                  )}
                  {connectionStatus === "unknown" && (
                    <span className="text-muted-foreground">
                      {t("account.donCloud.status.unknown")}
                    </span>
                  )}
                </span>
              </div>
            </div>

            {/* Token & Server Config Form */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-4">
              <div className="space-y-2">
                <Label
                  htmlFor="account-sync-token"
                  className="text-sm font-semibold"
                >
                  {t("account.donCloud.tokenLabel")}
                </Label>
                <div className="relative">
                  <Input
                    id="account-sync-token"
                    type={showToken ? "text" : "password"}
                    placeholder={t("account.donCloud.tokenPlaceholder")}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="pr-10 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    aria-label={t(
                      showToken
                        ? "account.donCloud.hideToken"
                        : "account.donCloud.showToken",
                    )}
                    className="absolute top-1/2 right-3 -translate-y-1/2 transform rounded-sm p-1 transition-colors hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                  >
                    {showToken ? (
                      <LuEyeOff className="size-4" />
                    ) : (
                      <LuEye className="size-4" />
                    )}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("account.donCloud.tokenDescription")}
                </p>
              </div>

              {/* Advanced Server URL Accordion */}
              <div className="space-y-2 pt-1 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  <span>
                    {showAdvanced
                      ? t("account.donCloud.advancedCollapse")
                      : t("account.donCloud.advancedExpand")}
                  </span>
                </button>
                {showAdvanced && (
                  <div className="space-y-1.5 pt-1 animate-in fade-in">
                    <Label htmlFor="account-server-url" className="text-xs">
                      {t("account.donCloud.serverUrlLabel")}
                    </Label>
                    <Input
                      id="account-server-url"
                      placeholder={DEFAULT_SERVER_URL}
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleOpenAdmin()}
                    className="h-8 gap-1.5 text-xs"
                  >
                    <LuShieldCheck className="size-3.5" />
                    <span>{t("account.donCloud.openAdmin")}</span>
                    <LuExternalLink className="size-3" />
                  </Button>
                  {token && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleDisconnect()}
                      disabled={isSaving}
                      className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      {t("account.donCloud.clearCredentials")}
                    </Button>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isTestingConnection}
                    onClick={() => void handleTestConnection()}
                    className="h-8 text-xs"
                  >
                    {isTestingConnection
                      ? t("account.donCloud.testing")
                      : t("account.donCloud.testConnection")}
                  </Button>
                  <LoadingButton
                    size="sm"
                    isLoading={isSaving}
                    disabled={!token}
                    onClick={() => void handleSave()}
                    className="h-8 text-xs"
                  >
                    {t("account.donCloud.saveAndSync")}
                  </LoadingButton>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
