import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "@/i18n";
import { updateAssignmentUsage } from "@/lib/profile-event-state";
import type { BrowserProfile, VpnConfig } from "@/types";

/**
 * Custom hook to manage VPN-related state and listen for backend events.
 * This hook eliminates the need for manual UI refreshes by automatically
 * updating state when the backend emits VPN change events.
 */
export function useVpnEvents() {
  const [vpnConfigs, setVpnConfigs] = useState<VpnConfig[]>([]);
  const [vpnUsage, setVpnUsage] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const profileAssignments = useRef<Record<string, string | undefined>>({});
  const assignmentVersions = useRef(new Map<string, number>());
  const usageLoadVersion = useRef(0);

  const loadVpnUsage = useCallback(async () => {
    const loadVersion = ++usageLoadVersion.current;
    const versionsAtStart = new Map(assignmentVersions.current);
    try {
      const profiles = await invoke<{ id: string; vpn_id?: string }[]>(
        "list_browser_profiles",
      );
      if (loadVersion !== usageLoadVersion.current) return;
      const assignments: Record<string, string | undefined> = {};
      for (const p of profiles) {
        assignments[p.id] = p.vpn_id;
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
      setVpnUsage(counts);
    } catch (err) {
      if (loadVersion !== usageLoadVersion.current) return;
      console.error("Failed to load VPN usage:", err);
    }
  }, []);

  const loadVpnConfigs = useCallback(async () => {
    try {
      const configs = await invoke<VpnConfig[]>("list_vpn_configs");
      setVpnConfigs(configs);
      await loadVpnUsage();
      setError(null);
    } catch (err: unknown) {
      console.error("Failed to load VPN configs:", err);
      setError(
        i18n.t("errors.loadVpnConfigsFailed", { error: JSON.stringify(err) }),
      );
    }
  }, [loadVpnUsage]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    let vpnConfigsUnlisten: (() => void) | undefined;
    let profilesUnlisten: (() => void) | undefined;
    let profileUpdatedUnlisten: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        vpnConfigsUnlisten = await listen("vpn-configs-changed", () => {
          void loadVpnConfigs();
        });

        profilesUnlisten = await listen("profiles-changed", () => {
          void loadVpnUsage();
        });

        profileUpdatedUnlisten = await listen<BrowserProfile>(
          "profile-updated",
          (event) => {
            const previousAssignments = profileAssignments.current;
            profileAssignments.current = {
              ...previousAssignments,
              [event.payload.id]: event.payload.vpn_id,
            };
            assignmentVersions.current.set(
              event.payload.id,
              (assignmentVersions.current.get(event.payload.id) ?? 0) + 1,
            );
            setVpnUsage((usage) => {
              const next = updateAssignmentUsage(
                { assignments: previousAssignments, usage },
                event.payload.id,
                event.payload.vpn_id,
              );
              return next.usage;
            });
          },
        );

        // Subscribe before loading so profile assignment changes cannot be
        // missed while the initial usage snapshot is in flight.
        await loadVpnConfigs();
      } catch (err) {
        console.error("Failed to setup VPN event listeners:", err);
        setError(
          i18n.t("errors.setupVpnListenersFailed", {
            error: JSON.stringify(err),
          }),
        );
      } finally {
        setIsLoading(false);
      }
    };

    void setupListeners();

    return () => {
      if (vpnConfigsUnlisten) vpnConfigsUnlisten();
      if (profilesUnlisten) profilesUnlisten();
      if (profileUpdatedUnlisten) profileUpdatedUnlisten();
    };
  }, [loadVpnConfigs, loadVpnUsage]);

  return {
    vpnConfigs,
    vpnUsage,
    isLoading,
    error,
    loadVpnConfigs,
    clearError,
  };
}
