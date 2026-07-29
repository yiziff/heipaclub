/**
 * Static NetEase top-song packs for hot roster artists (fans ≥ 500k + extras).
 * Loaded on demand via Vite glob so unused packs stay out of the main chunk.
 */

import index from "./data/hot-tops/index.json";

const loaders = import.meta.glob([
  "./data/hot-tops/*.json",
  "!./data/hot-tops/index.json",
]);

export function hasHotTopPack(artistId) {
  return Boolean(index?.artists?.[artistId]);
}

/**
 * @returns {Promise<null | { id: string, name: string, neteaseArtistId: number|string, avatar: string, songs: any[], updatedAt?: string }>}
 */
export async function loadHotTopPack(artistId) {
  const fileId = index?.artists?.[artistId];
  if (!fileId) return null;
  const key = `./data/hot-tops/${fileId}.json`;
  const loader = loaders[key];
  if (!loader) return null;
  const mod = await loader();
  const pack = mod?.default || mod;
  if (!pack?.songs?.length) return null;
  return pack;
}
