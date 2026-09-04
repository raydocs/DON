import type { CookieReadResult, UnifiedCookie } from "@/types";

/**
 * Composite identity for one cookie row within a single domain: `name` + `path`
 * joined by a tab. The backend cookie store uniquely keys a row on
 * `(host_key, top_frame_site_key, name, path)` (see `cookies_unique_index` in
 * `src-tauri/src/cookie_manager.rs`), but the `UnifiedCookie` the frontend
 * receives exposes only the RFC 6265 identity (`name`, `path`). A `name` alone
 * is not unique: a host can hold one `sid` on `/` and another `sid` on `/app`.
 * Keying export selection on `name` alone collapses those rows into one toggle
 * and makes the "X of Y selected" counter disagree with what is exported, so
 * selection is keyed on `name` + `path` instead. The tab delimiter keeps a name
 * or path that happens to contain a separator from bleeding one field into the
 * other.
 */
export type CookieKey = string;

export function cookieKey(cookie: { name: string; path: string }): CookieKey {
  return `${cookie.name}\t${cookie.path}`;
}

export type DomainSelection = {
  allSelected: boolean;
  cookies: Set<CookieKey>;
};

export type SelectionState = Record<string, DomainSelection>;

export function initSelectionFromCookieData(
  data: CookieReadResult,
): SelectionState {
  const sel: SelectionState = {};
  for (const d of data.domains) {
    sel[d.domain] = {
      allSelected: true,
      cookies: new Set(d.cookies.map((c) => cookieKey(c))),
    };
  }
  return sel;
}

export function countSelectedCookies(
  data: CookieReadResult | null,
  selection: SelectionState,
): number {
  if (!data) return 0;
  let count = 0;
  for (const domain of Object.keys(selection)) {
    const ds = selection[domain];
    const domainData = data.domains.find((d) => d.domain === domain);
    if (!domainData) continue;
    if (ds.allSelected) {
      count += domainData.cookie_count;
    } else {
      count += domainData.cookies.filter((c) =>
        ds.cookies.has(cookieKey(c)),
      ).length;
    }
  }
  return count;
}

export function getSelectedCookies(
  data: CookieReadResult | null,
  selection: SelectionState,
): UnifiedCookie[] {
  if (!data) return [];
  const result: UnifiedCookie[] = [];
  for (const domain of data.domains) {
    const ds = selection[domain.domain];
    if (!ds) continue;
    if (ds.allSelected) {
      result.push(...domain.cookies);
    } else {
      result.push(
        ...domain.cookies.filter((c) => ds.cookies.has(cookieKey(c))),
      );
    }
  }
  return result;
}

export function selectDomain(
  prev: SelectionState,
  domain: string,
  cookies: UnifiedCookie[],
): SelectionState {
  // `prev[domain]` is `undefined` when the domain was previously fully
  // deselected (entries are deleted on empty — see `toggleCookie`). Treat
  // missing as "not selected" so re-enabling falls through to the add
  // branch instead of crashing on `.allSelected`.
  if (prev[domain]?.allSelected) {
    const next = { ...prev };
    delete next[domain];
    return next;
  }
  return {
    ...prev,
    [domain]: {
      allSelected: true,
      cookies: new Set(cookies.map((c) => cookieKey(c))),
    },
  };
}

export function toggleCookie(
  prev: SelectionState,
  domain: string,
  cookieName: string,
  cookiePath: string,
  totalCookies: number,
): SelectionState {
  const key = cookieKey({ name: cookieName, path: cookiePath });
  const current = prev[domain] ?? {
    allSelected: false,
    cookies: new Set<CookieKey>(),
  };
  const newCookies = new Set(current.cookies);
  if (newCookies.has(key)) {
    newCookies.delete(key);
  } else {
    newCookies.add(key);
  }
  if (newCookies.size === 0) {
    const next = { ...prev };
    delete next[domain];
    return next;
  }
  return {
    ...prev,
    [domain]: {
      allSelected: newCookies.size === totalCookies,
      cookies: newCookies,
    },
  };
}
