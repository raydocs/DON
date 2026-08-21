import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "@/i18n";
import { updateAssignmentUsage } from "@/lib/profile-event-state";
import type { BrowserProfile, StoredProxy } from "@/types";

/**
 * Custom hook to manage proxy-related state and listen for backend events.
 * This hook eliminates the need for manual UI refreshes by automatically
 * updating state when the backend emits proxy change events.
 */
export function useProxyEvents() {
  const [storedProxies, setStoredProxies] = useState<StoredProxy[]>([]);
  const [proxyUsage, setProxyUsage] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const profileAssignments = useRef<Record<string, string | undefined>>({});
  const assignmentVersions = useRef(new Map<string, number>());
  const usageLoadVersion = useRef(0);

  // Load proxy usage (how many profiles are using each proxy)
  const loadProxyUsage = useCallback(async () => {
    const loadVersion = ++usageLoadVersion.current;
    const versionsAtStart = new Map(assignmentVersions.current);
    try {
      const profiles = await invoke<{ id: string; proxy_id?: string }[]>(
        "list_browser_profiles",
      );
      if (loadVersion !== usageLoadVersion.current) return;
      const assignments: Record<string, string | undefined> = {};
      for (const p of profiles) {
        assignments[p.id] = p.proxy_id;
      }
      for (const [profileId, assignmentId] of Object.entries(
        profileAssignments.current,
      )) {
        if (
          (assignmentVersions.current.get(profileId) ?? 0) >
          (versionsAtStart.get(profileId) ?? 0)
        ) {
          assignments[profileId] = assignmentId;
        }
      }
      const counts: Record<string, number> = {};
      for (const assignmentId of Object.values(assignments)) {
        if (assignmentId) {
          counts[assignmentId] = (counts[assignmentId] ?? 0) + 1;
        }
      }
      profileAssignments.current = assignments;
      setProxyUsage(counts);
    } catch (err) {
      if (loadVersion !== usageLoadVersion.current) return;
      console.error("Failed to load proxy usage:", err);
      // Don't set error for non-critical proxy usage
    }
  }, []);

  // Load proxies from backend
  const loadProxies = useCallback(async () => {
    try {
      const stored = await invoke<StoredProxy[]>("get_stored_proxies");
      setStoredProxies(stored);
      await loadProxyUsage();
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load proxies:", err);
      setError(
        i18n.t("errors.loadProxiesFailed", { error: JSON.stringify(err) }),
      );
    }
  }, [loadProxyUsage]);

  // Clear error state
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Initial load and event listeners setup
  useEffect(() => {
    let proxiesUnlisten: (() => void) | undefined;
    let profilesUnlisten: (() => void) | undefined;
    let profileUpdatedUnlisten: (() => void) | undefined;
    let storedProxiesUnlisten: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        // Listen for proxy changes (create, delete, update, start, stop, etc.)
        proxiesUnlisten = await listen("proxies-changed", () => {
          console.log("Received proxies-changed event, reloading proxies");
          void loadProxies();
        });

        // Listen for profile changes to update proxy usage counts
        profilesUnlisten = await listen("profiles-changed", () => {
          console.log("Received profiles-changed event, reloading proxy usage");
          void loadProxyUsage();
        });

        profileUpdatedUnlisten = await listen<BrowserProfile>(
          "profile-updated",
          (event) => {
            const previousAssignments = profileAssignments.current;
            profileAssignments.current = {
              ...previousAssignments,
              [event.payload.id]: event.payload.proxy_id,
            };
            assignmentVersions.current.set(
              event.payload.id,
              (assignmentVersions.current.get(event.payload.id) ?? 0) + 1,
            );
            setProxyUsage((usage) => {
              const next = updateAssignmentUsage(
                { assignments: previousAssignments, usage },
                event.payload.id,
                event.payload.proxy_id,
              );
              return next.usage;
            });
          },
        );

        // Listen for profile updates to update proxy usage counts
        storedProxiesUnlisten = await listen("stored-proxies-changed", () => {
          console.log(
            "Received stored-proxies-changed event, reloading proxies",
          );
          void loadProxies();
        });

        // Subscribe before loading so profile assignment changes cannot be
        // missed while the initial usage snapshot is in flight.
        await loadProxies();

        console.log("Proxy event listeners set up successfully");
      } catch (err) {
        console.error("Failed to setup proxy event listeners:", err);
        setError(
          i18n.t("errors.setupProxyListenersFailed", {
            error: JSON.stringify(err),
          }),
        );
      } finally {
        setIsLoading(false);
      }
    };

    void setupListeners();

    // Cleanup listeners on unmount
    return () => {
      if (proxiesUnlisten) proxiesUnlisten();
      if (profilesUnlisten) profilesUnlisten();
      if (profileUpdatedUnlisten) profileUpdatedUnlisten();
      if (storedProxiesUnlisten) storedProxiesUnlisten();
    };
  }, [loadProxies, loadProxyUsage]);

  return {
    storedProxies,
    proxyUsage,
    isLoading,
    error,
    loadProxies,
    clearError,
  };
}
