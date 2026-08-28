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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { SyncSettings } from "@/types";

const DEFAULT_SERVER_URL = "https://don-sync-worker.ppop.workers.dev";
const ADMIN_CONSOLE_URL = "https://don-sync-worker.ppop.workers.dev/admin";

interface SyncConfigDialogProps {
  isOpen: boolean;
  onClose: (loginOccurred?: boolean) => void;
  onLoginStarted?: () => void;
}

export function SyncConfigDialog({ isOpen, onClose }: SyncConfigDialogProps) {
  const { t } = useTranslation();

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [token, setToken] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [connectionStatus, setConnectionStatus] = useState<
    "unknown" | "testing" | "connected" | "error"
  >("unknown");
  const [storageEndpoint, setStorageEndpoint] = useState<string | null>(null);
  const hasConfig = Boolean(token);

  const probeServer = useCallback(async (url: string) => {
    const base = url.replace(/\/$/, "");
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.status === 404) {
        const health = await fetch(`${base}/health`);
        return { ok: health.ok, storageEndpoint: undefined };
      }
      if (!response.ok) {
        return { ok: false as const, storageEndpoint: undefined };
      }
      const body = (await response.json()) as {
        storageEndpoint?: string;
      } | null;
      return { ok: true as const, storageEndpoint: body?.storageEndpoint };
    } catch {
      return { ok: false as const, storageEndpoint: undefined };
    }
  }, []);

  const testConnection = useCallback(
    async (url: string) => {
      setConnectionStatus("testing");
      try {
        const result = await probeServer(url || DEFAULT_SERVER_URL);
        setStorageEndpoint(result.storageEndpoint ?? null);
        setConnectionStatus(result.ok ? "connected" : "error");
      } catch {
        setStorageEndpoint(null);
        setConnectionStatus("error");
      }
    },
    [probeServer],
  );

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
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
    } finally {
      setIsLoading(false);
    }
  }, [testConnection]);

  useEffect(() => {
    if (isOpen) {
      setConnectionStatus("unknown");
      void loadSettings();
    }
  }, [isOpen, loadSettings]);

  const handleTestConnection = useCallback(async () => {
    const targetUrl = serverUrl || DEFAULT_SERVER_URL;
    setIsTesting(true);
    setConnectionStatus("testing");
    try {
      const result = await probeServer(targetUrl);
      setStorageEndpoint(result.storageEndpoint ?? null);
      if (result.ok) {
        setConnectionStatus("connected");
        showSuccessToast("连接成功！DON 云端同步节点正常响应");
      } else {
        setConnectionStatus("error");
        showErrorToast("连接失败，请检查服务器网络");
      }
    } catch {
      setStorageEndpoint(null);
      setConnectionStatus("error");
      showErrorToast("连接超时，请检查网络");
    } finally {
      setIsTesting(false);
    }
  }, [serverUrl, probeServer]);

  const handleSave = useCallback(async () => {
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
      showSuccessToast("DON 云端同步配置已保存并生效！");
      onClose();
    } catch (error) {
      console.error("Failed to save sync settings:", error);
      showErrorToast("保存同步设置失败");
    } finally {
      setIsSaving(false);
    }
  }, [serverUrl, token, onClose]);

  const handleDisconnect = useCallback(async () => {
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
  }, []);

  const handleOpenAdmin = useCallback(async () => {
    try {
      const url = token
        ? `${ADMIN_CONSOLE_URL}?token=${encodeURIComponent(token)}`
        : ADMIN_CONSOLE_URL;
      await openUrl(url);
    } catch (e) {
      console.error("Failed to open admin URL:", e);
    }
  }, [token]);

  return (
    <Dialog open={isOpen} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <LuCloud className="size-5" />
            </div>
            <DialogTitle>DON Cloud Sync</DialogTitle>
          </div>
          <DialogDescription>
            DON 官方云端多机同步集群，支持 Profile
            浏览器环境实时同步、权限分配与多端指纹隔离。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
          </div>
        ) : (
          <div className="grid gap-4 py-3">
            <div className="space-y-2">
              <Label htmlFor="sync-token">Sync Token (专属授权密钥)</Label>
              <div className="relative">
                <Input
                  id="sync-token"
                  type={showToken ? "text" : "password"}
                  placeholder="输入专属 Token (如 don_usr_... 或管理员 Token)"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                  }}
                  className="pr-10 font-mono text-sm"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setShowToken(!showToken);
                      }}
                      className="absolute top-1/2 right-3 -translate-y-1/2 transform rounded-sm p-1 transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      {showToken ? (
                        <LuEyeOff className="size-4 text-muted-foreground hover:text-foreground" />
                      ) : (
                        <LuEye className="size-4 text-muted-foreground hover:text-foreground" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {showToken ? "隐藏密钥" : "显示密钥"}
                  </TooltipContent>
                </Tooltip>
              </div>
              <p className="text-[11px] text-muted-foreground">
                填入管理员提供的用户专属 Token
                后，客户端将自动同步分配给您的环境。
              </p>
            </div>

            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <span>
                  {showAdvanced
                    ? "▼ 收起高级设置"
                    : "▶ 高级设置 (自定义服务器地址)"}
                </span>
              </button>

              {showAdvanced && (
                <div className="pt-2 space-y-1.5 animate-in fade-in">
                  <Label htmlFor="sync-server-url" className="text-xs">
                    Server URL
                  </Label>
                  <Input
                    id="sync-server-url"
                    placeholder={DEFAULT_SERVER_URL}
                    value={serverUrl}
                    onChange={(e) => {
                      setServerUrl(e.target.value);
                    }}
                    className="text-xs font-mono"
                  />
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">节点状态:</span>
                {connectionStatus === "testing" && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <div className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    正在检测...
                  </span>
                )}
                {connectionStatus === "connected" && (
                  <span className="flex items-center gap-1.5 text-emerald-500 font-medium">
                    <span className="size-2 rounded-full bg-emerald-500" />
                    Cloudflare Edge (已连接)
                  </span>
                )}
                {connectionStatus === "error" && (
                  <span className="flex items-center gap-1.5 text-destructive font-medium">
                    <span className="size-2 rounded-full bg-destructive" />
                    连接失败
                  </span>
                )}
                {connectionStatus === "unknown" && (
                  <span className="text-muted-foreground">未检测</span>
                )}
              </div>

              {storageEndpoint && (
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>存储引擎:</span>
                  <span className="font-mono text-foreground">
                    Cloudflare R2 (Zero Egress)
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => void handleOpenAdmin()}
              >
                <LuShieldCheck className="size-3.5" />
                <span>Web 管理控制台</span>
                <LuExternalLink className="size-3" />
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="flex gap-2">
          {hasConfig && (
            <Button
              variant="outline"
              onClick={() => void handleDisconnect()}
              disabled={isSaving}
            >
              断开连接
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => void handleTestConnection()}
            disabled={isTesting}
          >
            {isTesting ? "测试中..." : "测试连接"}
          </Button>
          <LoadingButton
            onClick={() => void handleSave()}
            isLoading={isSaving}
            disabled={!token}
          >
            保存并同步
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
