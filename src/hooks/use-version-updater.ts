import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "@/i18n";
import { getBrowserDisplayName } from "@/lib/browser-utils";
import {
  showAutoUpdateToast,
  showErrorToast,
  showSuccessToast,
} from "@/lib/toast-utils";

interface VersionUpdateProgress {
  current_browser: string;
  total_browsers: number;
  completed_browsers: number;
  new_versions_found: number;
  browser_new_versions: number;
  status: string; // "updating", "completed", "error"
}

interface AutoUpdateEvent {
  browser: string;
  new_version: string;
  notification_id: string;
  affected_profiles: string[];
}

export function useVersionUpdater() {
  const [isUpdating, setIsUpdating] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<number | null>(null);
  const [timeUntilNextUpdate, setTimeUntilNextUpdate] = useState<number>(0);
  const [updateProgress, setUpdateProgress] =
    useState<VersionUpdateProgress | null>(null);

  // Track active downloads to prevent duplicates
  const activeDownloads = useRef(new Set<string>());

  const loadUpdateStatus = useCallback(async () => {
    try {
      const [lastUpdate, timeUntilNext] = await invoke<[number | null, number]>(
        "get_version_update_status",
      );
      setLastUpdateTime(lastUpdate);
      setTimeUntilNextUpdate(timeUntilNext);
    } catch (error) {
      console.error("Failed to load version update status:", error);
    }
  }, []);

  // Listen for version update progress events
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlistenFn = await listen<VersionUpdateProgress>(
          "version-update-progress",
          (event) => {
            const progress = event.payload;
            setUpdateProgress(progress);

            if (progress.status === "updating") {
              setIsUpdating(true);
            } else if (progress.status === "completed") {
              setIsUpdating(false);
              setUpdateProgress(null);
              void loadUpdateStatus();
            } else if (progress.status === "error") {
              setIsUpdating(false);
              setUpdateProgress(null);
            }
          },
        );
      } catch (error) {
        console.error(
          "Failed to setup version update progress listener:",
          error,
        );
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        try {
          unlistenFn();
        } catch (error) {
          console.error(
            "Failed to cleanup version update progress listener:",
            error,
          );
        }
      }
    };
  }, [loadUpdateStatus]);

  // Listen for browser auto-update events
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlistenFn = await listen<AutoUpdateEvent>(
          "browser-auto-update-available",
          (event) => {
            const handleAutoUpdate = async () => {
              const { browser, new_version, notification_id } = event.payload;
              console.log("Browser auto-update event received:", event.payload);

              const browserDisplayName = getBrowserDisplayName(browser);
              const downloadKey = `${browser}-${new_version}`;

              // Check if this download is already in progress
              if (activeDownloads.current.has(downloadKey)) {
                console.log(
                  `Download already in progress for ${browserDisplayName} ${new_version}, skipping`,
                );
                return;
              }

              // Mark download as active
              activeDownloads.current.add(downloadKey);

              try {
                // Show auto-update start notification
                showAutoUpdateToast(browserDisplayName, new_version, {
                  description: i18n.t(
                    "versionUpdater.toast.autoDownloadStarted",
                    {
                      browser: browserDisplayName,
                      version: new_version,
                    },
                  ),
                });

                // Dismiss the update notification in the backend
                await invoke("dismiss_update_notification", {
                  notificationId: notification_id,
                });

                // Check if browser already exists before downloading
                const isDownloaded = await invoke<boolean>(
                  "check_browser_exists",
                  {
                    browserStr: browser,
                    version: new_version,
                  },
                );

                if (isDownloaded) {
                  // Browser already exists, skip download and go straight to profile update
                  console.log(
                    `${browserDisplayName} ${new_version} already exists, skipping download`,
                  );

                  showSuccessToast(
                    i18n.t("versionUpdater.toast.alreadyAvailable", {
                      browser: browserDisplayName,
                      version: new_version,
                    }),
                    {
                      description: i18n.t(
                        "versionUpdater.toast.updatingProfiles",
                      ),
                      duration: 3000,
                    },
                  );
                } else {
                  // Download the browser - this will trigger download progress events automatically
                  await invoke("download_browser", {
                    browserStr: browser,
                    version: new_version,
                  });
                }

                // Complete the update with auto-update of profile versions
                const updatedProfiles = await invoke<string[]>(
                  "complete_browser_update_with_auto_update",
                  {
                    browser,
                    newVersion: new_version,
                  },
                );

                // Show success message based on whether profiles were updated
                if (updatedProfiles.length > 0) {
                  const description =
                    updatedProfiles.length === 1
                      ? i18n.t("versionUpdater.toast.singleProfileUpdated", {
                          name: updatedProfiles[0],
                          version: new_version,
                        })
                      : i18n.t("versionUpdater.toast.multipleProfilesUpdated", {
                          count: updatedProfiles.length,
                          version: new_version,
                        });

                  showSuccessToast(
                    i18n.t("versionUpdater.toast.updateCompleted", {
                      browser: browserDisplayName,
                    }),
                    {
                      description,
                      duration: 6000,
                    },
                  );
                } else {
                  showSuccessToast(
                    i18n.t("versionUpdater.toast.updateCompleted", {
                      browser: browserDisplayName,
                    }),
                    {
                      description: i18n.t(
                        "versionUpdater.toast.versionAvailable",
                        { version: new_version },
                      ),
                      duration: 6000,
                    },
                  );
                }
              } catch (error) {
                console.error("Failed to handle browser auto-update:", error);

                let errorMessage = i18n.t("common.errors.unknown");
                if (error instanceof Error) {
                  errorMessage = error.message;
                } else if (typeof error === "string") {
                  errorMessage = error;
                } else if (
                  error &&
                  typeof error === "object" &&
                  "message" in error
                ) {
                  errorMessage = String(error.message);
                }

                showErrorToast(
                  i18n.t("versionUpdater.toast.autoUpdateFailed", {
                    browser: browserDisplayName,
                  }),
                  {
                    description: errorMessage,
                    duration: 8000,
                  },
                );
              } finally {
                // Remove from active downloads
                activeDownloads.current.delete(downloadKey);
              }
            };

            // Call the async handler
            void handleAutoUpdate();
          },
        );
      } catch (error) {
        console.error("Failed to setup browser auto-update listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        try {
          unlistenFn();
        } catch (error) {
          console.error(
            "Failed to cleanup browser auto-update listener:",
            error,
          );
        }
      }
    };
  }, []);

  // Load update status on mount and periodically
  useEffect(() => {
    void loadUpdateStatus();

    // Update status every minute
    const interval = setInterval(() => {
      void loadUpdateStatus();
    }, 60000);

    return () => {
      clearInterval(interval);
    };
  }, [loadUpdateStatus]);

  return {
    isUpdating,
    lastUpdateTime,
    timeUntilNextUpdate,
    updateProgress,
    loadUpdateStatus,
  };
}
