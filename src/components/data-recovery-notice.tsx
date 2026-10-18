"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { translateBackendError } from "@/lib/backend-errors";

type RecoveryItem = { id: string; path: string };

export function DataRecoveryNotice() {
  const { t } = useTranslation();
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restored, setRestored] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<RecoveryItem[]>("get_data_recovery_items"));
      setError(null);
    } catch (err) {
      setError(translateBackendError(t, err));
    }
  }, [t]);
  useEffect(() => {
    void refresh();
    const listener = listen("profiles-changed", () => void refresh());
    return () => {
      void listener.then((stop) => stop());
    };
  }, [refresh]);

  async function repair(item: RecoveryItem, reset = false) {
    setBusy(true);
    setError(null);
    try {
      const source = reset
        ? null
        : await open({
            multiple: false,
            directory: false,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
      if (!reset && !source) return;
      await invoke("recover_data_file", { id: item.id, source });
      setRestored(true);
      setConfirmReset(false);
      await refresh();
    } catch (err) {
      setError(translateBackendError(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (!items.length && !error && !restored) return null;
  return (
    <>
      <div
        role="status"
        className="mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
      >
        <p className="min-w-0 flex-1">
          {t(
            restored && !items.length
              ? "recovery.completed"
              : "recovery.notice",
            { count: items.length },
          )}
        </p>
        <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
          {t("recovery.review")}
        </Button>
      </div>
      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          if (!busy) setExpanded(open);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{t("recovery.title")}</DialogTitle>
            <DialogDescription>{t("recovery.description")}</DialogDescription>
          </DialogHeader>
          {error && (
            <p
              role="alert"
              className="break-words text-sm text-destructive-text"
            >
              {error}
            </p>
          )}
          {restored && (
            <p role="status" className="rounded-lg border p-3 text-sm">
              {t("recovery.completed")}
            </p>
          )}
          {items.map((item) => (
            <section key={item.id} className="space-y-3 rounded-xl border p-4">
              <h3 className="text-sm font-semibold">
                {t(
                  item.id === "settings"
                    ? "recovery.settings"
                    : "recovery.profile",
                )}
              </h3>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {item.path}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  item.id === "settings"
                    ? "recovery.settingsImpact"
                    : "recovery.profileImpact",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void repair(item)}
                >
                  {t("recovery.restore")}
                </Button>
                {item.id === "settings" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmReset(!confirmReset)}
                  >
                    {t("recovery.reset")}
                  </Button>
                )}
              </div>
              {item.id === "settings" && confirmReset && (
                <div className="space-y-2 rounded-lg bg-warning/10 p-3">
                  <p className="text-sm">{t("recovery.resetWarning")}</p>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void repair(item, true)}
                  >
                    {t("recovery.confirmReset")}
                  </Button>
                </div>
              )}
            </section>
          ))}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t("common.buttons.retry")}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
