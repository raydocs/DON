import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "@/i18n";
import { upsertProfileById } from "@/lib/profile-event-state";
import type { BrowserProfile, GroupWithCount } from "@/types";

interface UseProfileEventsReturn {
  profiles: BrowserProfile[];
  groups: GroupWithCount[];
  runningProfiles: Set<string>;
  isLoading: boolean;
  error: string | null;
  loadProfiles: () => Promise<void>;
  loadGroups: () => Promise<void>;
  clearError: () => void;
}

/**
 * Custom hook to manage profile-related state and listen for backend events.
 * This hook eliminates the need for manual UI refreshes by automatically
 * updating state when the backend emits profile change events.
 */
export function useProfileEvents(): UseProfileEventsReturn {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [groups, setGroups] = useState<GroupWithCount[]>([]);
  const [runningProfiles, setRunningProfiles] = useState<Set<string>>(
    new Set(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const profileUpdateVersions = useRef(new Map<string, number>());
  const profileLoadVersion = useRef(0);

  // Load profiles from backend
  const loadProfiles = useCallback(async () => {
    const loadVersion = ++profileLoadVersion.current;
    const versionsAtStart = new Map(profileUpdateVersions.current);
    try {
      const profileList = await invoke<BrowserProfile[]>(
        "list_browser_profiles",
      );
      if (loadVersion !== profileLoadVersion.current) return;
      setProfiles((current) => {
        const currentById = new Map(
          current.map((profile) => [profile.id, profile]),
        );
        const loadedIds = new Set(profileList.map((profile) => profile.id));
        const reconciled = profileList.map((loaded) => {
          const before = versionsAtStart.get(loaded.id) ?? 0;
          const after = profileUpdateVersions.current.get(loaded.id) ?? 0;
          return after === before
            ? loaded
            : (currentById.get(loaded.id) ?? loaded);
        });
        for (const existing of current) {
          if (
            !loadedIds.has(existing.id) &&
            (profileUpdateVersions.current.get(existing.id) ?? 0) >
              (versionsAtStart.get(existing.id) ?? 0)
          ) {
            reconciled.push(existing);
          }
        }
        return reconciled;
      });
      setError(null);
    } catch (err: unknown) {
      if (loadVersion !== profileLoadVersion.current) return;
      console.error("Failed to load profiles:", err);
      setError(
        i18n.t("errors.loadProfilesFailed", { error: JSON.stringify(err) }),
      );
    }
  }, []);

  // Load groups from backend
  const loadGroups = useCallback(async () => {
    try {
      const groupsWithCounts = await invoke<GroupWithCount[]>(
        "get_groups_with_profile_counts",
      );
      setGroups(groupsWithCounts);
      setError(null);
    } catch (err) {
      console.error("Failed to load groups with counts:", err);
      setGroups([]);
    }
  }, []);

  // Clear error state
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Initial load and event listeners setup
  useEffect(() => {
    let profilesUnlisten: (() => void) | undefined;
    let profileUpdatedUnlisten: (() => void) | undefined;
    let runningUnlisten: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        // Listen for profile changes (create, delete, rename, update, etc.)
        profilesUnlisten = await listen("profiles-changed", () => {
          console.log(
            "Received profiles-changed event, reloading profiles and groups",
          );
          void loadProfiles();
          void loadGroups();
        });

        profileUpdatedUnlisten = await listen<BrowserProfile>(
          "profile-updated",
          (event) => {
            const updated = event.payload;
            profileUpdateVersions.current.set(
              updated.id,
              (profileUpdateVersions.current.get(updated.id) ?? 0) + 1,
            );
            setProfiles((current) => upsertProfileById(current, updated));
          },
        );

        // Listen for profile running state changes
        runningUnlisten = await listen<{ id: string; is_running: boolean }>(
          "profile-running-changed",
          (event) => {
            const { id, is_running } = event.payload;
            setRunningProfiles((prev) => {
              const next = new Set(prev);
              if (is_running) {
                next.add(id);
              } else {
                next.delete(id);
              }
              return next;
            });
          },
        );

        // Subscribe before loading so no mutation can land in the gap between
        // the initial snapshot and listener registration.
        await Promise.all([loadProfiles(), loadGroups()]);

        console.log("Profile event listeners set up successfully");
      } catch (err) {
        console.error("Failed to setup profile event listeners:", err);
        setError(
          i18n.t("errors.setupProfileListenersFailed", {
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
      if (profilesUnlisten) profilesUnlisten();
      if (profileUpdatedUnlisten) profileUpdatedUnlisten();
      if (runningUnlisten) runningUnlisten();
    };
  }, [loadProfiles, loadGroups]);

  // Hydrate the initial runningProfiles set from the loaded list — every
  // profile that has a stored process_id is a candidate. The Rust status
  // checker emits profile-running-changed for any transitions; we then
  // mutate the Set incrementally instead of fan-out-polling all N profiles
  // every 30s (which was O(N) sysinfo scans and saturated the runtime for
  // users with hundreds of profiles).
  useEffect(() => {
    setRunningProfiles((prev) => {
      const next = new Set(prev);
      for (const p of profiles) {
        if (p.process_id != null) next.add(p.id);
      }
      // Drop ids for profiles that no longer exist
      const valid = new Set(profiles.map((p) => p.id));
      for (const id of next) {
        if (!valid.has(id)) next.delete(id);
      }
      return next;
    });
  }, [profiles]);

  return {
    profiles,
    groups,
    runningProfiles,
    isLoading,
    error,
    loadProfiles,
    loadGroups,
    clearError,
  };
}
