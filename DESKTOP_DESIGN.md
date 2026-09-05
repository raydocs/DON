# DON desktop: Frame materials

## Direction

DON is a precision workspace for browser profiles, not an imitation of a system
shell. **Frame** separates a quiet, opaque working surface from a narrow material
frame. The distinctive geometry is an inset rectangular workspace with a labelled
navigation spine, fine illuminated edges, and compact, aligned controls. Tono can
share principles (clarity, responsiveness, accessible materials) without sharing
DON's layout, component silhouettes, or navigation structure.

No wallpaper access, screenshots of underlying windows, canvas refraction,
pointer-following filters, external graphics, or remote fonts are added. Optical
displacement is represented by a small control press and a moving active marker,
not distortion of text. Data, credentials, forms, and tables remain opaque.

## Research and decisions

Sources consulted September 5, 2026:

- [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials):
  Liquid Glass belongs to controls/navigation, not content; use custom glass
  sparingly. Adopt that separation, not Apple's capsule shapes or native effect.
  The indexed guidance lists September 9, 2025 as its last material revision;
  no claim is made about unretrieved future platform releases.
- [Apple: Liquid Glass overview](https://developer.apple.com/documentation/technologyoverviews/liquid-glass):
  predictable navigation, platform conventions, and consistent organization matter
  more than adding effects. Preserve the existing native title bar and shortcuts.
- [Microsoft: Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica):
  Mica samples wallpaper once for performance and establishes window hierarchy.
  DON instead uses a theme-derived static surface: no desktop sampling and no
  simulated native Mica claim. Microsoft's page was available in search excerpts;
  direct retrieval failed, so detailed implementation claims are not inferred.
- [Microsoft: Materials](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/materials):
  distinguish base surfaces from transient layers. Solid defaults must remain
  usable without compositing support.
- [Linear's production redesign](https://linear.app/now/how-we-redesigned-the-linear-ui):
  improve hierarchy, alignment and navigation density; stress-test environments,
  appearance and hierarchy. Adopt the evaluation method, not Linear's appearance.

## System contract

| Dimension | Rule |
| --- | --- |
| Color | Existing theme semantic colors remain the source of truth; no per-screen palette or theme reset |
| Material | Opaque workspace and dialogs; limited navigation translucency; solid fallback first |
| Typography | Existing bundled Geist, 12–14px controls, 24–32px first-run headings; tabular operational numbers |
| Spacing | 4px base rhythm; 8/12/16/24/32px group spacing; compact rows retain virtualization geometry |
| Shape | Small control corners, larger workspace corners; no universal pill conversion |
| Depth | One raised frame, fine edge highlight; no stacked large blur filters |
| Icons | Existing icon vocabulary, stable 16px navigation icons; labels visible on wide windows |
| Focus | High-visibility outline independent of hover/selection; keyboard order follows DOM |
| Hover/pressed | Short color response and small press transforms; no delayed action execution |
| Loading | Immediately visible content/skeleton; no staggered opacity gates |
| Error | Opaque surface, semantic error color plus text and retry action |
| Empty | Clear first action and secondary import path; filtered-empty stays distinct |
| Reduced effects | Reduced motion/transparency, high contrast and unsupported backdrop filters use solid surfaces |

## Platform and shipping boundaries

Windows native controls remain on the right; macOS traffic-light reservation and
window dragging remain owned by existing window components. This change does not
claim WKWebView, WebView2, VoiceOver or Narrator validation from Linux/Chromium.
System transparency preferences are only available where the embedded web engine
exposes their media query. Low-GPU devices can use the always-solid baseline;
no GPU benchmark can be inferred from headless browser timing.

Bug Ship owns main serialization. Backend, active E2E tests, download hooks and
locales are outside this branch. Release remains gated by real sync correctness
and publication issues, including #111 and #84 until their owners resolve them.
Do not trigger a tag/release merely because frontend checks pass. The existing
release workflow permits ad-hoc Apple signing; that is not evidence of Developer
ID signing or notarization, and must not be presented as a signed stable release.

## Implemented and measured

The frame uses a 176px labelled navigation spine at 1100px and above and a 48px
icon rail below that. The native header/drag regions, data virtualization and
business logic are unchanged. The More menu uses the existing Radix non-modal
menu for arrow keys, Escape, outside dismissal and focus return. Welcome becomes
a split identity/features layout; on short windows it scrolls normally, including
to its actions. Empty profiles have an explicit Create/Import action panel.

Dialogs and tab panels no longer hide their contents behind opacity or blur.
This removes the old 500ms tab-content fade and 4px blur rather than adding a
rendering dependency. Floating menus and forms are opaque; navigation alone can
opt into a fixed 8px optical layer when all capability/preference checks pass.
Notifications sit bottom-left instead of obscuring right-aligned form actions.
Accessible document title, select labels, welcome list semantics, error alert and
contrast on the create-workflow panel are included.

### Reproducible native review

Build the frontend and native E2E app with the normal repository workflow, then
start a local `tauri-wd` 0.1.11 driver in a desktop session. Run:

```sh
DONUT_E2E_DRIVER_URL=http://127.0.0.1:4444 \
DONUT_REVIEW_AXE_PATH=/path/to/axe-core-4.10.3/axe.min.js \
node e2e/desktop-review.mjs
```

The script uses the existing AppSession isolation contract, saves screenshots and
JSON into a unique system temporary directory, exercises real controls, and fails
on any collected WCAG 2 A/AA or 2.1 AA axe violation. It covers wide/compact and
dark workspaces, Create, Network, Settings, keyboard More navigation, wide/compact
welcome and its scrolled actions, loading, and an explicitly injected failure at
the real Tauri download-progress event boundary. The latter is UI fault injection,
not verification of a published Wayfern download.

Linux WebKitGTK measurements (8GiB orb, debug native harness, production frontend):

| Measurement | Original baseline | Final sample |
| --- | ---: | ---: |
| Workspace first contentful paint | 1109ms | 520ms |
| Welcome first contentful paint | 785ms | 540ms |
| Five navigation click-to-second-frame samples | 499 / 375 / 285 / 253 / 88ms | 222 / 243 / 156 / 232 / 130ms |
| Driver + isolated fixture + workspace ready | 3030ms | 3260ms |
| Driver + isolated fixture + welcome ready | 3217ms | 3291ms |
| All static JS, gzip (not initial-route transfer) | 1,072,249 bytes | 1,072,121 bytes |
| All static CSS, gzip | 26,780 bytes | 27,538 bytes |

These are observations, **not a causal performance claim or a hardware startup
budget**. The baseline ran during build/test load; other identical-code samples
varied substantially. In particular, driver-inclusive ready time did not improve.
Real Windows/macOS process startup, input latency and low-GPU power use remain
release gates, not inferred passes. No animation waits are used to hide slow data.

### Verification record

- Baseline: original main [1d2d980](https://github.com/raydocs/DON/commit/1d2d9806572aa8b1b40e41a782d5f0b74ff5df30) production frontend and unmodified native code;
  full root tests passed, native UI 17/18. Missing document title, unnamed selects
  and invalid welcome definition-list markup were found by axe and fixed here.
- Rebased onto main [3081f82](https://github.com/raydocs/DON/commit/3081f825ced3ecf8993915cb31024f24a7206243) (group tombstone guard and macOS compile correction).
- `pnpm format`, `pnpm lint`, `pnpm test`: passed; 78 JavaScript tests, Rust groups
  900 / 19 / 15 / 15 passed. Two pre-existing unused-translation-variable warnings
  remain outside this scope. Final targeted Biome and TypeScript checks pass.
- Native `e2e:smoke`: 9/9. Native `e2e:ui`: final 17/18, exact same extension
  source-kind baseline failure; an intermediate run passed 18/18. This is not a
  clean UI suite. Evidence and unchanged acceptance criteria are in
  [#114](https://github.com/raydocs/DON/issues/114).
- Native review: 13 audited captures, zero axe violations, keyboard focus visible
  with solid outline, one active navigation item; final screenshots inspected.
- Native `e2e:network`: blocked before tests by missing Docker daemon. Residential
  proxy and Wayfern test credentials were not available in the process either.
  Other native suites (entities, integrations, sync, browser) were not run for
  this frontend-only change; full root Rust integration/sync tests were run.
- Browser Portal: the unmodified production export requires Tauri and falls into
  its error page in plain Chromium. No fake bridge or mock application was added
  to manufacture a live Portal. Review is through real native screenshots and
  WebDriver evidence instead.
- Release version remains 0.0.8. The workflow publishes on `v*` tags, currently
  allows ad-hoc macOS signing, and has no explicit notarization configuration or
  Windows certificate in the reviewed files. Secret metadata enumeration returned
  HTTP 403, so signing credentials cannot be certified here. Updates use
  `raydocs/DON` GitHub Releases and `SHA256SUMS.txt`, not an Apple-style update feed.
  No tag, release artifact, signature, checksum file or feed was published.

Remaining release/verification gates are tracked in
[#115](https://github.com/raydocs/DON/issues/115). Existing mixed-language Claude
workflow copy is tracked separately in [#116](https://github.com/raydocs/DON/issues/116);
no raw user-facing strings or locale fallback keys were added by this branch.
