import type { WayfernConfig, WayfernOS, WayfernWebRtcMode } from "@/types";

export function resolveWayfernWebRtcMode(
  config?: Pick<WayfernConfig, "webrtc_mode" | "block_webrtc"> | null,
): WayfernWebRtcMode {
  if (config?.webrtc_mode != null) {
    if (config.webrtc_mode === "proxy" || config.webrtc_mode === "off") {
      return config.webrtc_mode;
    }
    if (config.webrtc_mode === "real") return "real";
    return "proxy";
  }
  if (config?.block_webrtc === true) return "proxy";
  if (config?.block_webrtc === false) return "real";
  return "proxy";
}

export function getCurrentOS(): WayfernOS {
  if (typeof navigator === "undefined") return "linux";
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  return "linux";
}

/**
 * Safe create-profile defaults for DON (Claude / multi-account isolation).
 * - No randomize-on-launch (identity must stay stable)
 * - geoip follows proxy exit (timezone/language match 家宽 IP)
 * - WebRTC uses the proxy-safe mode by default (no real-IP leak)
 * - Host devicePixelRatio + screen max (Stripe/Claude payment iframe safety)
 */
export function getDefaultWayfernConfig(): WayfernConfig {
  const os = getCurrentOS();
  const screenWidth =
    typeof window === "undefined" ? undefined : window.screen.width;
  const screenHeight =
    typeof window === "undefined" ? undefined : window.screen.height;
  const devicePixelRatio =
    typeof window === "undefined" ? undefined : window.devicePixelRatio || 1;

  return {
    os,
    // Based-on-proxy: backend apply_geolocation stamps timezone/language/lat-lon.
    geoip: true,
    webrtc_mode: "proxy",
    randomize_fingerprint_on_launch: false,
    expected_device_pixel_ratio: devicePixelRatio,
    // Cap at the host logical monitor so Wayfern never invents a larger 4K shell.
    screen_max_width: screenWidth,
    screen_max_height: screenHeight,
  };
}
