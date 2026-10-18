# Claude isolation workflow (DON)

**Model:** one Claude account = one profile = one 家宽/residential sticky IP = matching timezone = one payment card.

This is operational isolation for multi-account stability. It does **not** guarantee Anthropic will never ban accounts.

## Hard rules

1. **1 profile ↔ 1 Claude account** — never log two Claude accounts into the same profile.
2. **Residential route** — configure a 家宽/residential proxy (or VPN route).
3. **Reuse is allowed immediately** — shared routes, labels, and observed exits are informational warnings, never creation or launch gates. There is no waiting period.
4. **1 profile ↔ 1 timezone story** — geoip follows the proxy exit (timezone/language stamped from that IP).
5. **1 profile ↔ 1 card** — use a unique payment instrument per account. DON only stores a **label** (e.g. `card-A`), never a full card number.
6. **Fingerprint fixed** — `randomize_fingerprint_on_launch` stays off.
7. **DPR matches host** — required for Claude/Stripe payment pages to render correctly.
8. **Default start page** — launch opens `https://claude.com` (from note `start_url` or Claude tags).

## In-app flow

### Create (quick paste)

1. Open **Claude** (header) → paste a proxy string (`host:port:user:pass` or `scheme://…`) in **Quick create**, pick the type for scheme-less strings, hit **Create & check**.
2. DON parses and stores the proxy, auto name / 家宽 label / `card-A…`, stamps the note, applies the isolation flags, and creates the profile (GeoIP DB auto-downloaded if missing).
3. A **post-create check** card then measures the proxy exit and shows: exit IP / country / timezone vs fingerprint timezone / language, WebRTC status, UA, DPR, screen. Mismatches offer **Match to proxy** (rewrites only the geo fields).

### Create (auto)

1. Open **Claude** (header) → **Auto-create Claude profile**.
2. DON prefers an unreferenced SOCKS5 route, falling back to a used SOCKS5 route when all are referenced; explicit selection can also reuse a route. It generates a name / 家宽 label / `card-A…` and stamps `start_url: https://claude.com`. No lease metadata is written.
3. Isolation flags applied: `geoip`, `block_webrtc`, fixed FP, host DPR.

### Create (manual)

1. **New** with Claude isolation checked (default) — form auto-fills a preferred proxy + labels.
2. Tweak name/card if needed; shared proxies do not block creation.

### After create

1. Launch the profile → browser opens **claude.com**.
2. Confirm WebRTC/public IP = the residential exit (not home real IP).
3. Warm up briefly, then log into Claude **only on this profile**.
4. Pay only from this profile with its dedicated card.
5. The same route can be reused immediately. Check shared-route warnings for operational context.

Every profile ships with the **Session Key for Claude** extension preloaded (reserved **DON Default** group, attached automatically at creation): on claude.ai, click the toolbar icon to copy that profile's session key.

### Health scan

Header **Claude** panel:

| Severity | Examples |
|----------|----------|
| **BLOCK** | No proxy or VPN route; configured proxy missing (health scan); randomize on |
| **WARN** | Shared proxy; DPR mismatch vs target; geoip off; WebRTC open; missing card/家宽 note; missing `claude` tag |
| **OK** | Isolation checks pass |

### Residential usage API

`buildResidentialUsage(profiles, observations, nowSecs)` is a pure snapshot builder for the health panel. It does not mutate profiles or notes. Observation DTO:

```ts
{ profile_id: string, proxy_id: string | null, ip: string | null,
  observed_at: number | null, fresh: boolean }[]
```

- `byLabel`: groups keyed by the trimmed `residential:` line in `profile.note`. Missing/empty labels and `(set 家宽 label)` go to `unknownLabel`.
- `byIp`: groups keyed only by the latest fresh observed exit IP per profile. Expired or non-fresh observations for the current route go to `expiredIp`; missing, future-dated, or current-`proxy_id`-mismatched observations go to `unknownIp`. Proxy names and hosts are never used as evidence of an exit IP.
- Every group (including unknown and expired groups) contains `key` (`null` for unknown/expired), complete `profiles`, `count`, and `lastObservedAt` (latest known current-route observation in Unix seconds, otherwise `null`).
- `duplicateLabelProfiles` and `duplicateIpProfiles`: complete profiles in known groups with `count > 1`, for independent filtering. Unknown profiles never count as duplicates.
- Observations are fresh for **less than 30 minutes**, solely to expire route-cache evidence, not to restrict reuse. Latest timestamp wins (last input wins ties); a newer unusable observation does not revive an older exit. Dynamic exits replace the old value rather than creating a historical account identity. Nullable proxy IDs match profiles without a proxy ID, supporting cached VPN-route observations. The backend reads only its process-local current-route cache: a shared route can supply several profiles' observations, which is not proof that each profile launched; discarded cache entries become unknown.

Labels and exit IPs are independent: one label may have several exits and several labels may share one exit. No card numbers or session secrets are collected by this function. Existing user notes, including historical lease text, are preserved; new notes and migration additions no longer write lease rules.

## Out of scope (still your responsibility)

- Proxy quality / IP reputation
- Card issuer fraud rules
- Content / ToS policy
- Bulk automation patterns that look like bots

## Files

- `src/lib/claude-workflow.ts` — rules, health, create gates
- `src/lib/wayfern-defaults.ts` — geoip + WebRTC + DPR defaults
- `src/components/create-profile-dialog.tsx` — Claude create mode
- `src/components/claude-workflow-panel.tsx` — checklist + scan UI
