import { getDefaultWayfernConfig } from "@/lib/wayfern-defaults";
import type { BrowserProfile, StoredProxy, WayfernConfig } from "@/types";

/** Hard isolation model for Claude accounts on DON. */
export const CLAUDE_ISOLATION_RULES = [
  "1 profile = 1 Claude account",
  "1 profile = 1 residential (家宽) sticky IP (active lease)",
  "Same node may be reused only after 7 days",
  "1 profile = 1 timezone matching that IP",
  "1 profile = 1 payment card (do not share cards across profiles)",
  "Fingerprint stays fixed (never randomize on launch)",
  "devicePixelRatio must match this host (payment iframe safety)",
  "Default start page: https://claude.com",
] as const;

/** Days a residential node stays reserved for one Claude profile. */
export const PROXY_REUSE_COOLDOWN_DAYS = 7;

export const PROXY_REUSE_COOLDOWN_SECS =
  PROXY_REUSE_COOLDOWN_DAYS * 24 * 60 * 60;

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

export interface ProxyHoldInfo {
  profile: BrowserProfile;
  /** Unix seconds when the lease started. */
  holdStart: number;
  /** Unix seconds when the node becomes free for a new Claude profile. */
  freeAt: number;
  /** True while now < freeAt. */
  active: boolean;
  /** Whole days remaining (ceil), 0 when free. */
  daysRemaining: number;
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

/** Wayfern config for Claude: geo follows proxy, WebRTC blocked, stable FP. */
export function getClaudeWayfernConfig(): WayfernConfig {
  return {
    ...getDefaultWayfernConfig(),
    // Align timezone/language/geo with the proxy exit (Based-on-proxy style).
    geoip: true,
    // Prefer not leaking real local IP through WebRTC.
    block_webrtc: true,
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
    `proxy_lease_days: ${PROXY_REUSE_COOLDOWN_DAYS}`,
    "rule: 1 profile · 1 家宽 IP · 1 timezone · 1 card · reuse node after 7d",
  ];
  return lines.join("\n");
}

export function buildClaudeTags(): string[] {
  return ["claude", "residential", "don-isolation"];
}

/** Prefer created_at; fall back to last_launch for legacy profiles. */
export function profileProxyHoldStart(profile: BrowserProfile): number | null {
  if (profile.created_at != null && profile.created_at > 0) {
    return profile.created_at;
  }
  if (profile.last_launch != null && profile.last_launch > 0) {
    return profile.last_launch;
  }
  return null;
}

/**
 * Lease info for a profile that currently references this proxy.
 * Missing timestamps are treated as still holding (conservative).
 */
export function getProxyHoldInfo(
  profile: BrowserProfile,
  nowSecs: number = Math.floor(Date.now() / 1000),
): ProxyHoldInfo | null {
  if (!profile.proxy_id) return null;
  const holdStart = profileProxyHoldStart(profile) ?? nowSecs;
  const freeAt = holdStart + PROXY_REUSE_COOLDOWN_SECS;
  const active = nowSecs < freeAt;
  const daysRemaining = active
    ? Math.max(1, Math.ceil((freeAt - nowSecs) / (24 * 60 * 60)))
    : 0;
  return { profile, holdStart, freeAt, active, daysRemaining };
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

/** Profiles whose 7-day lease on this proxy is still active. */
export function profilesHoldingProxy(
  proxyId: string | undefined | null,
  profiles: BrowserProfile[],
  exceptProfileId?: string,
  nowSecs: number = Math.floor(Date.now() / 1000),
): ProxyHoldInfo[] {
  return profilesSharingProxy(proxyId, profiles, exceptProfileId)
    .map((p) => getProxyHoldInfo(p, nowSecs))
    .filter((h): h is ProxyHoldInfo => h?.active === true);
}

/** True if a new Claude profile may claim this node now. */
export function isProxyReusable(
  proxyId: string,
  profiles: BrowserProfile[],
  exceptProfileId?: string,
  nowSecs: number = Math.floor(Date.now() / 1000),
): boolean {
  return (
    profilesHoldingProxy(proxyId, profiles, exceptProfileId, nowSecs).length ===
    0
  );
}

/** First free residential proxy (no active 7-day hold). */
export function pickAvailableProxy(
  proxies: StoredProxy[],
  profiles: BrowserProfile[],
  nowSecs: number = Math.floor(Date.now() / 1000),
): StoredProxy | null {
  for (const proxy of proxies) {
    if (isProxyReusable(proxy.id, profiles, undefined, nowSecs)) {
      return proxy;
    }
  }
  return null;
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

/** Fully automatic Claude profile plan for a free proxy (or a chosen one). */
export function planAutoClaudeProfile(args: {
  proxies: StoredProxy[];
  profiles: BrowserProfile[];
  proxyId?: string;
  cardLabel?: string;
  name?: string;
}): AutoClaudeProfilePlan | { error: string } {
  const now = Math.floor(Date.now() / 1000);
  let proxy: StoredProxy | null = null;
  if (args.proxyId) {
    proxy = args.proxies.find((p) => p.id === args.proxyId) ?? null;
    if (!proxy) return { error: "Selected proxy not found" };
    if (!isProxyReusable(proxy.id, args.profiles, undefined, now)) {
      const holds = profilesHoldingProxy(
        proxy.id,
        args.profiles,
        undefined,
        now,
      );
      const names = holds.map((h) => h.profile.name).join(", ");
      const days = holds[0]?.daysRemaining ?? PROXY_REUSE_COOLDOWN_DAYS;
      return {
        error: `Proxy still leased by: ${names} (${days}d left of ${PROXY_REUSE_COOLDOWN_DAYS}d window)`,
      };
    }
  } else {
    proxy = pickAvailableProxy(args.proxies, args.profiles, now);
    if (!proxy) {
      return {
        error: `No free residential proxy — all nodes are within the ${PROXY_REUSE_COOLDOWN_DAYS}-day lease`,
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
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Assess a profile against the Claude isolation model.
 * `hostDpr` should be window.devicePixelRatio when available.
 */
export function assessClaudeProfile(
  profile: BrowserProfile,
  allProfiles: BrowserProfile[],
  _proxies: StoredProxy[],
  hostDpr?: number,
  nowSecs: number = Math.floor(Date.now() / 1000),
): ProfileHealth {
  const issues: HealthIssue[] = [];
  const cfg = profile.wayfern_config;
  const fp = fingerprintObj(profile);

  if (!profile.proxy_id && !profile.vpn_id) {
    issues.push({
      code: "NO_PROXY",
      severity: "block",
      message:
        "No residential proxy assigned — Claude isolation requires 1 家宽 IP per profile",
    });
  } else if (profile.proxy_id) {
    const activeHolds = profilesHoldingProxy(
      profile.proxy_id,
      allProfiles,
      profile.id,
      nowSecs,
    );
    if (activeHolds.length > 0) {
      issues.push({
        code: "SHARED_PROXY",
        severity: "block",
        message: `Proxy still leased by: ${activeHolds
          .map((h) => `${h.profile.name} (${h.daysRemaining}d left)`)
          .join(", ")} — wait ${PROXY_REUSE_COOLDOWN_DAYS}d or unbind`,
      });
    } else {
      const older = profilesSharingProxy(
        profile.proxy_id,
        allProfiles,
        profile.id,
      );
      if (older.length > 0) {
        issues.push({
          code: "PROXY_REUSED",
          severity: "warn",
          message: `Node reused after ${PROXY_REUSE_COOLDOWN_DAYS}d; still bound on: ${older
            .map((p) => p.name)
            .join(", ")} — unbind old profile if unused`,
        });
      }
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

  if (cfg?.block_webrtc !== true) {
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
    if (
      hostDpr != null &&
      Number.isFinite(dpr) &&
      Math.abs(dpr - hostDpr) > 0.05
    ) {
      issues.push({
        code: "DPR_MISMATCH",
        severity: "block",
        message: `Fingerprint DPR ${dpr} ≠ host ${hostDpr} — Claude/Stripe payment iframe may break`,
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
  nowSecs?: number;
}): string[] {
  const now = args.nowSecs ?? Math.floor(Date.now() / 1000);
  const blockers: string[] = [];
  if (!args.name.trim()) blockers.push("Profile name is required");
  if (!args.proxyId) {
    blockers.push(
      "Select a dedicated residential (家宽) proxy — required for Claude isolation",
    );
  } else {
    const holds = profilesHoldingProxy(
      args.proxyId,
      args.profiles,
      undefined,
      now,
    );
    if (holds.length > 0) {
      blockers.push(
        `Node leased until ~${holds[0].daysRemaining}d left by: ${holds
          .map((h) => h.profile.name)
          .join(", ")} (${PROXY_REUSE_COOLDOWN_DAYS}-day reuse rule)`,
      );
    }
  }
  if (!args.allowEmptyCard && !args.cardLabel?.trim()) {
    blockers.push(
      "Card label required (unique per profile — e.g. card-A, not the real number)",
    );
  }
  return blockers;
}

/** proxyId → list of profile names with an active 7-day lease. */
export function buildProxyOccupancy(
  profiles: BrowserProfile[],
  nowSecs: number = Math.floor(Date.now() / 1000),
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of profiles) {
    if (!p.proxy_id) continue;
    const hold = getProxyHoldInfo(p, nowSecs);
    if (!hold?.active) continue;
    const list = map.get(p.proxy_id) ?? [];
    list.push(
      hold.daysRemaining > 0
        ? `${p.name} (${hold.daysRemaining}d left)`
        : p.name,
    );
    map.set(p.proxy_id, list);
  }
  return map;
}

export function proxyOccupancyLabel(
  proxyId: string,
  occupancy: Map<string, string[]>,
  exceptProfileName?: string,
): string | null {
  const names = (occupancy.get(proxyId) ?? []).filter((n) => {
    if (!exceptProfileName) return true;
    return !n.startsWith(exceptProfileName);
  });
  if (names.length === 0) return null;
  if (names.length === 1) return `leased: ${names[0]}`;
  return `leased: ${names.length} profiles`;
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
    ...existing,
    ...defaults,
    os: existing?.os ?? defaults.os,
    fingerprint: existing?.fingerprint,
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
  const health = assessClaudeProfile(profile, allProfiles, [], hostDpr);
  // Only hard-block on issues that break isolation or payment UI.
  // Missing card label etc. stay warn-only at launch.
  const hard = new Set(["SHARED_PROXY", "RANDOMIZE_ON", "DPR_MISMATCH"]);
  return health.issues
    .filter((i) => i.severity === "block" && hard.has(i.code))
    .map((i) => i.message);
}

export function isGeoipEnabled(cfg?: WayfernConfig | null): boolean {
  if (!cfg) return false;
  return cfg.geoip === true || cfg.geoip === "true";
}
