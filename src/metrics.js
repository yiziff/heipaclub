/**
 * Privacy-friendly product event tracking.
 * Fire-and-forget: analytics must never block gameplay or sharing.
 */

const ENDPOINT = "/api/metrics/event";
const ALLOWED_EVENTS = new Set([
  "share_open",
  "share_image_ready",
  "cup_start",
  "about_open",
]);

export function trackEvent(event) {
  if (!ALLOWED_EVENTS.has(event)) return;
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    }).catch(() => {});
  } catch {
    // Analytics failures must remain invisible to users.
  }
}
