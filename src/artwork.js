export function coverUrl(song, fallback = "") {
  return song?.cover || song?.coverSm || fallback || "";
}

export function imgTag(src, { alt = "", className = "" } = {}) {
  const safeAlt = String(alt || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  if (!src) {
    return `<div class="${className} img-fallback" aria-hidden="true"></div>`;
  }
  return `<img class="${className}" src="${src}" alt="${safeAlt}" loading="lazy" referrerpolicy="no-referrer" />`;
}
