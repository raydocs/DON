import {
  getCurrentOS,
  getDefaultWayfernConfig,
  resolveWayfernWebRtcMode,
} from "@/lib/wayfern-defaults";
import type { BrowserProfile, StoredProxy, WayfernConfig } from "@/types";

/** Hard isolation model for Claude accounts on DON. */
export const CLAUDE_ISOLATION_RULES = [
  "1 profile = 1 Claude account",
  "每个档案配置家宽路由；重复使用仅提示，不限制等待时间",
  "1 profile = 1 timezone matching that IP",
  "1 profile = 1 payment card (do not share cards across profiles)",
  "Fingerprint stays fixed (never randomize on launch)",
  "devicePixelRatio must match this host (payment iframe safety)",
  "Default start page: https://claude.com",
] as const;

/** Default page opened when launching a Claude isolation profile. */
export const CLAUDE_DEFAULT_START_URL = "https://claude.com";

export type HealthSeverity = "ok" | "warn" | "block";

export interface HealthIssue {
  code: string;
  severity: HealthSeverity;
  message: string;
}

export interface ProfileHealth {
  profileId: string;
  profileName: string;
  score: HealthSeverity;
  issues: HealthIssue[];
}

export interface ClaudeCreateFields {
  /** Optional payment-card label stored in profile note (not the card number). */
  cardLabel?: string;
  /** Optional home-broadband label, e.g. "家宽-上海-01". */
  residentialLabel?: string;
  /** Start URL stamped into the note (launch default). */
  startUrl?: string;
}

export interface AutoClaudeProfilePlan {
  name: string;
  proxyId: string;
  proxyName: string;
  cardLabel: string;
  residentialLabel: string;
  startUrl: string;
  note: string;
  tags: string[];
  wayfernConfig: WayfernConfig;
}

/** Wayfern config for Claude: geo follows proxy, WebRTC is proxy-safe, stable FP. */
export function getClaudeWayfernConfig(): WayfernConfig {
  return {
    ...getDefaultWayfernConfig(),
    // Align timezone/language/geo with the proxy exit (Based-on-proxy style).
    geoip: true,
    // Prefer not leaking real local IP through WebRTC.
    webrtc_mode: "proxy",
    randomize_fingerprint_on_launch: false,
  };
}

export function buildClaudeNote(fields: ClaudeCreateFields): string {
  const startUrl = (fields.startUrl ?? CLAUDE_DEFAULT_START_URL).trim();
  const lines = [
    "DON Claude isolation profile",
    fields.residentialLabel
      ? `residential: ${fields.residentialLabel.trim()}`
      : "residential: (set 家宽 label)",
    fields.cardLabel
      ? `card: ${fields.cardLabel.trim()}`
      : "card: (set unique card label — never share cards)",
    `start_url: ${startUrl}`,
  ];
  return lines.join("\n");
}

export function buildClaudeTags(): string[] {
  return ["claude", "residential", "don-isolation"];
}

export interface ResidentialObservation {
  profile_id: string;
  proxy_id: string | null;
  ip: string | null;
  observed_at: number | null;
  fresh: boolean;
}

export interface ResidentialUsageGroup {
  key: string | null;
  profiles: BrowserProfile[];
  count: number;
  /** Latest valid current-route observation in this group, in Unix seconds. */
  lastObservedAt: number | null;
}

export interface ResidentialUsage {
  byLabel: ResidentialUsageGroup[];
  byIp: ResidentialUsageGroup[];
  unknownLabel: ResidentialUsageGroup;
  unknownIp: ResidentialUsageGroup;
  expiredIp: ResidentialUsageGroup;
  duplicateLabelProfiles: BrowserProfile[];
  duplicateIpProfiles: BrowserProfile[];
}

/** Current route-cache snapshot only; never an account identity or reuse gate. */
export function buildResidentialUsage(
  profiles: BrowserProfile[],
  observations: ResidentialObservation[],
  nowSecs: number,
): ResidentialUsage {
  const latest = new Map<string, ResidentialObservation>();
  for (const observation of observations) {
    const previous = latest.get(observation.profile_id);
    if (
      !previous ||
      (observation.observed_at ?? -Infinity) >=
        (previous.observed_at ?? -Infinity)
    ) {
      latest.set(observation.profile_id, observation);
    }
  }
  const labels = new Map<string, ResidentialUsageGroup>();
  const ips = new Map<string, ResidentialUsageGroup>();
  const group = (key: string | null): ResidentialUsageGroup => ({
    key,
    profiles: [],
    count: 0,
    lastObservedAt: null,
  });
  const unknownLabel = group(null);
  const unknownIp = group(null);
  const expiredIp = group(null);
  const add = (
    target: ResidentialUsageGroup,
    profile: BrowserProfile,
    observedAt: number | null,
  ) => {
    target.profiles.push(profile);
    target.count += 1;
    if (observedAt !== null) {
      target.lastObservedAt = Math.max(
        target.lastObservedAt ?? observedAt,
        observedAt,
      );
    }
  };
  const getGroup = (map: Map<string, ResidentialUsageGroup>, key: string) => {
    const target = map.get(key) ?? group(key);
    map.set(key, target);
    return target;
  };
  for (const profile of profiles) {
    const observation = latest.get(profile.id);
    const time = observation?.observed_at;
    const ip = observation?.ip?.trim();
    const known =
      !!ip &&
      observation?.proxy_id === (profile.proxy_id ?? null) &&
      time != null &&
      Number.isFinite(time) &&
      time > 0 &&
      time <= nowSecs;
    const valid =
      known && observation?.fresh === true && nowSecs - time < 30 * 60;
    const observedAt = known ? time : null;
    const label = profile.note
      ?.match(/^\s*residential\s*:[ \t]*([^\r\n]*)/im)?.[1]
      ?.trim();
    add(
      label && label !== "(set 家宽 label)"
        ? getGroup(labels, label)
        : unknownLabel,
      profile,
      observedAt,
    );
    add(
      valid && ip ? getGroup(ips, ip) : known ? expiredIp : unknownIp,
      profile,
      observedAt,
    );
  }
  const byLabel = [...labels.values()];
  const byIp = [...ips.values()];
  return {
    byLabel,
    byIp,
    unknownLabel,
    unknownIp,
    expiredIp,
    duplicateLabelProfiles: byLabel
      .filter((g) => g.count > 1)
      .flatMap((g) => g.profiles),
    duplicateIpProfiles: byIp
      .filter((g) => g.count > 1)
      .flatMap((g) => g.profiles),
  };
}

/** Profiles currently bound to this proxy (any age). */
export function profilesSharingProxy(
  proxyId: string | undefined | null,
  profiles: BrowserProfile[],
  exceptProfileId?: string,
): BrowserProfile[] {
  if (!proxyId) return [];
  return profiles.filter(
    (p) =>
      p.proxy_id === proxyId && (!exceptProfileId || p.id !== exceptProfileId),
  );
}

/** Prefer unreferenced SOCKS5 routes, but sharing never prevents selection. */
export function pickAvailableProxy(
  proxies: StoredProxy[],
  profiles: BrowserProfile[],
): StoredProxy | null {
  const candidates = proxies.filter(
    (proxy) => proxy.proxy_settings?.proxy_type?.toLowerCase() === "socks5",
  );
  return (
    candidates.find(
      (proxy) => !profiles.some((profile) => profile.proxy_id === proxy.id),
    ) ??
    candidates[0] ??
    null
  );
}

export function nextAutoCardLabel(profiles: BrowserProfile[]): string {
  let max = 0;
  for (const p of profiles) {
    const note = p.note ?? "";
    const m = note.match(/card\s*:\s*card-([A-Za-z0-9]+)/i);
    if (!m) continue;
    const token = m[1];
    if (/^\d+$/.test(token)) {
      max = Math.max(max, Number.parseInt(token, 10));
    } else if (/^[A-Za-z]$/.test(token)) {
      max = Math.max(max, token.toUpperCase().charCodeAt(0) - 64);
    }
  }
  // A, B, C … then card-27 etc.
  const n = max + 1;
  if (n <= 26) return `card-${String.fromCharCode(64 + n)}`;
  return `card-${n}`;
}

export function buildAutoProfileName(
  proxy: StoredProxy,
  profiles: BrowserProfile[],
): string {
  const baseIp =
    proxy.name.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1] ??
    proxy.geo_country ??
    "node";
  const country = proxy.geo_country ?? "XX";
  let idx = 1;
  let name = `Claude-${country}-${baseIp}`;
  const existing = new Set(profiles.map((p) => p.name.toLowerCase()));
  while (existing.has(name.toLowerCase())) {
    idx += 1;
    name = `Claude-${country}-${baseIp}-${idx}`;
  }
  return name;
}

export function buildResidentialLabel(proxy: StoredProxy): string {
  const ip =
    proxy.name.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1] ??
    proxy.proxy_settings?.host ??
    proxy.id.slice(0, 8);
  const geo = proxy.geo_country ?? "US";
  return `家宽-${geo}-${ip}`;
}

/** Fully automatic Claude profile plan for a preferred or chosen route. */
export function planAutoClaudeProfile(args: {
  proxies: StoredProxy[];
  profiles: BrowserProfile[];
  proxyId?: string;
  cardLabel?: string;
  name?: string;
}): AutoClaudeProfilePlan | { error: string } {
  let proxy: StoredProxy | null = null;
  if (args.proxyId) {
    proxy = args.proxies.find((p) => p.id === args.proxyId) ?? null;
    if (!proxy) return { error: "所选代理不存在，请重新选择" };
  } else {
    proxy = pickAvailableProxy(args.proxies, args.profiles);
    if (!proxy) {
      return {
        error: "没有可选的 SOCKS5 家宽代理，请先添加代理",
      };
    }
  }

  const cardLabel = args.cardLabel?.trim() || nextAutoCardLabel(args.profiles);
  const residentialLabel = buildResidentialLabel(proxy);
  const name = args.name?.trim() || buildAutoProfileName(proxy, args.profiles);
  const startUrl = CLAUDE_DEFAULT_START_URL;
  const note = buildClaudeNote({
    cardLabel,
    residentialLabel,
    startUrl,
  });

  return {
    name,
    proxyId: proxy.id,
    proxyName: proxy.name,
    cardLabel,
    residentialLabel,
    startUrl,
    note,
    tags: buildClaudeTags(),
    wayfernConfig: getClaudeWayfernConfig(),
  };
}

/** Read start_url from note, or Claude default for claude-tagged profiles. */
export function resolveClaudeStartUrl(profile: BrowserProfile): string | null {
  const note = profile.note ?? "";
  const m = note.match(/start_url\s*:\s*(\S+)/i);
  if (m?.[1]) {
    const url = m[1].trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  const tags = profile.tags ?? [];
  if (tags.includes("claude") || /DON Claude isolation/i.test(note)) {
    return CLAUDE_DEFAULT_START_URL;
  }
  return null;
}

function fingerprintObj(
  profile: BrowserProfile,
): Record<string, unknown> | null {
  const raw = profile.wayfern_config?.fingerprint;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed.fingerprint ?? parsed;
  } catch {
    return null;
  }
}

/** Determine if a profile is specifically configured for Claude isolation. */
export function isClaudeProfile(profile: BrowserProfile): boolean {
  const tags = profile.tags ?? [];
  const note = profile.note ?? "";
  return (
    tags.includes("claude") ||
    tags.includes("don-isolation") ||
    /DON Claude isolation/i.test(note) ||
    /^Claude-/i.test(profile.name)
  );
}

/**
 * Assess a profile against the Claude isolation model.
 * `hostDpr` should be window.devicePixelRatio when available.
 */
export function assessClaudeProfile(
  profile: BrowserProfile,
  allProfiles: BrowserProfile[],
  proxies: StoredProxy[],
  hostDpr?: number,
): ProfileHealth {
  const issues: HealthIssue[] = [];
  const cfg = profile.wayfern_config;
  const fp = fingerprintObj(profile);
  const isClaude = isClaudeProfile(profile);

  if (isClaude && !profile.proxy_id && !profile.vpn_id) {
    issues.push({
      code: "NO_PROXY",
      severity: "block",
      message:
        "No residential proxy assigned — Claude isolation requires 1 家宽 IP per profile",
    });
  } else if (profile.proxy_id) {
    if (!proxies.some((proxy) => proxy.id === profile.proxy_id)) {
      issues.push({
        code: "PROXY_MISSING",
        severity: "block",
        message:
          "The configured proxy no longer exists. Reassign it before use.",
      });
    }
    const shared = profilesSharingProxy(
      profile.proxy_id,
      allProfiles,
      profile.id,
    );
    if (shared.length > 0) {
      issues.push({
        code: "SHARED_PROXY",
        severity: "warn",
        message: `以下档案也使用此代理：${shared.map((p) => p.name).join("、")}。仅供提醒，不阻止创建或启动。`,
      });
    }
  }

  if (cfg?.randomize_fingerprint_on_launch === true) {
    issues.push({
      code: "RANDOMIZE_ON",
      severity: "block",
      message:
        "randomize_fingerprint_on_launch is ON — identity will drift every launch",
    });
  }

  if (!isGeoipEnabled(cfg)) {
    issues.push({
      code: "GEOIP_OFF",
      severity: "warn",
      message:
        "geoip is not Based-on-proxy — timezone/language may not match 家宽 IP",
    });
  }

  const webRtcMode = resolveWayfernWebRtcMode(cfg);
  if (webRtcMode !== "proxy" && webRtcMode !== "off") {
    issues.push({
      code: "WEBRTC_OPEN",
      severity: "warn",
      message:
        "WebRTC not blocked — real IP may leak past the residential proxy",
    });
  }

  if (!fp) {
    issues.push({
      code: "NO_FINGERPRINT",
      severity: "warn",
      message: "No fingerprint stored yet (will generate on create/launch)",
    });
  } else {
    const dpr = Number(fp.devicePixelRatio);
    const native = !cfg?.os || cfg.os === getCurrentOS();
    const expectedDpr = native
      ? (hostDpr ?? cfg?.expected_device_pixel_ratio)
      : cfg?.expected_device_pixel_ratio;
    if (
      expectedDpr != null &&
      Number.isFinite(dpr) &&
      Math.abs(dpr - expectedDpr) > 0.05
    ) {
      issues.push({
        code: "DPR_MISMATCH",
        severity: "warn",
        message: `Fingerprint DPR ${dpr} differs from the configured target ${expectedDpr}. Run an audit before changing identity.`,
      });
    }
    if (!fp.timezone) {
      issues.push({
        code: "NO_TIMEZONE",
        severity: "warn",
        message: "Fingerprint missing timezone — should match 家宽 IP region",
      });
    }
  }

  const note = profile.note ?? "";
  if (isClaude) {
    if (!/card\s*:/i.test(note)) {
      issues.push({
        code: "NO_CARD_LABEL",
        severity: "warn",
        message:
          "Note missing card label — track 1 card per profile (label only, never store PAN)",
      });
    }
    if (!/residential\s*:/i.test(note)) {
      issues.push({
        code: "NO_RESIDENTIAL_LABEL",
        severity: "warn",
        message: "Note missing residential/家宽 label for ops tracking",
      });
    }

    const tags = profile.tags ?? [];
    if (!tags.includes("claude")) {
      issues.push({
        code: "NO_CLAUDE_TAG",
        severity: "warn",
        message: "Missing tag “claude” — add for filtering",
      });
    }
  }

  let score: HealthSeverity = "ok";
  if (issues.some((i) => i.severity === "block")) score = "block";
  else if (issues.some((i) => i.severity === "warn")) score = "warn";

  return {
    profileId: profile.id,
    profileName: profile.name,
    score,
    issues,
  };
}

export function assessAllClaudeProfiles(
  profiles: BrowserProfile[],
  proxies: StoredProxy[],
  hostDpr?: number,
): ProfileHealth[] {
  return profiles
    .map((p) => assessClaudeProfile(p, profiles, proxies, hostDpr))
    .sort((a, b) => {
      const rank = { block: 0, warn: 1, ok: 2 } as const;
      return rank[a.score] - rank[b.score];
    });
}

/** Create-dialog gate: returns human-readable blockers. */
export function claudeCreateBlockers(args: {
  name: string;
  proxyId?: string;
  profiles: BrowserProfile[];
  cardLabel?: string;
  /** When true (auto-create), empty card label is allowed — caller will fill. */
  allowEmptyCard?: boolean;
  /** Retained for create-call compatibility; never used to gate proxy reuse. */
  nowSecs?: number;
}): string[] {
  const blockers: string[] = [];
  if (!args.name.trim()) blockers.push("Profile name is required");
  if (!args.proxyId) {
    blockers.push(
      "Select a dedicated residential (家宽) proxy — required for Claude isolation",
    );
  }
  if (!args.allowEmptyCard && !args.cardLabel?.trim()) {
    blockers.push(
      "Card label required (unique per profile — e.g. card-A, not the real number)",
    );
  }
  return blockers;
}

/**
 * Soft-fix wayfern flags for Claude isolation.
 * Preserves existing fingerprint/os so identity does not jump unless regen is requested.
 */
export function buildIsolationWayfernConfig(
  existing?: WayfernConfig | null,
): WayfernConfig {
  const defaults = getClaudeWayfernConfig();
  return {
    ...defaults,
    ...existing,
    geoip: true,
    webrtc_mode: "proxy",
    randomize_fingerprint_on_launch: false,
  };
}

export function mergeClaudeTags(existing?: string[] | null): string[] {
  const set = new Set([...(existing ?? []), ...buildClaudeTags()]);
  return Array.from(set);
}

/** Codes that one-click flag-fix can resolve without regenerating fingerprint. */
export const FLAG_FIXABLE_CODES = new Set([
  "RANDOMIZE_ON",
  "GEOIP_OFF",
  "WEBRTC_OPEN",
  "NO_CLAUDE_TAG",
]);

/** Codes that need a full fingerprint regeneration (host DPR / missing FP). */
export const REGEN_FIXABLE_CODES = new Set(["DPR_MISMATCH", "NO_FINGERPRINT"]);

export function canFlagFix(health: ProfileHealth): boolean {
  return health.issues.some((i) => FLAG_FIXABLE_CODES.has(i.code));
}

export function needsFingerprintRegen(health: ProfileHealth): boolean {
  return health.issues.some((i) => REGEN_FIXABLE_CODES.has(i.code));
}

/** BLOCK issues that should stop launch until fixed (DON payment/isolation safety). */
export function launchBlockMessages(
  profile: BrowserProfile,
  allProfiles: BrowserProfile[],
  hostDpr?: number,
): string[] {
  if (!isClaudeProfile(profile)) {
    return [];
  }
  const health = assessClaudeProfile(profile, allProfiles, [], hostDpr);
  // Only hard-block on issues that break critical account isolation.
  // Missing card label or DPR mismatches stay warn-only.
  const hard = new Set(["NO_PROXY", "RANDOMIZE_ON"]);
  return health.issues
    .filter((i) => i.severity === "block" && hard.has(i.code))
    .map((i) => i.message);
}

export function isGeoipEnabled(cfg?: WayfernConfig | null): boolean {
  if (!cfg) return false;
  return cfg.geoip === true || cfg.geoip === "true";
}
