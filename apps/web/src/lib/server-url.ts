import { ENV } from "@/env";

/**
 * Returns the backend server base URL.
 * In the browser, if accessed from a LAN IP (e.g. mobile device on Wi-Fi),
 * resolves 'localhost' to the current hostname so API, WebSocket and image requests reach the dev server.
 */
export function getServerUrl(): string {
  const url = ENV.VITE_SERVER_URL.replace(/\/$/, "");
  if (
    typeof window !== "undefined" &&
    window.location.hostname &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        parsed.hostname = window.location.hostname;
        return parsed.origin;
      }
    } catch {
      // Fallback to configured URL
    }
  }
  return url;
}
