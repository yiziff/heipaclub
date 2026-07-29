export function coverUrl(song, fallback = "") {
  return song?.cover || song?.coverSm || fallback || "";
}

/** Prefer tiny CDN thumbs for share cards (saves MBs vs full covers). */
export function sizedCoverUrl(src, size = 96) {
  const url = String(src || "").trim();
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : "https://heipaclub.com");
    const host = u.hostname.toLowerCase();
    if (host.includes("126.net") || host.includes("music.126")) {
      return `${u.origin}${u.pathname}?param=${size}y${size}`;
    }
    if (host.includes("mzstatic.com")) {
      // iTunes: .../source/100x100bb.jpg style — keep as-is if already sized
      return url.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
    }
  } catch {
    /* keep original */
  }
  return url;
}

/** Same-origin proxy so html-to-image / canvas can read covers (CORS). */
export function proxiedImageUrl(src) {
  const url = String(src || "").trim();
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  if (url.startsWith("/api/img")) return url;
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : "https://heipaclub.com");
    if (typeof location !== "undefined" && u.origin === location.origin) return url;
  } catch {
    /* keep going */
  }
  return `/api/img?u=${encodeURIComponent(url)}`;
}

export function imgTag(src, { alt = "", className = "", proxy = false } = {}) {
  const safeAlt = String(alt || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  if (!src) {
    return `<div class="${className} img-fallback" aria-hidden="true"></div>`;
  }
  const href = proxy ? proxiedImageUrl(src) : src;
  return `<img class="${className}" src="${href}" alt="${safeAlt}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}
