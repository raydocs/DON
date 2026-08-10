"use client";

import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { GoPlus } from "react-icons/go";
import { LuCheck, LuChevronsUpDown, LuLoaderCircle } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { ProxyFormDialog } from "@/components/proxy-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { WayfernConfigForm } from "@/components/wayfern-config-form";
import { useBrowserDownload } from "@/hooks/use-browser-download";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { getBrowserIcon } from "@/lib/browser-utils";
import {
  buildAutoProfileName,
  buildClaudeNote,
  buildClaudeTags,
  buildProxyOccupancy,
  buildResidentialLabel,
  CLAUDE_DEFAULT_START_URL,
  claudeCreateBlockers,
  getClaudeWayfernConfig,
  nextAutoCardLabel,
  PROXY_REUSE_COOLDOWN_DAYS,
  pickAvailableProxy,
  profilesHoldingProxy,
  proxyOccupancyLabel,
} from "@/lib/claude-workflow";
import { DNS_BLOCKLIST_LEVELS } from "@/lib/dns-blocklist-levels";
import { cn } from "@/lib/utils";
import type {
  BrowserProfile,
  BrowserReleaseTypes,
  WayfernConfig,
} from "@/types";

import { RippleButton } from "./ui/ripple";

type BrowserTypeString = "wayfern";

interface CreateProfileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProfile: (profileData: {
    name: string;
    browserStr: BrowserTypeString;
    version: string;
    releaseType: string;
    proxyId?: string;
    vpnId?: string;
    wayfernConfig?: WayfernConfig;
    groupId?: string;
    extensionGroupId?: string;
    ephemeral?: boolean;
    dnsBlocklist?: string;
    launchHook?: string;
    password?: string;
    /** DON Claude isolation: applied after create via tags/note commands. */
    claudeTags?: string[];
    claudeNote?: string;
  }) => Promise<void>;
  selectedGroupId?: string;
  crossOsUnlocked?: boolean;
  /** Existing profiles — used to block shared residential proxies. */
  existingProfiles?: BrowserProfile[];
}

interface BrowserOption {
  value: BrowserTypeString;
  label: string;
}

const browserOptions: BrowserOption[] = [
  {
    value: "wayfern",
    label: "Wayfern",
  },
];

export function CreateProfileDialog({
  isOpen,
  onClose,
  onCreateProfile,
  selectedGroupId,
  crossOsUnlocked = false,
  existingProfiles = [],
}: CreateProfileDialogProps) {
  const { t } = useTranslation();
  const proxyListboxIdAntiDetect = useId();
  const proxyListboxIdRegular = useId();
  const [profileName, setProfileName] = useState("");
  // Only Wayfern profiles can be created, so the dialog opens straight into
  // the Wayfern config step (no browser-selection screen).
  const [currentStep, setCurrentStep] = useState<
    "browser-selection" | "browser-config"
  >("browser-config");
  const [activeTab, setActiveTab] = useState("anti-detect");

  // Browser selection states. Defaults to Wayfern — the only creatable browser.
  const [selectedBrowser, setSelectedBrowser] =
    useState<BrowserTypeString>("wayfern");
  const [selectedProxyId, setSelectedProxyId] = useState<string>();
  const [proxyPopoverOpen, setProxyPopoverOpen] = useState(false);
  const [dnsBlocklist, setDnsBlocklist] = useState<string>("");
  const [launchHook, setLaunchHook] = useState("");
  /** Claude isolation workflow (default ON for DON). */
  const [claudeMode, setClaudeMode] = useState(true);
  const [cardLabel, setCardLabel] = useState("");
  const [residentialLabel, setResidentialLabel] = useState("");
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  // Wayfern anti-detect states (DON Claude defaults)
  const [wayfernConfig, setWayfernConfig] = useState<WayfernConfig>(() =>
    getClaudeWayfernConfig(),
  );

  // Handle browser selection from the initial screen
  const handleBrowserSelect = (browser: BrowserTypeString) => {
    setSelectedBrowser(browser);
    setCurrentStep("browser-config");
  };

  // Reset the form fields without leaving the Wayfern config step.
  const resetForm = () => {
    setSelectedBrowser("wayfern");
    setProfileName("");
    setSelectedProxyId(undefined);
    setLaunchHook("");
    setCardLabel("");
    setResidentialLabel("");
    setClaudeMode(true);
    setWayfernConfig(getClaudeWayfernConfig());
    setWorkflowError(null);
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    resetForm();
  };

  const [supportedBrowsers, setSupportedBrowsers] = useState<string[]>([]);
  const { storedProxies } = useProxyEvents();
  const { vpnConfigs } = useVpnEvents();
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);
  const [enablePassword, setEnablePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const PASSWORD_MIN_LEN = 8;
  const [selectedExtensionGroupId, setSelectedExtensionGroupId] =
    useState<string>();
  const [extensionGroups, setExtensionGroups] = useState<
    { id: string; name: string; extension_ids: string[] }[]
  >([]);

  useEffect(() => {
    if (isOpen) {
      void invoke<{ id: string; name: string; extension_ids: string[] }[]>(
        "list_extension_groups",
      )
        .then(setExtensionGroups)
        .catch(() => {
          setExtensionGroups([]);
        });
    }
  }, [isOpen]);
  const [releaseTypes, setReleaseTypes] = useState<BrowserReleaseTypes>();
  const [isLoadingReleaseTypes, setIsLoadingReleaseTypes] = useState(false);
  const [releaseTypesError, setReleaseTypesError] = useState<string | null>(
    null,
  );
  const loadingBrowserRef = useRef<string | null>(null);

  // Use the browser download hook
  const {
    isBrowserDownloading,
    downloadBrowser,
    loadDownloadedVersions,
    isVersionDownloaded,
    downloadedVersionsMap,
  } = useBrowserDownload();

  const loadSupportedBrowsers = useCallback(async () => {
    try {
      const browsers = await invoke<string[]>("get_supported_browsers");
      setSupportedBrowsers(browsers);
    } catch (error) {
      console.error("Failed to load supported browsers:", error);
    }
  }, []);

  const checkAndDownloadGeoIPDatabase = useCallback(async () => {
    try {
      const isAvailable = await invoke<boolean>("is_geoip_database_available");
      if (!isAvailable) {
        console.log("GeoIP database not available, downloading...");
        await invoke("download_geoip_database");
        console.log("GeoIP database downloaded successfully");
      }
    } catch (error) {
      console.error("Failed to check/download GeoIP database:", error);
      // Don't show error to user as this is not critical for profile creation
    }
  }, []);

  const loadReleaseTypes = useCallback(
    async (browser: string) => {
      // Set loading state
      loadingBrowserRef.current = browser;
      setIsLoadingReleaseTypes(true);
      setReleaseTypesError(null);

      try {
        const rawReleaseTypes = await invoke<BrowserReleaseTypes>(
          "get_browser_release_types",
          { browserStr: browser },
        );

        await loadDownloadedVersions(browser);

        // Only update state if this browser is still the one we're loading
        if (loadingBrowserRef.current === browser) {
          const filtered: BrowserReleaseTypes = {};
          if (rawReleaseTypes.stable) filtered.stable = rawReleaseTypes.stable;
          setReleaseTypes(filtered);
          setReleaseTypesError(null);
        }
      } catch (error) {
        console.error(`Failed to load release types for ${browser}:`, error);

        // Fallback: still load downloaded versions and derive release type from them if possible
        try {
          const downloaded = await loadDownloadedVersions(browser);
          if (loadingBrowserRef.current === browser && downloaded.length > 0) {
            const latest = downloaded[0];
            const fallback: BrowserReleaseTypes = {};
            fallback.stable = latest;
            setReleaseTypes(fallback);
            setReleaseTypesError(null);
          } else if (loadingBrowserRef.current === browser) {
            // No downloaded versions and API failed - show error
            setReleaseTypesError(
              "Failed to fetch browser versions. Please check your internet connection and try again.",
            );
          }
        } catch (e) {
          console.error(
            `Failed to load downloaded versions for ${browser}:`,
            e,
          );
          if (loadingBrowserRef.current === browser) {
            setReleaseTypesError(
              "Failed to fetch browser versions. Please check your internet connection and try again.",
            );
          }
        }
      } finally {
        // Clear loading state only if we're still loading this browser
        if (loadingBrowserRef.current === browser) {
          loadingBrowserRef.current = null;
          setIsLoadingReleaseTypes(false);
        }
      }
    },
    [loadDownloadedVersions],
  );

  // Load data when dialog opens
  useEffect(() => {
    if (isOpen) {
      void loadSupportedBrowsers();
      // Load downloaded Wayfern versions up front so the availability gate is accurate.
      void loadDownloadedVersions("wayfern");
      // Load release types when a browser is selected
      if (selectedBrowser) {
        void loadReleaseTypes(selectedBrowser);
      }
      // Wayfern needs the GeoIP database for fingerprint generation.
      if (selectedBrowser === "wayfern") {
        void checkAndDownloadGeoIPDatabase();
      }
    }
  }, [
    isOpen,
    loadSupportedBrowsers,
    loadReleaseTypes,
    loadDownloadedVersions,
    checkAndDownloadGeoIPDatabase,
    selectedBrowser,
  ]);

  // Claude mode: once dialog opens, auto-pick free proxy + card label.
  // Start page (claude.com) is stamped into the note — not launch_hook
  // (launch_hook is an HTTP webhook, not a browser URL).
  useEffect(() => {
    if (!isOpen || !claudeMode) return;
    const free = pickAvailableProxy(storedProxies, existingProfiles);
    setSelectedProxyId((prev) => prev ?? free?.id);
    setCardLabel((prev) => prev.trim() || nextAutoCardLabel(existingProfiles));
    // Only re-seed when dialog opens or proxy list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional open seed
  }, [isOpen, claudeMode, storedProxies, existingProfiles]);

  // When proxy changes under Claude mode, stamp name + 家宽 label from the node.
  useEffect(() => {
    if (!claudeMode || !selectedProxyId || selectedProxyId.startsWith("vpn-")) {
      return;
    }
    const proxy = storedProxies.find((p) => p.id === selectedProxyId);
    if (!proxy) return;
    setResidentialLabel(buildResidentialLabel(proxy));
    setProfileName((prev) => {
      if (!prev.trim() || prev.startsWith("Claude-")) {
        return buildAutoProfileName(proxy, existingProfiles);
      }
      return prev;
    });
  }, [claudeMode, selectedProxyId, storedProxies, existingProfiles]);

  // Load release types when browser selection changes
  useEffect(() => {
    if (selectedBrowser) {
      // Cancel any previous loading
      loadingBrowserRef.current = null;
      // Clear previous release types immediately to prevent showing stale data
      setReleaseTypes({});
      void loadReleaseTypes(selectedBrowser);
    }
  }, [selectedBrowser, loadReleaseTypes]);

  // Helper function to get the best available version respecting rules
  const getBestAvailableVersion = useCallback(
    (_browserType?: string) => {
      if (!releaseTypes) return null;

      if (releaseTypes.stable) {
        return { version: releaseTypes.stable, releaseType: "stable" as const };
      }
      return null;
    },
    [releaseTypes],
  );

  const getCreatableVersion = useCallback(
    (browserType?: string) => {
      const bestVersion = getBestAvailableVersion(browserType);
      if (bestVersion && isVersionDownloaded(bestVersion.version)) {
        return bestVersion;
      }
      const browserDownloaded = downloadedVersionsMap[browserType ?? ""] ?? [];
      if (browserDownloaded.length > 0) {
        const fallbackVersion = browserDownloaded[0];
        return {
          version: fallbackVersion,
          releaseType: "stable" as const,
        };
      }
      return null;
    },
    [getBestAvailableVersion, isVersionDownloaded, downloadedVersionsMap],
  );

  const handleDownload = async (browserStr: string) => {
    const bestVersion = getBestAvailableVersion(browserStr);

    if (!bestVersion) {
      console.error("No version available for download");
      return;
    }

    try {
      await downloadBrowser(browserStr, bestVersion.version);
    } catch (error) {
      console.error("Failed to download browser:", error);
    }
  };

  const handleCreate = async () => {
    if (!profileName.trim()) return;

    if (enablePassword && !ephemeral) {
      if (password.length < PASSWORD_MIN_LEN) {
        setPasswordError(
          t("profilePassword.errors.tooShort", { min: PASSWORD_MIN_LEN }),
        );
        return;
      }
      if (password !== passwordConfirm) {
        setPasswordError(t("profilePassword.errors.mismatch"));
        return;
      }
    }
    setPasswordError(null);

    setIsCreating(true);

    const isVpnSelection = selectedProxyId?.startsWith("vpn-") ?? false;
    const resolvedProxyId = isVpnSelection ? undefined : selectedProxyId;
    const resolvedVpnId =
      isVpnSelection && selectedProxyId ? selectedProxyId.slice(4) : undefined;

    const passwordToSet =
      enablePassword && !ephemeral && password.length >= PASSWORD_MIN_LEN
        ? password
        : undefined;
    try {
      if (activeTab === "anti-detect") {
        // Only Wayfern anti-detect profiles are created.
        const bestWayfernVersion = getCreatableVersion("wayfern");
        if (!bestWayfernVersion) {
          console.error("No Wayfern version available");
          return;
        }

        const effectiveCard =
          cardLabel.trim() || nextAutoCardLabel(existingProfiles);
        if (claudeMode) {
          const blockers = claudeCreateBlockers({
            name: profileName,
            proxyId: resolvedProxyId,
            profiles: existingProfiles,
            cardLabel: effectiveCard,
          });
          if (blockers.length > 0) {
            setWorkflowError(blockers.join(" · "));
            setIsCreating(false);
            return;
          }
        }
        setWorkflowError(null);

        // Claude mode locks isolation-critical fields even if the form was tweaked.
        const finalWayfernConfig = claudeMode
          ? {
              ...wayfernConfig,
              ...getClaudeWayfernConfig(),
              // Keep user OS choice if they unlocked cross-OS and changed it.
              os: wayfernConfig.os ?? getClaudeWayfernConfig().os,
            }
          : { ...wayfernConfig };

        await onCreateProfile({
          name: profileName.trim(),
          browserStr: "wayfern" as BrowserTypeString,
          version: bestWayfernVersion.version,
          releaseType: bestWayfernVersion.releaseType,
          proxyId: resolvedProxyId,
          vpnId: resolvedVpnId,
          wayfernConfig: finalWayfernConfig,
          groupId:
            selectedGroupId && selectedGroupId !== "__all__"
              ? selectedGroupId
              : undefined,
          extensionGroupId: selectedExtensionGroupId,
          ephemeral,
          dnsBlocklist: dnsBlocklist || undefined,
          // launch_hook is an optional HTTP webhook — not the start page.
          launchHook: launchHook.trim() || undefined,
          password: passwordToSet,
          claudeTags: claudeMode ? buildClaudeTags() : undefined,
          claudeNote: claudeMode
            ? buildClaudeNote({
                cardLabel: effectiveCard,
                residentialLabel: (() => {
                  if (residentialLabel.trim()) return residentialLabel.trim();
                  const p = resolvedProxyId
                    ? storedProxies.find((x) => x.id === resolvedProxyId)
                    : undefined;
                  return p ? buildResidentialLabel(p) : undefined;
                })(),
                startUrl: CLAUDE_DEFAULT_START_URL,
              })
            : undefined,
        });
      } else {
        // Regular browser
        if (!selectedBrowser) {
          console.error("Missing required browser selection");
          return;
        }

        // Use the latest available Wayfern version
        const bestVersion = getCreatableVersion(selectedBrowser);
        if (!bestVersion) {
          console.error("No version available");
          return;
        }

        await onCreateProfile({
          name: profileName.trim(),
          browserStr: selectedBrowser,
          version: bestVersion.version,
          releaseType: bestVersion.releaseType,
          proxyId: selectedProxyId,
          groupId:
            selectedGroupId && selectedGroupId !== "__all__"
              ? selectedGroupId
              : undefined,
          dnsBlocklist: dnsBlocklist || undefined,
          launchHook: launchHook.trim() || undefined,
          password: passwordToSet,
        });
      }

      handleClose();
    } catch (error) {
      console.error("Failed to create profile:", error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    // Cancel any ongoing loading
    loadingBrowserRef.current = null;

    // Reset all states. Stay on the Wayfern config step.
    setProfileName("");
    setCurrentStep("browser-config");
    setActiveTab("anti-detect");
    setSelectedBrowser("wayfern");
    setSelectedProxyId(undefined);
    setLaunchHook("");
    setReleaseTypes({});
    setIsLoadingReleaseTypes(false);
    setReleaseTypesError(null);
    setWayfernConfig(getClaudeWayfernConfig());
    setClaudeMode(true);
    setCardLabel("");
    setResidentialLabel("");
    setWorkflowError(null);
    setEphemeral(false);
    setEnablePassword(false);
    setPassword("");
    setPasswordConfirm("");
    setPasswordError(null);
    onClose();
  };

  const updateWayfernConfig = (key: keyof WayfernConfig, value: unknown) => {
    setWayfernConfig((prev) => ({ ...prev, [key]: value }));
  };

  // Check if browser version is downloaded and available
  const isBrowserVersionAvailable = useCallback(
    (browserStr: string) => {
      const bestVersion = getBestAvailableVersion(browserStr);
      return bestVersion && isVersionDownloaded(bestVersion.version);
    },
    [isVersionDownloaded, getBestAvailableVersion],
  );

  // Check if browser is currently downloading
  const isBrowserCurrentlyDownloading = useCallback(
    (browserStr: string) => {
      return isBrowserDownloading(browserStr);
    },
    [isBrowserDownloading],
  );

  const isVpnSelection = selectedProxyId?.startsWith("vpn-") ?? false;
  const resolvedProxyIdForGate = isVpnSelection ? undefined : selectedProxyId;

  const isCreateDisabled = useMemo(() => {
    if (!profileName.trim()) return true;
    if (!selectedBrowser) return true;
    if (isBrowserCurrentlyDownloading(selectedBrowser)) return true;
    if (!getCreatableVersion(selectedBrowser)) return true;
    if (claudeMode) {
      if (
        claudeCreateBlockers({
          name: profileName,
          proxyId: resolvedProxyIdForGate,
          profiles: existingProfiles,
          cardLabel,
        }).length > 0
      ) {
        return true;
      }
    }
    return false;
  }, [
    profileName,
    selectedBrowser,
    isBrowserCurrentlyDownloading,
    getCreatableVersion,
    claudeMode,
    resolvedProxyIdForGate,
    existingProfiles,
    cardLabel,
  ]);

  const proxyOccupancy = useMemo(
    () => buildProxyOccupancy(existingProfiles),
    [existingProfiles],
  );

  const proxyShareWarning = useMemo(() => {
    if (!resolvedProxyIdForGate) return null;
    const holds = profilesHoldingProxy(
      resolvedProxyIdForGate,
      existingProfiles,
    );
    if (holds.length === 0) return null;
    return holds
      .map((h) => `${h.profile.name} (${h.daysRemaining}d left)`)
      .join(", ");
  }, [resolvedProxyIdForGate, existingProfiles]);

  // Filter supported browsers for regular browsers
  const regularBrowsers = browserOptions.filter((browser) =>
    supportedBrowsers.includes(browser.value),
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="flex max-h-[90vh] max-w-[min(48rem,calc(100%-4rem))] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {currentStep === "browser-selection"
              ? t("createProfile.title")
              : t("createProfile.configureTitle", {
                  browser: t("createProfile.chromiumLabel"),
                })}
          </DialogTitle>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex min-h-0 w-full flex-1 flex-col"
        >
          {/* Tab list hidden - only anti-detect browsers are supported */}

          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="flex w-full flex-col items-center justify-center">
              <div className="w-full space-y-6 py-4">
                {currentStep === "browser-selection" ? (
                  <>
                    <TabsContent value="anti-detect" className="mt-0 space-y-6">
                      {/* Anti-Detect Browser Selection */}
                      <div className="space-y-3 pt-8">
                        {/* Wayfern (Chromium) - First */}
                        <Button
                          onClick={() => {
                            handleBrowserSelect("wayfern");
                          }}
                          disabled={!getCreatableVersion("wayfern")}
                          className="flex h-16 w-full items-center justify-start gap-3 border-2 p-4 transition-colors hover:border-primary/50"
                          variant="outline"
                        >
                          <div className="flex size-8 items-center justify-center">
                            {isBrowserCurrentlyDownloading("wayfern") ? (
                              <LuLoaderCircle className="size-6 animate-spin" />
                            ) : (
                              (() => {
                                const IconComponent = getBrowserIcon("wayfern");
                                return IconComponent ? (
                                  <IconComponent className="size-6" />
                                ) : null;
                              })()
                            )}
                          </div>
                          <div className="text-left">
                            <div className="font-medium">
                              {t("createProfile.chromiumLabel")}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {isBrowserCurrentlyDownloading("wayfern")
                                ? t("createProfile.downloadingSubtitle")
                                : t("createProfile.chromiumSubtitle")}
                            </div>
                          </div>
                        </Button>

                        {!getCreatableVersion("wayfern") && (
                          <p className="pt-2 text-center text-sm text-muted-foreground">
                            {t("createProfile.browsersDownloading")}
                          </p>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="regular" className="mt-0 space-y-6">
                      {/* Regular Browser Selection */}
                      <div className="space-y-6">
                        <div className="text-center">
                          <h3 className="text-lg font-medium">
                            {t("createProfile.regular.title")}
                          </h3>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {t("createProfile.regular.description")}
                          </p>
                        </div>

                        <div className="space-y-3">
                          {regularBrowsers.map((browser) => {
                            const IconComponent = getBrowserIcon(browser.value);
                            return (
                              <Button
                                key={browser.value}
                                onClick={() => {
                                  handleBrowserSelect(browser.value);
                                }}
                                className="flex h-16 w-full items-center justify-start gap-3 border-2 p-4 transition-colors hover:border-primary/50"
                                variant="outline"
                              >
                                <div className="flex size-8 items-center justify-center">
                                  {IconComponent && (
                                    <IconComponent className="size-6" />
                                  )}
                                </div>
                                <div className="text-left">
                                  <div className="font-medium">
                                    {browser.label}
                                  </div>
                                  <div className="text-sm text-muted-foreground">
                                    {t("createProfile.regular.badge")}
                                  </div>
                                </div>
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    </TabsContent>
                  </>
                ) : (
                  <>
                    <TabsContent value="anti-detect" className="mt-0">
                      {/* Anti-Detect Configuration */}
                      <div className="space-y-6">
                        {/* Profile Name */}
                        <div className="space-y-2">
                          <Label htmlFor="profile-name">
                            {t("createProfile.profileName")}
                          </Label>
                          <Input
                            id="profile-name"
                            value={profileName}
                            onChange={(e) => {
                              setProfileName(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                !isCreateDisabled &&
                                !isCreating
                              ) {
                                void handleCreate();
                              }
                            }}
                            placeholder={t(
                              "createProfile.profileNamePlaceholder",
                            )}
                          />
                        </div>

                        {/* DON Claude isolation workflow */}
                        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                          <div className="flex items-center gap-x-2">
                            <Checkbox
                              id="claude-mode"
                              checked={claudeMode}
                              onCheckedChange={(checked) => {
                                const on = checked === true;
                                setClaudeMode(on);
                                setWorkflowError(null);
                                if (on) {
                                  setWayfernConfig(getClaudeWayfernConfig());
                                  setEphemeral(false);
                                }
                              }}
                            />
                            <Label
                              htmlFor="claude-mode"
                              className="font-medium"
                            >
                              {t("claudeWorkflow.createToggle", {
                                defaultValue:
                                  "Claude isolation (1 家宽 IP · 1 timezone · 1 card)",
                              })}
                            </Label>
                          </div>
                          <p className="ml-6 text-sm text-muted-foreground">
                            {t("claudeWorkflow.createHint", {
                              defaultValue: `Auto-fills free 家宽 node, card label, name. Node lease ${PROXY_REUSE_COOLDOWN_DAYS} days then reusable. Start page ${CLAUDE_DEFAULT_START_URL}. Geoip + WebRTC off + fixed FP + host DPR.`,
                            })}
                          </p>
                          {claudeMode && (
                            <div className="ml-6 space-y-3">
                              <div className="space-y-1.5">
                                <Label htmlFor="residential-label">
                                  {t("claudeWorkflow.residentialLabel", {
                                    defaultValue: "家宽 / residential label",
                                  })}
                                </Label>
                                <Input
                                  id="residential-label"
                                  value={residentialLabel}
                                  onChange={(e) => {
                                    setResidentialLabel(e.target.value);
                                  }}
                                  placeholder="e.g. 家宽-上海-线路A"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="card-label">
                                  {t("claudeWorkflow.cardLabel", {
                                    defaultValue: "Card label (unique)",
                                  })}
                                </Label>
                                <Input
                                  id="card-label"
                                  value={cardLabel}
                                  onChange={(e) => {
                                    setCardLabel(e.target.value);
                                    setWorkflowError(null);
                                  }}
                                  placeholder="e.g. card-A (never paste full card number)"
                                />
                              </div>
                              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                                <li>
                                  Free node auto-selected (no active{" "}
                                  {PROXY_REUSE_COOLDOWN_DAYS}-day lease)
                                </li>
                                <li>
                                  Same node reusable only after{" "}
                                  {PROXY_REUSE_COOLDOWN_DAYS} days
                                </li>
                                <li>
                                  Start page defaults to{" "}
                                  {CLAUDE_DEFAULT_START_URL}
                                </li>
                                <li>
                                  Timezone/language stamped from proxy exit
                                  (geoip on)
                                </li>
                                <li>
                                  Host DPR locked — safer Claude/Stripe payment
                                  UI
                                </li>
                              </ul>
                              {proxyShareWarning && (
                                <p className="text-sm text-destructive-text">
                                  Node still leased by: {proxyShareWarning}
                                </p>
                              )}
                              {workflowError && (
                                <p className="text-sm text-destructive-text">
                                  {workflowError}
                                </p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Ephemeral Option */}
                        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                          <div className="flex items-center gap-x-2">
                            <Checkbox
                              id="ephemeral"
                              checked={ephemeral}
                              disabled={claudeMode}
                              onCheckedChange={(checked) => {
                                setEphemeral(checked === true);
                              }}
                            />
                            <Label htmlFor="ephemeral" className="font-medium">
                              {t("profiles.ephemeral")}
                            </Label>
                          </div>
                          <p className="ml-6 text-sm text-muted-foreground">
                            {claudeMode
                              ? t("claudeWorkflow.ephemeralDisabled", {
                                  defaultValue:
                                    "Disabled in Claude isolation — profiles must persist cookies/login.",
                                })
                              : t("profiles.ephemeralDescription")}
                          </p>
                        </div>

                        {/* Password Option */}
                        {!ephemeral && (
                          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                            <div className="flex items-center gap-x-2">
                              <Checkbox
                                id="enable-password"
                                checked={enablePassword}
                                onCheckedChange={(checked) => {
                                  setEnablePassword(checked === true);
                                  if (checked !== true) {
                                    setPassword("");
                                    setPasswordConfirm("");
                                    setPasswordError(null);
                                  }
                                }}
                              />
                              <Label
                                htmlFor="enable-password"
                                className="font-medium"
                              >
                                {t("createProfile.passwordProtect.label")}
                              </Label>
                            </div>
                            <p className="ml-6 text-sm text-muted-foreground">
                              {t("createProfile.passwordProtect.description")}
                            </p>
                            {enablePassword && (
                              <div className="ml-6 space-y-2">
                                <Input
                                  type="password"
                                  value={password}
                                  onChange={(e) => {
                                    setPassword(e.target.value);
                                    setPasswordError(null);
                                  }}
                                  placeholder={t(
                                    "profilePassword.fields.newPassword",
                                  )}
                                  autoComplete="new-password"
                                />
                                <Input
                                  type="password"
                                  value={passwordConfirm}
                                  onChange={(e) => {
                                    setPasswordConfirm(e.target.value);
                                    setPasswordError(null);
                                  }}
                                  placeholder={t(
                                    "profilePassword.fields.confirm",
                                  )}
                                  autoComplete="new-password"
                                />
                                {passwordError && (
                                  <p className="text-sm text-destructive-text">
                                    {passwordError}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {selectedBrowser === "wayfern" ? (
                          // Wayfern Configuration
                          <div className="space-y-6">
                            {/* Wayfern Download Status */}
                            {isLoadingReleaseTypes && (
                              <div className="flex items-center gap-3 rounded-md border p-3">
                                <div className="size-4 animate-spin rounded-full border-2 border-muted/40 border-t-primary" />
                                <p className="text-sm text-muted-foreground">
                                  {t("createProfile.version.fetching")}
                                </p>
                              </div>
                            )}
                            {!isLoadingReleaseTypes && releaseTypesError && (
                              <div className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                                <p className="flex-1 text-sm text-destructive-text">
                                  {releaseTypesError}
                                </p>
                                <RippleButton
                                  onClick={() =>
                                    selectedBrowser &&
                                    loadReleaseTypes(selectedBrowser)
                                  }
                                  size="sm"
                                  variant="outline"
                                >
                                  {t("common.buttons.retry")}
                                </RippleButton>
                              </div>
                            )}
                            {!isLoadingReleaseTypes &&
                              !releaseTypesError &&
                              !getBestAvailableVersion("wayfern") && (
                                <div className="flex items-center gap-3 rounded-md border border-warning/50 bg-warning/10 p-3">
                                  <p className="text-sm text-warning-text">
                                    {t("createProfile.platformUnavailable", {
                                      browser: "Wayfern",
                                    })}
                                  </p>
                                </div>
                              )}
                            {!isLoadingReleaseTypes &&
                              !releaseTypesError &&
                              !isBrowserCurrentlyDownloading("wayfern") &&
                              !getCreatableVersion("wayfern") &&
                              getBestAvailableVersion("wayfern") && (
                                <div className="flex items-center gap-3 rounded-md border p-3">
                                  <p className="text-sm text-muted-foreground">
                                    {t("createProfile.version.needsDownload", {
                                      browser: "Wayfern",
                                      version:
                                        getBestAvailableVersion("wayfern")
                                          ?.version,
                                    })}
                                  </p>
                                  <LoadingButton
                                    onClick={() => {
                                      void handleDownload("wayfern");
                                    }}
                                    isLoading={isBrowserCurrentlyDownloading(
                                      "wayfern",
                                    )}
                                    size="sm"
                                    disabled={isBrowserCurrentlyDownloading(
                                      "wayfern",
                                    )}
                                  >
                                    {isBrowserCurrentlyDownloading("wayfern")
                                      ? t("common.buttons.downloading")
                                      : t("common.buttons.download")}
                                  </LoadingButton>
                                </div>
                              )}
                            {!isLoadingReleaseTypes &&
                              !releaseTypesError &&
                              !isBrowserCurrentlyDownloading("wayfern") &&
                              getCreatableVersion("wayfern") && (
                                <div className="rounded-md border p-3 text-sm text-muted-foreground">
                                  ✓{" "}
                                  {t("createProfile.version.available", {
                                    browser: "Wayfern",
                                    version:
                                      getCreatableVersion("wayfern")?.version,
                                  })}
                                </div>
                              )}
                            {!isLoadingReleaseTypes &&
                              !releaseTypesError &&
                              !isBrowserCurrentlyDownloading("wayfern") &&
                              getCreatableVersion("wayfern") &&
                              !isBrowserVersionAvailable("wayfern") &&
                              getBestAvailableVersion("wayfern") && (
                                <div className="flex items-center gap-3 rounded-md border p-3">
                                  <p className="flex-1 text-sm text-muted-foreground">
                                    {t(
                                      "createProfile.version.upgradeAvailable",
                                      {
                                        browser: "Wayfern",
                                        version:
                                          getBestAvailableVersion("wayfern")
                                            ?.version,
                                      },
                                    )}
                                  </p>
                                  <LoadingButton
                                    onClick={() => {
                                      void handleDownload("wayfern");
                                    }}
                                    isLoading={isBrowserCurrentlyDownloading(
                                      "wayfern",
                                    )}
                                    size="sm"
                                    variant="outline"
                                    disabled={isBrowserCurrentlyDownloading(
                                      "wayfern",
                                    )}
                                  >
                                    {isBrowserCurrentlyDownloading("wayfern")
                                      ? t("common.buttons.downloading")
                                      : t("common.buttons.download")}
                                  </LoadingButton>
                                </div>
                              )}
                            {isBrowserCurrentlyDownloading("wayfern") && (
                              <div className="rounded-md border p-3 text-sm text-muted-foreground">
                                {t("createProfile.version.downloading", {
                                  browser: "Wayfern",
                                  version:
                                    getBestAvailableVersion("wayfern")?.version,
                                })}
                              </div>
                            )}

                            <WayfernConfigForm
                              config={wayfernConfig}
                              onConfigChange={updateWayfernConfig}
                              isCreating
                              crossOsUnlocked={crossOsUnlocked}
                              limitedMode={!crossOsUnlocked}
                              profileVersion={
                                getCreatableVersion("wayfern")?.version
                              }
                              profileBrowser="wayfern"
                            />
                          </div>
                        ) : (
                          // Regular Browser Configuration (should not happen in the anti-detect tab).
                          <div className="space-y-4">
                            {selectedBrowser && (
                              <div className="space-y-3">
                                {isLoadingReleaseTypes && (
                                  <div className="flex items-center gap-3">
                                    <div className="size-4 animate-spin rounded-full border-2 border-muted/40 border-t-primary" />
                                    <p className="text-sm text-muted-foreground">
                                      {t("createProfile.version.fetching")}
                                    </p>
                                  </div>
                                )}
                                {!isLoadingReleaseTypes &&
                                  releaseTypesError && (
                                    <div className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                                      <p className="flex-1 text-sm text-destructive-text">
                                        {releaseTypesError}
                                      </p>
                                      <RippleButton
                                        onClick={() =>
                                          selectedBrowser &&
                                          loadReleaseTypes(selectedBrowser)
                                        }
                                        size="sm"
                                        variant="outline"
                                      >
                                        {t("common.buttons.retry")}
                                      </RippleButton>
                                    </div>
                                  )}
                                {!isLoadingReleaseTypes &&
                                  !releaseTypesError &&
                                  !isBrowserCurrentlyDownloading(
                                    selectedBrowser,
                                  ) &&
                                  !getCreatableVersion(selectedBrowser) &&
                                  getBestAvailableVersion(selectedBrowser) && (
                                    <div className="flex items-center gap-3">
                                      <p className="text-sm text-muted-foreground">
                                        {t(
                                          "createProfile.version.latestNeedsDownload",
                                          {
                                            version:
                                              getBestAvailableVersion(
                                                selectedBrowser,
                                              )?.version,
                                          },
                                        )}
                                      </p>
                                      <LoadingButton
                                        onClick={() => {
                                          void handleDownload(selectedBrowser);
                                        }}
                                        isLoading={isBrowserCurrentlyDownloading(
                                          selectedBrowser,
                                        )}
                                        className="ml-auto"
                                        size="sm"
                                        disabled={isBrowserCurrentlyDownloading(
                                          selectedBrowser,
                                        )}
                                      >
                                        {t("common.buttons.download")}
                                      </LoadingButton>
                                    </div>
                                  )}
                                {!isLoadingReleaseTypes &&
                                  !releaseTypesError &&
                                  !isBrowserCurrentlyDownloading(
                                    selectedBrowser,
                                  ) &&
                                  getCreatableVersion(selectedBrowser) && (
                                    <div className="text-sm text-muted-foreground">
                                      ✓{" "}
                                      {t(
                                        "createProfile.version.latestAvailable",
                                        {
                                          version:
                                            getCreatableVersion(selectedBrowser)
                                              ?.version,
                                        },
                                      )}
                                    </div>
                                  )}
                                {isBrowserCurrentlyDownloading(
                                  selectedBrowser,
                                ) && (
                                  <div className="text-sm text-muted-foreground">
                                    {t(
                                      "createProfile.version.latestDownloading",
                                      {
                                        version:
                                          getBestAvailableVersion(
                                            selectedBrowser,
                                          )?.version,
                                      },
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Proxy / VPN Selection - Always visible */}
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Label>{t("createProfile.proxy.title")}</Label>
                            <RippleButton
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setShowProxyForm(true);
                              }}
                              className="h-7 px-2 text-xs"
                            >
                              <GoPlus className="mr-1 size-3" />{" "}
                              {t("createProfile.proxy.addProxy")}
                            </RippleButton>
                          </div>
                          {storedProxies.length > 0 || vpnConfigs.length > 0 ? (
                            <Popover
                              open={proxyPopoverOpen}
                              onOpenChange={setProxyPopoverOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  aria-expanded={proxyPopoverOpen}
                                  aria-controls={proxyListboxIdAntiDetect}
                                  className="w-full justify-between font-normal"
                                >
                                  {(() => {
                                    if (!selectedProxyId)
                                      return t("createProfile.proxy.noProxy");
                                    if (selectedProxyId.startsWith("vpn-")) {
                                      const vpn = vpnConfigs.find(
                                        (v) =>
                                          v.id === selectedProxyId.slice(4),
                                      );
                                      return vpn
                                        ? `WG — ${vpn.name}`
                                        : t("createProfile.proxy.noProxy");
                                    }
                                    const proxy = storedProxies.find(
                                      (p) => p.id === selectedProxyId,
                                    );
                                    return (
                                      proxy?.name ??
                                      t("createProfile.proxy.noProxy")
                                    );
                                  })()}
                                  <LuChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                id={proxyListboxIdAntiDetect}
                                className="w-[240px] p-0"
                                sideOffset={8}
                              >
                                <Command>
                                  <CommandInput
                                    placeholder={t(
                                      "createProfile.proxy.search",
                                    )}
                                  />
                                  <CommandList>
                                    <CommandEmpty>
                                      {t("createProfile.proxy.notFound")}
                                    </CommandEmpty>
                                    <CommandGroup>
                                      <CommandItem
                                        value="__none__"
                                        onSelect={() => {
                                          setSelectedProxyId(undefined);
                                          setProxyPopoverOpen(false);
                                        }}
                                      >
                                        <LuCheck
                                          className={cn(
                                            "mr-2 size-4",
                                            !selectedProxyId
                                              ? "opacity-100"
                                              : "opacity-0",
                                          )}
                                        />
                                        {t("common.labels.none")}
                                      </CommandItem>
                                      {storedProxies.map((proxy) => {
                                        const occ = proxyOccupancyLabel(
                                          proxy.id,
                                          proxyOccupancy,
                                        );
                                        const taken = Boolean(occ);
                                        return (
                                          <CommandItem
                                            key={proxy.id}
                                            value={proxy.name}
                                            disabled={claudeMode && taken}
                                            onSelect={() => {
                                              if (claudeMode && taken) return;
                                              setSelectedProxyId(proxy.id);
                                              setProxyPopoverOpen(false);
                                              setWorkflowError(null);
                                            }}
                                          >
                                            <LuCheck
                                              className={cn(
                                                "mr-2 size-4",
                                                selectedProxyId === proxy.id
                                                  ? "opacity-100"
                                                  : "opacity-0",
                                              )}
                                            />
                                            <span className="flex min-w-0 flex-1 flex-col">
                                              <span className="truncate">
                                                {proxy.name}
                                              </span>
                                              {occ ? (
                                                <span className="truncate text-xs text-destructive-text">
                                                  {occ}
                                                </span>
                                              ) : null}
                                            </span>
                                          </CommandItem>
                                        );
                                      })}
                                    </CommandGroup>
                                    {vpnConfigs.length > 0 && (
                                      <CommandGroup heading="VPNs">
                                        {vpnConfigs.map((vpn) => (
                                          <CommandItem
                                            key={vpn.id}
                                            value={`vpn-${vpn.name}`}
                                            onSelect={() => {
                                              setSelectedProxyId(
                                                `vpn-${vpn.id}`,
                                              );
                                              setProxyPopoverOpen(false);
                                            }}
                                          >
                                            <LuCheck
                                              className={cn(
                                                "mr-2 size-4",
                                                selectedProxyId ===
                                                  `vpn-${vpn.id}`
                                                  ? "opacity-100"
                                                  : "opacity-0",
                                              )}
                                            />
                                            <Badge
                                              variant="outline"
                                              className="mr-1 px-1 py-0 text-[10px] leading-tight"
                                            >
                                              WG
                                            </Badge>
                                            {vpn.name}
                                          </CommandItem>
                                        ))}
                                      </CommandGroup>
                                    )}
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          ) : (
                            <div className="flex items-center gap-3 rounded-md border p-3 text-sm text-muted-foreground">
                              {t("createProfile.proxy.noProxiesAvailable")}
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="launch-hook-url">
                            {t("createProfile.launchHook.label")}
                          </Label>
                          <Input
                            id="launch-hook-url"
                            value={launchHook}
                            onChange={(e) => {
                              setLaunchHook(e.target.value);
                            }}
                            placeholder={t(
                              "createProfile.launchHook.placeholder",
                            )}
                            disabled={isCreating}
                          />
                        </div>

                        {/* DNS Blocklist */}
                        <div className="space-y-2">
                          <Label>{t("dnsBlocklist.title")}</Label>
                          <Select
                            value={dnsBlocklist || "none"}
                            onValueChange={(val) => {
                              setDnsBlocklist(val === "none" ? "" : val);
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={t("dnsBlocklist.none")}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">
                                {t("dnsBlocklist.none")}
                              </SelectItem>
                              {DNS_BLOCKLIST_LEVELS.map((level) => (
                                <SelectItem
                                  key={level.value}
                                  value={level.value}
                                >
                                  {t(level.labelKey)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Extension Group */}
                        {extensionGroups.length > 0 && (
                          <div className="space-y-2">
                            <Label>{t("extensions.extensionGroup")}</Label>
                            <Select
                              value={selectedExtensionGroupId ?? "none"}
                              onValueChange={(val) => {
                                setSelectedExtensionGroupId(
                                  val === "none" ? undefined : val,
                                );
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t("profileInfo.values.none")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">
                                  {t("profileInfo.values.none")}
                                </SelectItem>
                                {extensionGroups.map((g) => (
                                  <SelectItem key={g.id} value={g.id}>
                                    {g.name} ({g.extension_ids.length})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="regular" className="mt-0">
                      {/* Regular Browser Configuration */}
                      <div className="space-y-6">
                        {/* Profile Name */}
                        <div className="space-y-2">
                          <Label htmlFor="profile-name">
                            {t("createProfile.profileName")}
                          </Label>
                          <Input
                            id="profile-name"
                            value={profileName}
                            onChange={(e) => {
                              setProfileName(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                !isCreateDisabled &&
                                !isCreating
                              ) {
                                void handleCreate();
                              }
                            }}
                            placeholder={t(
                              "createProfile.profileNamePlaceholder",
                            )}
                          />
                        </div>

                        {/* Regular Browser Configuration */}
                        <div className="space-y-4">
                          {selectedBrowser && (
                            <div className="space-y-3">
                              {isLoadingReleaseTypes && (
                                <div className="flex items-center gap-3">
                                  <div className="size-4 animate-spin rounded-full border-2 border-muted/40 border-t-primary" />
                                  <p className="text-sm text-muted-foreground">
                                    {t("createProfile.version.fetching")}
                                  </p>
                                </div>
                              )}
                              {!isLoadingReleaseTypes && releaseTypesError && (
                                <div className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                                  <p className="flex-1 text-sm text-destructive-text">
                                    {releaseTypesError}
                                  </p>
                                  <RippleButton
                                    onClick={() =>
                                      selectedBrowser &&
                                      loadReleaseTypes(selectedBrowser)
                                    }
                                    size="sm"
                                    variant="outline"
                                  >
                                    {t("common.buttons.retry")}
                                  </RippleButton>
                                </div>
                              )}
                              {!isLoadingReleaseTypes &&
                                !releaseTypesError &&
                                !isBrowserCurrentlyDownloading(
                                  selectedBrowser,
                                ) &&
                                !getCreatableVersion(selectedBrowser) &&
                                getBestAvailableVersion(selectedBrowser) && (
                                  <div className="flex items-center gap-3">
                                    <p className="text-sm text-muted-foreground">
                                      {t(
                                        "createProfile.version.latestNeedsDownload",
                                        {
                                          version:
                                            getBestAvailableVersion(
                                              selectedBrowser,
                                            )?.version,
                                        },
                                      )}
                                    </p>
                                    <LoadingButton
                                      onClick={() => {
                                        void handleDownload(selectedBrowser);
                                      }}
                                      isLoading={isBrowserCurrentlyDownloading(
                                        selectedBrowser,
                                      )}
                                      className="ml-auto"
                                      size="sm"
                                      disabled={isBrowserCurrentlyDownloading(
                                        selectedBrowser,
                                      )}
                                    >
                                      {t("common.buttons.download")}
                                    </LoadingButton>
                                  </div>
                                )}
                              {!isLoadingReleaseTypes &&
                                !releaseTypesError &&
                                !isBrowserCurrentlyDownloading(
                                  selectedBrowser,
                                ) &&
                                getCreatableVersion(selectedBrowser) && (
                                  <div className="text-sm text-muted-foreground">
                                    ✓{" "}
                                    {t(
                                      "createProfile.version.latestAvailable",
                                      {
                                        version:
                                          getCreatableVersion(selectedBrowser)
                                            ?.version,
                                      },
                                    )}
                                  </div>
                                )}
                              {isBrowserCurrentlyDownloading(
                                selectedBrowser,
                              ) && (
                                <div className="text-sm text-muted-foreground">
                                  {t(
                                    "createProfile.version.latestDownloading",
                                    {
                                      version:
                                        getBestAvailableVersion(selectedBrowser)
                                          ?.version,
                                    },
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Proxy / VPN Selection - Always visible */}
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Label>{t("createProfile.proxy.title")}</Label>
                            <RippleButton
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setShowProxyForm(true);
                              }}
                              className="h-7 px-2 text-xs"
                            >
                              <GoPlus className="mr-1 size-3" />{" "}
                              {t("createProfile.proxy.addProxy")}
                            </RippleButton>
                          </div>
                          {storedProxies.length > 0 || vpnConfigs.length > 0 ? (
                            <Popover
                              open={proxyPopoverOpen}
                              onOpenChange={setProxyPopoverOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  aria-expanded={proxyPopoverOpen}
                                  aria-controls={proxyListboxIdRegular}
                                  className="w-full justify-between font-normal"
                                >
                                  {(() => {
                                    if (!selectedProxyId)
                                      return t("createProfile.proxy.noProxy");
                                    if (selectedProxyId.startsWith("vpn-")) {
                                      const vpn = vpnConfigs.find(
                                        (v) =>
                                          v.id === selectedProxyId.slice(4),
                                      );
                                      return vpn
                                        ? `WG — ${vpn.name}`
                                        : t("createProfile.proxy.noProxy");
                                    }
                                    const proxy = storedProxies.find(
                                      (p) => p.id === selectedProxyId,
                                    );
                                    return (
                                      proxy?.name ??
                                      t("createProfile.proxy.noProxy")
                                    );
                                  })()}
                                  <LuChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                id={proxyListboxIdRegular}
                                className="w-[240px] p-0"
                                sideOffset={8}
                              >
                                <Command>
                                  <CommandInput
                                    placeholder={t(
                                      "createProfile.proxy.search",
                                    )}
                                  />
                                  <CommandList>
                                    <CommandEmpty>
                                      {t("createProfile.proxy.notFound")}
                                    </CommandEmpty>
                                    <CommandGroup>
                                      <CommandItem
                                        value="__none__"
                                        onSelect={() => {
                                          setSelectedProxyId(undefined);
                                          setProxyPopoverOpen(false);
                                        }}
                                      >
                                        <LuCheck
                                          className={cn(
                                            "mr-2 size-4",
                                            !selectedProxyId
                                              ? "opacity-100"
                                              : "opacity-0",
                                          )}
                                        />
                                        {t("common.labels.none")}
                                      </CommandItem>
                                      {storedProxies.map((proxy) => {
                                        const occ = proxyOccupancyLabel(
                                          proxy.id,
                                          proxyOccupancy,
                                        );
                                        const taken = Boolean(occ);
                                        return (
                                          <CommandItem
                                            key={proxy.id}
                                            value={proxy.name}
                                            disabled={claudeMode && taken}
                                            onSelect={() => {
                                              if (claudeMode && taken) return;
                                              setSelectedProxyId(proxy.id);
                                              setProxyPopoverOpen(false);
                                              setWorkflowError(null);
                                            }}
                                          >
                                            <LuCheck
                                              className={cn(
                                                "mr-2 size-4",
                                                selectedProxyId === proxy.id
                                                  ? "opacity-100"
                                                  : "opacity-0",
                                              )}
                                            />
                                            <span className="flex min-w-0 flex-1 flex-col">
                                              <span className="truncate">
                                                {proxy.name}
                                              </span>
                                              {occ ? (
                                                <span className="truncate text-xs text-destructive-text">
                                                  {occ}
                                                </span>
                                              ) : null}
                                            </span>
                                          </CommandItem>
                                        );
                                      })}
                                    </CommandGroup>
                                    {vpnConfigs.length > 0 && (
                                      <CommandGroup heading="VPNs">
                                        {vpnConfigs.map((vpn) => (
                                          <CommandItem
                                            key={vpn.id}
                                            value={`vpn-${vpn.name}`}
                                            onSelect={() => {
                                              setSelectedProxyId(
                                                `vpn-${vpn.id}`,
                                              );
                                              setProxyPopoverOpen(false);
                                            }}
                                          >
                                            <LuCheck
                                              className={cn(
                                                "mr-2 size-4",
                                                selectedProxyId ===
                                                  `vpn-${vpn.id}`
                                                  ? "opacity-100"
                                                  : "opacity-0",
                                              )}
                                            />
                                            <Badge
                                              variant="outline"
                                              className="mr-1 px-1 py-0 text-[10px] leading-tight"
                                            >
                                              WG
                                            </Badge>
                                            {vpn.name}
                                          </CommandItem>
                                        ))}
                                      </CommandGroup>
                                    )}
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          ) : (
                            <div className="flex items-center gap-3 rounded-md border p-3 text-sm text-muted-foreground">
                              {t("createProfile.proxy.noProxiesAvailable")}
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="launch-hook-url-regular">
                            {t("createProfile.launchHook.label")}
                          </Label>
                          <Input
                            id="launch-hook-url-regular"
                            value={launchHook}
                            onChange={(e) => {
                              setLaunchHook(e.target.value);
                            }}
                            placeholder={t(
                              "createProfile.launchHook.placeholder",
                            )}
                            disabled={isCreating}
                          />
                        </div>
                      </div>
                    </TabsContent>
                  </>
                )}
              </div>
            </div>
          </ScrollArea>
        </Tabs>

        <DialogFooter className="shrink-0 border-t pt-4">
          {currentStep === "browser-config" ? (
            <>
              <RippleButton variant="outline" onClick={handleClose}>
                {t("common.buttons.close")}
              </RippleButton>
              <LoadingButton
                onClick={handleCreate}
                isLoading={isCreating}
                disabled={isCreateDisabled}
              >
                {t("common.buttons.create")}
              </LoadingButton>
            </>
          ) : (
            <RippleButton variant="outline" onClick={handleClose}>
              {t("common.buttons.cancel")}
            </RippleButton>
          )}
        </DialogFooter>
      </DialogContent>
      <ProxyFormDialog
        isOpen={showProxyForm}
        onClose={() => {
          setShowProxyForm(false);
        }}
      />
    </Dialog>
  );
}
