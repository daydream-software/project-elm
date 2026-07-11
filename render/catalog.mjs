/* =============================================================================
 * catalog.mjs — the local clip catalog: ONE JSON file (render/catalog.json) holding
 * every clip we've ever seen for the broadcaster. Browsing, curating, and the live
 * overlay all read this file — Twitch itself is only touched by login, an actual
 * download, and an explicit "Update" refresh (never on a normal page load). A clip
 * Twitch no longer returns on refresh is flagged `missing` rather than deleted from
 * the catalog, as long as its mp4 is still downloaded, so title/thumbnail/game survive
 * a clip that's since been removed upstream.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tw from './twitch.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(DIR, 'catalog.json');

/* One-time migration: this repo used to cache metadata in a per-clip <id>.json sidecar
 * next to each mp4. Fold any of those into the catalog on first load, then remove them
 * — after this, the catalog is the only place clip metadata lives. */
function migrateLegacySidecars() {
  const dir = tw.CLIPS_DIR;
  if (!fs.existsSync(dir)) return {};
  const clips = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      // missing:false, not true — we haven't actually checked Twitch yet, so treat the
      // clip as present until a real refresh() proves otherwise (see refresh() below).
      clips[f.slice(0, -5)] = {
        title: m.title, game: m.game, views: m.views, duration: m.duration,
        createdAt: m.createdAt, thumbnail: m.thumbnail, broadcaster: m.broadcaster, missing: false,
      };
    } catch { /* unreadable sidecar — nothing worth carrying forward */ }
    fs.unlinkSync(full);
  }
  return clips;
}

// Always read fresh from disk (no in-memory cache): the CLI (fetch-clips.mjs) and the
// web server are separate processes that can both touch catalog.json, and a stale
// in-memory copy in one would clobber the other's writes on its next save(). The file
// is small (plain clip metadata, not video) so re-reading it every call costs nothing.
function load() {
  if (fs.existsSync(CATALOG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch { /* rebuild below */ }
  }
  const clips = migrateLegacySidecars();
  const fresh = { updatedAt: null, clips };
  if (Object.keys(clips).length) save(fresh);
  return fresh;
}
function save(catalog) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

export const getAll = () => load().clips;
export const getEntry = (id) => load().clips[id] || null;
export const lastUpdated = () => load().updatedAt;

/** The subset of a Helix clip object (or a resolved game name) worth keeping in the
 *  catalog — the one place this mapping is defined, shared by refresh() and every
 *  caller that upserts a clip right after downloading it. */
export function fromHelixClip(clip, gameName) {
  return {
    title: clip.title, game: gameName || '', views: clip.view_count, duration: clip.duration,
    createdAt: clip.created_at, thumbnail: clip.thumbnail_url, broadcaster: clip.broadcaster_name,
  };
}

/** Record/refresh one clip's metadata — called right after a successful download so a
 *  clip is in the catalog immediately, without waiting for the next full refresh. */
export function upsert(id, fields) {
  const cat = load();
  cat.clips[id] = { ...(cat.clips[id] || {}), ...fields, missing: false };
  save(cat);
}

/** Drop a clip from the catalog entirely. Only meaningful once BOTH the local file and
 *  the Twitch original are gone — nothing left worth tracking it for. */
export function forget(id) {
  const cat = load();
  if (!(id in cat.clips)) return;
  delete cat.clips[id];
  save(cat);
}

/** Full resync: paginate every clip Twitch has for this broadcaster (all-time — a
 *  catalog is only useful if it's complete) and diff against what we already knew.
 *  A previously-known clip Twitch no longer returns is kept (metadata intact) and
 *  flagged `missing` IF its mp4 is still downloaded; otherwise it's dropped, since
 *  there's nothing left to preserve it for. onProgress({fetched, page}) fires per page. */
export async function refresh(onProgress = () => {}) {
  const cat = load();
  const fresh = await tw.listAllClips(onProgress);
  const games = await tw.gameNames(fresh.map(c => c.game_id));
  const presentIds = new Set();
  let added = 0, updated = 0;
  for (const c of fresh) {
    presentIds.add(c.id);
    if (cat.clips[c.id]) updated++; else added++;
    cat.clips[c.id] = { ...fromHelixClip(c, games[c.game_id]), missing: false };
  }
  let newlyMissing = 0, dropped = 0;
  for (const id of Object.keys(cat.clips)) {
    if (presentIds.has(id)) continue;
    if (tw.isDownloadedId(id)) {
      if (!cat.clips[id].missing) newlyMissing++;
      cat.clips[id].missing = true;
    } else {
      delete cat.clips[id];
      dropped++;
    }
  }
  cat.updatedAt = new Date().toISOString();
  save(cat);
  return { total: fresh.length, added, updated, newlyMissing, dropped };
}
