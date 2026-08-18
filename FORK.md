# DON — AGPL fork of Donut Browser

**Version:** 0.0.7

**Upstream:** [zhom/donutbrowser](https://github.com/zhom/donutbrowser) (AGPL-3.0)

**This fork is not affiliated with Donut Browser / donutbrowser.com.**

## What changed vs upstream

| Area | Upstream | DON 0.0.7 |
|------|----------|-----------|
| App name / id | Donut / `com.donutbrowser` | **DON** / `com.donbrowser` |
| Data directory | `DonutBrowser` | **`DON`** (`DONDev` in debug) |
| Version | 0.29.x | **0.0.7** |
| Paid gates | Pro subscription required for fingerprint edit, automation, etc. | **All local capabilities unlocked** |
| Commercial trial modal | 14-day commercial use trial | **Removed** (module, commands, modal, settings section, locale keys) |
| App auto-update | Pulls `zhom/donutbrowser` releases | **Authenticated private releases from `raydocs/DON` only** |
| Built-in extensions | None | **Session Key for Claude** (CWS `dlpmgafmpolffcmjedpdphdnejmfljnb`) auto-downloaded at first launch; reserved **DON Default** group attached to every new profile and to existing group-less profiles (one-time migration) |
| Proxy add form | Manual field entry only | **Paste `host:port:user:pass` / `scheme://…`** into the host field to auto-fill |
| Quick create | — | Claude panel: **paste proxy → create profile → post-create exit check** (exit IP/country/timezone vs fingerprint timezone/language, WebRTC + DPR/screen/UA summary, "Match to proxy" fix) |
| Fingerprint generation | Accepts any Wayfern random result | **Rejects bad DPR / oversized screen; retries full regen** |
| Create defaults | Sparse config | Host `devicePixelRatio` + screen max; **no randomize-on-launch** |

## License (required)

This project remains under **GNU Affero General Public License v3.0**.

- Keep the AGPL license and copyright notices when you distribute.
- If you run a modified network service that users interact with remotely, you must offer corresponding source (AGPL §13).
- Do **not** present this binary as official “Donut Browser”.

## Why separate branding and version

- Avoid overwriting or mixing official install data (`%LOCALAPPDATA%\DonutBrowser`).
- Avoid pulling official updates that would replace this fork; Mac and Windows
  use the same private DON release stream.
- Version **0.0.x** marks a clean break from upstream release numbers.

## Build (Windows sketch)

Requires: Node 20+, pnpm, Rust stable, Visual Studio C++ build tools, WebView2.

```powershell
cd C:\Users\ruiru\dev\DON
pnpm install
pnpm tauri build
```

Dev:

```powershell
pnpm tauri dev
```

## Fingerprint policy (DON)

1. Prefer fingerprints whose `devicePixelRatio` matches the **host display scale** (e.g. 1.5 @ 150% Windows, 2.0 Retina).
2. Cap `screenWidth/Height` at the host logical monitor size.
3. Require `windowOuter*` ≤ available/screen size.
4. Never locally patch a single field on a generated fingerprint — regenerate the whole object and round-trip `setFingerprint` when editing at runtime.

This prevents the Stripe/Claude payment iframe double-scale bug caused by JS `devicePixelRatio=1` on a 1.5×/2× compositor.

See **[UPSTREAM_REQUESTS.md](./UPSTREAM_REQUESTS.md)** for the fork's TLS/JA3 decision and the English request list for Wayfern upstream.

## Claude isolation workflow

See **[CLAUDE_WORKFLOW.md](./CLAUDE_WORKFLOW.md)**.

In short: **1 profile · 1 家宽 IP · matching timezone · 1 card**.

- Create dialog: Claude isolation mode (default on) requires dedicated proxy + card label.
- Header **Claude** button: rules + fleet health scan (shared proxy / DPR / randomize / geo).
- Defaults: `geoip: true`, `block_webrtc: true`, host DPR, no randomize-on-launch.

## Roadmap

- [x] Device templates (shared Win/Mac/mobile presets with generation-time consistency constraints)
- WebRTC Replace mode (not only block)
- OOPIF fingerprint propagation (Stripe frames)
- Create-time external checker deep-links
