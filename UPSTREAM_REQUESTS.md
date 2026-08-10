# Wayfern upstream requests: fingerprint consistency and kernel metadata

## TLS/JA3 decision

DON does not implement TLS interception, custom JA3 impersonation, or an HTTP/2
fingerprint shim.

Wayfern is a real Chromium-based browser. Its TLS handshake and HTTP/2 behavior
therefore follow the engine that actually runs the profile. A user-space
impersonation layer would either be incomplete or require a man-in-the-middle
certificate trusted by every profile, which would weaken the security boundary
and create a maintenance burden. The practical browser-fingerprint risk is a
stale Chromium base version, so DON exposes kernel freshness instead of trying
to forge the transport layer.

## Requests for Wayfern

These requests would let downstream anti-detect profiles remain internally
consistent without adding transport-level spoofing:

1. Propagate fingerprint state into OOPIF targets, including screen metrics,
   device scale factor, navigator values, WebGL, media devices, and timezone.
   Cross-origin payment and sign-in frames should observe the same identity as
   their parent frame.
2. Document and stabilize the noise parameters for `mediaDevices`, ClientRects,
   and `AudioContext`, including how downstream tools can audit the effective
   values without relying on implementation-specific guesses.
3. Provide a supported WebRTC replace-IP mode that rewrites exposed candidate
   addresses consistently while preserving normal peer-connection behavior.
4. Publish the Chromium base version in `wayfern.json`, together with a
   machine-readable list of supported Wayfern builds and their Chromium bases.
   This would allow clients to compare installed kernels with Chrome Stable
   without launching a profile.
5. Provide a documented local-development path for cross-OS fingerprints that
   does not require a paid production token, or publish a locally verifiable
   self-signed token flow with explicit security and expiry semantics.

## Compatibility expectations

Until these capabilities are available upstream, DON will keep its checks
conservative: it regenerates a complete fingerprint when host constraints are
violated, reports unknown Chromium bases as unknown, and never silently claims
that a cross-OS or mobile preset is active when the Wayfern binary rejects it.
