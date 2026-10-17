# DON — AGPL fork of Donut Browser

**Version:** 0.0.8

**Upstream:** [zhom/donutbrowser](https://github.com/zhom/donutbrowser) (AGPL-3.0)

**This fork is not affiliated with Donut Browser / donutbrowser.com.**

## What changed vs upstream

| Area | Upstream | DON 0.0.8 |
|------|----------|-----------|
| App name / id | Donut / `com.donutbrowser` | **DON** / `com.donbrowser` |
| Data directory | `DonutBrowser` | **`DON`** (`DONDev` in debug) |
| Version | 0.29.x | **0.0.8** |
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

The Claude health workflow distinguishes configuration from runtime observations.
Residential labels and recent observed exit IPs are separate, advisory groups:
duplicates do not block use, and there are no three/seven-day reuse gates.
Missing required routes still fail closed. Never put card numbers or session keys
in labels. Fingerprint checks distinguish a simulated target from native DPR.

## Local Browser Agent

Open **Agent → Browser tasks**. Configure an explicitly authorised Messages API
endpoint and model, save the key in the password input, then choose a running
local Wayfern profile, an HTTP(S) tab, and a task. No cloud DON identity is needed.
The default model ID is [`claude-haiku-5-5`](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
verified against official documentation; account access and real inference need
the user's own provider key and were not tested without it. Inference is billable;
this feature deploys no hosted browser or paid infrastructure.

- The existing CDP transport and Agent pause/profile holds are reused. Only the
  selected local tab is controlled; no cloud fallback, shell, arbitrary model
  JavaScript, desktop, file, cookie or credential-reading tools are exposed.
- Every navigation, fill and click (including submission) requires a separate,
  one-use desktop confirmation with the origin and masked field state. Changes
  to form values invalidate approval. Inspect the actual browser before approval.
  Cross-origin navigation and ordinary cross-origin form/link targets are refused.
- Passwords, payment data and verification codes must be entered manually. Use
  **Take over**, then **Resume**; CAPTCHA/OTP bypass, SMS integration and bulk
  Claude registration are not implemented. Page text cannot grant tool authority.
- The API key is sealed in the existing installation vault and has no getter.
  A blank key preserves it only for the same endpoint; changing endpoint clears
  it. URL credentials/queries and remote plaintext HTTP endpoints are rejected.
  Only HTTPS or explicit loopback HTTP providers are supported, without redirects.
- Visible page text may still be private and is sent only after task consent.
  Field values, hidden text and private approval digests are omitted from model
  observations. Do not paste secrets into task instructions or page text.
- Tasks are in-memory, single-instance, capped at 30 model turns / 20 minutes.
  Only inference HTTP 429/503 retries twice; uncertain browser actions never
  auto-retry. Pause/cancel cannot undo a submission already dispatched. Closing
  the panel does not cancel; closing DON loses the task history.
- This is not a network sandbox: existing page scripts may make requests, open
  windows or cause side effects. No claim is made to prevent all prompt injection
  or to sandbox CDP. Visual computer-use fallback is not enabled.

Reference: [`anthropics/claude-quickstarts`](https://github.com/anthropics/claude-quickstarts)
(MIT, copyright 2023 Anthropic); the browser-use example illustrates a tool loop
and human approval. No source or assets were copied; DON uses its existing Rust
Messages/CDP boundaries rather than deploying the example's cloud stack.

Local deterministic proof (requires a separately installed Chromium, no model key):

```bash
DONUT_E2E_AGENT_CHROME=/absolute/path/to/chrome DONUT_E2E_HEADED=1 \
  xvfb-run -a pnpm e2e:integrations
```

The fixture performs a real local registration submission and checks approval,
changed fields, pause/takeover/cancel, forbidden tools/origins and key isolation.
The Messages server is scripted; this proves browser/control integration, not
Haiku task reasoning or real-site compatibility. Without the explicit Chromium
path, only the credential test runs and the real-action test is skipped.

## Roadmap

- [x] Device templates (shared Win/Mac/mobile presets with generation-time consistency constraints)
- WebRTC Replace mode (not only block)
- OOPIF fingerprint propagation (Stripe frames)
- Create-time external checker deep-links
