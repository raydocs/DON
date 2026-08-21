# Claude isolation workflow (DON)

**Model:** one Claude account = one profile = one 家宽/residential sticky IP = matching timezone = one payment card.

This is operational isolation for multi-account stability. It does **not** guarantee Anthropic will never ban accounts.

## Hard rules

1. **1 profile ↔ 1 Claude account** — never log two Claude accounts into the same profile.
2. **1 profile ↔ 1 residential IP (active lease)** — assign a dedicated sticky 家宽/residential proxy.
3. **3-day node reuse** — the same proxy may be claimed by a *new* Claude profile only after **3 days** from the previous profile’s `created_at` (lease window). Concurrent active leases still block.
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
2. DON picks the first free node (no active 3-day lease), auto name / 家宽 label / `card-A…`, stamps note with `start_url: https://claude.com` and `proxy_lease_days: 3`.
3. Isolation flags applied: `geoip`, `block_webrtc`, fixed FP, host DPR.

### Create (manual)

1. **New** with Claude isolation checked (default) — form auto-fills free proxy + labels.
2. Tweak name/card if needed; create blocked if node still leased.

### After create

1. Launch the profile → browser opens **claude.com**.
2. Confirm WebRTC/public IP = the residential exit (not home real IP).
3. Warm up briefly, then log into Claude **only on this profile**.
4. Pay only from this profile with its dedicated card.
5. Reuse the same node for another profile only after the **3-day** lease ends (prefer unbinding the old profile).

Every profile ships with the **Session Key for Claude** extension preloaded (reserved **DON Default** group, attached automatically at creation): on claude.ai, click the toolbar icon to copy that profile's session key.

### Health scan

Header **Claude** panel:

| Severity | Examples |
|----------|----------|
| **BLOCK** | No proxy; active shared lease; randomize on; DPR mismatch vs host |
| **WARN** | geoip off; WebRTC open; missing card/家宽 note; missing `claude` tag; node reused after 3d still bound on old profile |
| **OK** | Isolation checks pass |

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
