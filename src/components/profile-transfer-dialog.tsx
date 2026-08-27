"use client";

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuShare2 } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
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
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

interface ProfileTransferDialogProps {
  isOpen: boolean;
  onClose: () => void;
  profile: BrowserProfile | null;
}

export function ProfileTransferDialog({
  isOpen,
  onClose,
  profile,
}: ProfileTransferDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeProxy, setIncludeProxy] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPassword("");
      setConfirmation("");
      setIncludeProxy(Boolean(profile?.proxy_id));
    }
  }, [isOpen, profile?.proxy_id]);

  if (!profile) return null;

  const handleSave = async () => {
    if (password !== confirmation) {
      showErrorToast(t("profileTransfer.passwordsDoNotMatch"));
      return;
    }
    if (password.length < 8) {
      showErrorToast(t("backendErrors.passwordTooShort", { min: 8 }));
      return;
    }

    const safeName = profile.name.replaceAll(/[\\/:*?"<>|]/g, "_");
    let destination: string | null;
    try {
      destination = await save({
        defaultPath: `${safeName}.donprofile`,
        title: t("profileTransfer.chooseDestination"),
        filters: [
          {
            name: t("profileTransfer.fileType"),
            extensions: ["donprofile"],
          },
        ],
      });
    } catch (error) {
      console.error("Failed to open profile transfer save dialog:", error);
      showErrorToast(t("profileTransfer.fileDialogFailed"));
      return;
    }
    if (!destination) return;

    setIsSaving(true);
    try {
      await invoke("export_profile_transfer", {
        profileId: profile.id,
        destination,
        password,
        includeProxy,
      });
      showSuccessToast(t("profileTransfer.saveSuccess"));
      onClose();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LuShare2 className="size-4" />
            {t("profileTransfer.shareTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("profileTransfer.shareDescription", { name: profile.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Alert>
            <AlertDescription>
              {t("profileTransfer.passwordNotice")}
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label htmlFor="profile-transfer-password">
              {t("profileTransfer.password")}
            </Label>
            <Input
              id="profile-transfer-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("profileTransfer.passwordPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-transfer-confirm-password">
              {t("profileTransfer.confirmPassword")}
            </Label>
            <Input
              id="profile-transfer-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          {profile.proxy_id && (
            <label
              htmlFor="profile-transfer-include-proxy"
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3"
            >
              <Checkbox
                id="profile-transfer-include-proxy"
                checked={includeProxy}
                onCheckedChange={(checked) => setIncludeProxy(checked === true)}
              />
              <span>
                <span className="block text-sm font-medium">
                  {t("profileTransfer.includeProxy")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("profileTransfer.includeProxyDescription")}
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <LoadingButton
            isLoading={isSaving}
            disabled={!password || !confirmation}
            onClick={() => void handleSave()}
          >
            {t("profileTransfer.saveButton")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
