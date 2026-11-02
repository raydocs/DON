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
        showSuccessToast("连接成功！DON 云端同步集群在线");
      } else {
        setConnectionStatus("error");
        showErrorToast("连接失败，请检查服务器网络");
      }
    } catch {
      setConnectionStatus("error");
      showErrorToast("连接超时，请检查网络");
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
      showSuccessToast("DON 云端同步配置已生效");
      void testConnection(targetUrl);
    } catch (error) {
      console.error("Failed to save sync settings:", error);
      showErrorToast("保存配置失败");
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
      showSuccessToast("已断开云端同步");
    } catch (error) {
      console.error("Failed to disconnect:", error);
      showErrorToast("断开连接失败");
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
                  DON Cloud 账户与同步中心
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  DON 原生 Serverless 云端集群，支持全自动多机 Profile
                  同步、指纹防关联与白名单权限分发。
                </p>
              </div>
            </div>

            {/* Cloud Status Panel */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
                  </span>
                  <span className="font-semibold text-sm">
                    DON Cloudflare Serverless Cluster
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase font-mono border-emerald-500/30 text-emerald-500 bg-emerald-500/10"
                >
                  Active · Global Edge
                </Badge>
              </div>

              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-muted-foreground pt-1 border-t border-border/40">
                <span>同步服务器:</span>
                <code className="font-mono text-foreground truncate">
                  {serverUrl}
                </code>
                <span>存储架构:</span>
                <span className="text-foreground">
                  Cloudflare R2 Bucket (全球无出口费对象存储)
                </span>
                <span>权限数据库:</span>
                <span className="text-foreground">
                  Cloudflare D1 (Serverless SQLite 集群)
                </span>
                <span>连接状态:</span>
                <span className="text-foreground font-medium">
                  {connectionStatus === "connected" && (
                    <span className="text-emerald-500">已连接 (Readyz OK)</span>
                  )}
                  {connectionStatus === "testing" && (
                    <span className="text-muted-foreground">
                      正在检测通信...
                    </span>
                  )}
                  {connectionStatus === "error" && (
                    <span className="text-destructive">连接异常</span>
                  )}
                  {connectionStatus === "unknown" && (
                    <span className="text-muted-foreground">未检测</span>
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
                  Sync Token (您的专属授权密钥)
                </Label>
                <div className="relative">
                  <Input
                    id="account-sync-token"
                    type={showToken ? "text" : "password"}
                    placeholder="输入专属 Token (如 don_usr_... 或 Master Admin Token)"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="pr-10 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
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
                  填入在管理控制台分配的专属 Token
                  后，客户端将自动同步拉取授权给您的 Profile 环境。
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
                      ? "▼ 收起高级自定义域名"
                      : "▶ 自定义同步服务器地址 (高级)"}
                  </span>
                </button>
                {showAdvanced && (
                  <div className="space-y-1.5 pt-1 animate-in fade-in">
                    <Label htmlFor="account-server-url" className="text-xs">
                      Server Endpoint URL
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
                    <span>打开 Web 管理控制台</span>
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
                      清除凭证
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
                    {isTestingConnection ? "测试中..." : "测试连接"}
                  </Button>
                  <LoadingButton
                    size="sm"
                    isLoading={isSaving}
                    disabled={!token}
                    onClick={() => void handleSave()}
                    className="h-8 text-xs"
                  >
                    保存并立即同步
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
