/* =============================================================================
 * twitch.mjs — shared Twitch logic (auth + list + download) for the CLI and the
 * selection server. PUBLIC app (no secret), Device Code Flow. Downloaded clips are
 * named by clip id, so "already downloaded" is just a file-existence check.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as metrics from './metrics.mjs';
import { readJsonStrict, writeJson } from './json-store.mjs';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CLIPS_DIR = path.join(DIR, 'realclips');
const TOKEN_FILE = path.join(DIR, '.token.json');
const ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const SCOPES = 'channel:manage:clips';

function loadEnv() {
  for (const p of [path.join(DIR, '..', '.env'), path.join(DIR, '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();
/** The Twitch app's public Client ID, loaded from `.env` (see README.md → Setup). Empty string if unset. */
export const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Save the token cache, keeping it owner-readable only (0o600) — it holds a live secret. */
function saveToken(obj) {
  writeJson(TOKEN_FILE, obj);
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* best-effort */ }
}

/**
 * POST a URL-encoded form and record the call for the dashboard's Twitch-call metric.
 *
 * @param {string} url - Full request URL.
 * @param {Record<string, string>} params - Form fields.
 * @returns {Promise<{ok: boolean, status: number, j: object}>} The parsed JSON body
 *   (`{}` if the body isn't valid JSON), alongside `fetch`'s `ok`/`status`.
 */
async function postForm(url, params) {
  const r = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  metrics.recordTwitchCall();
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}

/* ---- filenames / downloaded state ---- */
/** Local filesystem path a clip's downloaded MP4 would live at (whether or not it exists yet). */
export const clipFile = (clip) => path.join(CLIPS_DIR, `${clip.id}.mp4`);
/** Whether a clip id has already been downloaded (file-existence check — the source of truth). */
export const isDownloadedId = (id) => fs.existsSync(path.join(CLIPS_DIR, `${id}.mp4`));
/** Same as {@link isDownloadedId}, taking a Helix clip object instead of a bare id. */
export const isDownloaded = (clip) => isDownloadedId(clip.id);
/** Ids of every clip currently downloaded to `CLIPS_DIR` (derived from the `.mp4` filenames on disk). */
export const listDownloadedIds = () => fs.existsSync(CLIPS_DIR)
  ? fs.readdirSync(CLIPS_DIR).filter(f => f.endsWith('.mp4')).map(f => f.slice(0, -4))
  : [];

/* ---- Homemade thumbnail fallback: a frame grabbed client-side (canvas, no ffmpeg)
 * from the downloaded mp4, uploaded once a clip's real Twitch thumbnail 404s. ---- */
const thumbFile = (id) => path.join(CLIPS_DIR, `${id}.thumb.jpg`);
/**
 * URL of a clip's homemade fallback thumbnail, if one has been generated.
 *
 * @param {string} id - Clip id.
 * @returns {?string} A `/render/realclips/...` URL, or `null` if none exists yet.
 */
export const generatedThumbUrl = (id) => fs.existsSync(thumbFile(id)) ? `/render/realclips/${id}.thumb.jpg` : null;

/**
 * Save a client-side canvas frame-grab (as a `data:image/jpeg;base64,...` URL) as a
 * clip's fallback thumbnail. Only accepted for clips we actually have downloaded, and
 * only for ids matching the safe filename charset — defends against a crafted id/URL
 * writing outside `CLIPS_DIR` or writing non-JPEG data.
 *
 * @param {string} id - Clip id.
 * @param {string} dataUrl - A `data:image/jpeg;base64,...` URL.
 * @returns {boolean} Whether the thumbnail was saved.
 */
export function saveGeneratedThumbnail(id, dataUrl) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  if (!isDownloadedId(id)) return false;   // only for clips we actually have locally
  const m = /^data:image\/jpeg;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return false;
  fs.writeFileSync(thumbFile(id), Buffer.from(m[1], 'base64'));
  return true;
}

/**
 * Delete a downloaded clip's local MP4 (reversible — it can be re-downloaded, UNLESS
 * Twitch no longer has it, in which case the caller should have already warned that
 * this is final). The id is validated to a safe charset so a crafted id can't escape
 * `CLIPS_DIR`.
 *
 * @param {string} id - Clip id.
 * @returns {boolean} Whether a file was removed.
 */
export function deleteDownload(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const f = path.join(CLIPS_DIR, `${id}.mp4`);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  const th = thumbFile(id);
  if (fs.existsSync(th)) fs.unlinkSync(th);
  return true;
}

/* ---- Device Code Flow ---- */
/**
 * Run the OAuth Device Code Flow: request a device code, hand the verification URL +
 * user code to `onCode` (so the caller can display it), then poll until the user
 * approves it. On success the token is cached to `render/.token.json` (owner-only
 * permissions) and this resolves; it never returns the token directly — use
 * {@link token} afterward.
 *
 * @param {object} [opts]
 * @param {(code: {verification_uri: string, user_code: string}) => void} [opts.onCode] -
 *   Called once the device code has been issued.
 * @returns {Promise<void>}
 * @throws {Error} If `TWITCH_CLIENT_ID` is unset, the device request fails, the code
 *   expires, or authorization times out.
 */
export async function login({ onCode } = {}) {
  if (!CLIENT_ID) throw new Error('Missing TWITCH_CLIENT_ID (.env). See README.md → Setup.');
  const { ok, j } = await postForm(`${ID}/device`, { client_id: CLIENT_ID, scopes: SCOPES });
  if (!ok) throw new Error('device request failed: ' + JSON.stringify(j));
  const { device_code, user_code, verification_uri, expires_in, interval } = j;
  (onCode || (() => {}))({ verification_uri, user_code });

  const deadline = Date.now() + expires_in * 1000;
  const pollMs = Math.max(1, interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const { ok, j } = await postForm(`${ID}/token`, {
      client_id: CLIENT_ID, scopes: SCOPES, device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (ok && j.access_token) { saveToken({ ...j, expires_at: Date.now() + j.expires_in * 1000 }); return; }
    const msg = String(j.message || j.error || '');
    if (/pending/i.test(msg)) continue;
    if (/slow/i.test(msg)) { await sleep(pollMs); continue; }
    if (/expired|invalid/i.test(msg)) throw new Error('device code error: ' + msg);
  }
  throw new Error('Authorization timed out.');
}

/**
 * Exchange a refresh token for a new access token and persist it (Twitch rotates the
 * refresh token on every use, so the new one must be saved too).
 *
 * @param {object} t - The current cached token object (must have `refresh_token`).
 * @returns {Promise<object>} The new cached token object (with `expires_at`).
 * @throws {Error} If the refresh call fails — the caller must have the user log in again.
 */
async function refresh(t) {
  const { ok, j } = await postForm(`${ID}/token`, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: t.refresh_token });
  if (!ok || !j.access_token) throw new Error('refresh failed — rerun login. ' + JSON.stringify(j));
  const nt = { ...j, expires_at: Date.now() + j.expires_in * 1000 };
  saveToken(nt);   // rotating refresh token
  return nt;
}
/** Whether a cached token file exists (does not check it's still valid — see {@link token}). */
export function hasToken() { return fs.existsSync(TOKEN_FILE); }
let refreshing = null;   // shared in-flight refresh — single-use refresh tokens must not race
/**
 * Get a valid access token, transparently refreshing it if it's expired (or about to
 * expire within 60s). Concurrent callers share the same in-flight refresh so a
 * single-use refresh token is never spent twice.
 *
 * @returns {Promise<object>} The cached token object (`access_token`, `expires_at`, …).
 * @throws {Error} `'NO_TOKEN'` if the user has never logged in.
 */
export async function token() {
  let t = readJsonStrict(TOKEN_FILE);
  if (!t) throw new Error('NO_TOKEN');
  if (Date.now() > t.expires_at - 60_000) {
    if (!refreshing) refreshing = refresh(t).finally(() => { refreshing = null; });
    t = await refreshing;
  }
  return t;
}

/* ---- Helix ---- */
/**
 * Call a Helix endpoint with the app's Client-Id and the given bearer token.
 *
 * @param {string} pathq - Path + query string (no leading slash), e.g. `'users'`.
 * @param {object} t - Token object (as returned by {@link token}).
 * @returns {Promise<object>} The parsed JSON response body.
 * @throws {Error} If the response isn't OK.
 */
async function helix(pathq, t) {
  const r = await fetch(`${HELIX}/${pathq}`, { headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + t.access_token } });
  metrics.recordTwitchCall();
  if (!r.ok) throw new Error(`Helix ${pathq.split('?')[0]} → ${r.status} ${await r.text()}`);
  return r.json();
}
/** The authenticated user (broadcaster) for the given token. */
export async function me(t) { return (await helix('users', t)).data[0]; }

/**
 * Shared cursor-pagination core: page a Helix `clips?...` query until `pagination.cursor`
 * is exhausted, `limit` clips have been collected, or `maxPages` trips as a circuit
 * breaker (never hit in practice).
 *
 * @param {object} t - Token object.
 * @param {string} base - Base query string (e.g. `'clips?broadcaster_id=123'`), without
 *   `first`/`after`.
 * @param {object} [opts]
 * @param {number} [opts.limit=Infinity] - Stop once this many clips have been collected.
 * @param {number} opts.maxPages - Hard cap on the number of pages fetched.
 * @param {(progress: {fetched: number, page: number}) => void} [opts.onProgress] - Fires
 *   after each page.
 * @returns {Promise<object[]>} The collected Helix clip objects.
 */
async function paginateClips(t, base, { limit = Infinity, maxPages, onProgress = () => {} }) {
  const clips = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const take = Math.min(100, limit - clips.length);
    if (take <= 0) break;
    let q = `${base}&first=${take}`;
    if (cursor) q += `&after=${encodeURIComponent(cursor)}`;
    const r = await helix(q, t);
    clips.push(...(r.data || []));
    cursor = (r.pagination && r.pagination.cursor) || '';
    onProgress({ fetched: clips.length, page: page + 1 });
    if (!cursor) break;
  }
  return clips;
}

/**
 * List clips for the authenticated broadcaster, most recent first. `first` is a soft
 * cap (Helix maxes a single page at 100); pass 0/falsy for `first` to follow the
 * `pagination.cursor` Helix returns until it's exhausted — i.e. literally every clip
 * in the period, not just the first page. That's the only reliable way to get "100% of
 * my clips": Twitch doesn't expose a bulk export, and the Get Clips endpoint is
 * paginated by design.
 *
 * @param {object} [opts]
 * @param {number} [opts.days=0] - If set, only clips created in the last N days.
 * @param {number} [opts.first=30] - Soft cap on the number of clips returned (0 = all).
 * @returns {Promise<{user: object, clips: object[]}>} The broadcaster and their clips.
 */
export async function listClips({ days = 0, first = 30 } = {}) {
  const t = await token();
  const u = await me(t);
  let base = `clips?broadcaster_id=${u.id}`;
  if (days) {
    const ended = new Date(), started = new Date(Date.now() - days * 86_400_000);
    base += `&started_at=${started.toISOString()}&ended_at=${ended.toISOString()}`;
  }
  const clips = await paginateClips(t, base, { limit: first || Infinity, maxPages: 200 });
  clips.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { user: u, clips };
}

/**
 * Fetch every clip Twitch has for the authenticated broadcaster, all-time, following
 * `pagination.cursor` to exhaustion — the local catalog is only useful if it's complete.
 *
 * @param {(progress: {fetched: number, page: number}) => void} [onProgress] - Fires
 *   after each page lands.
 * @returns {Promise<object[]>} Every clip.
 */
export async function listAllClips(onProgress = () => {}) {
  const t = await token();
  const u = await me(t);
  const clips = await paginateClips(t, `clips?broadcaster_id=${u.id}`, { maxPages: 500, onProgress });
  return clips;
}

/**
 * Fetch clips by their exact ids (Helix Get Clips `id=…`, up to 100 per call). Used so
 * selecting a clip outside the "top 100" listing still resolves.
 *
 * @param {string[]} ids - Clip ids.
 * @returns {Promise<object[]>} The matching Helix clip objects (order not guaranteed).
 */
export async function getClipsByIds(ids) {
  if (!ids || !ids.length) return [];
  const t = await token();
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const q = 'clips?' + ids.slice(i, i + 100).map(id => 'id=' + encodeURIComponent(id)).join('&');
    out.push(...((await helix(q, t)).data || []));
  }
  return out;
}

/**
 * Resolve Twitch game ids → names (game_id `"0"` = no game, skipped). Batched at 100
 * ids/call (Helix's per-request cap) — a full-catalog refresh can easily span more
 * than 100 distinct games, so a single unbatched call would silently drop the rest.
 *
 * @param {string[]} ids - Game ids (duplicates and falsy/`"0"` entries are ignored).
 * @returns {Promise<Record<string, string>>} Map of game id → name.
 */
export async function gameNames(ids) {
  const uniq = [...new Set(ids.filter(id => id && id !== '0'))];
  if (!uniq.length) return {};
  const t = await token();
  const map = {};
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const j = await helix('games?' + batch.map(id => 'id=' + encodeURIComponent(id)).join('&'), t);
    for (const g of j.data || []) map[g.id] = g.name;
  }
  return map;
}

/* ---- Download (official endpoint), named by clip id, skip if present ---- */
/**
 * Resolve temporary signed download URLs for a batch of clips via the official
 * Get Clips Download endpoint.
 *
 * @param {string} broadcasterId - Broadcaster id that owns the clips.
 * @param {string} editorId - Authenticated user's id (required by Helix; equals
 *   `broadcasterId` when downloading your own clips).
 * @param {string[]} ids - Up to ~10 clip ids at once (see {@link downloadClips}'s batching).
 * @param {object} t - Token object.
 * @returns {Promise<object[]>} Entries with `clip_id`/`id` and a `landscape_download_url`
 *   / `portrait_download_url`.
 * @throws {Error} If the request fails.
 */
async function resolveUrls(broadcasterId, editorId, ids, t) {
  const qs = `broadcaster_id=${encodeURIComponent(broadcasterId)}&editor_id=${encodeURIComponent(editorId)}&`
           + ids.map(id => 'clip_id=' + encodeURIComponent(id)).join('&');
  const r = await fetch(`${HELIX}/clips/downloads?${qs}`, { headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + t.access_token } });
  metrics.recordTwitchCall();
  const body = await r.text();
  if (!r.ok) throw new Error(`clips/downloads → ${r.status} ${body}`);
  return (JSON.parse(body).data) || [];
}

/**
 * Download the given clips (Helix clip objects) to `CLIPS_DIR`, named `<id>.mp4`.
 * Skips ones already on disk. Purely mechanical (bytes only) — the caller is
 * responsible for recording the clip's metadata into the catalog (see catalog.mjs)
 * once a download actually succeeds.
 *
 * @param {object[]} clips - Helix clip objects to download.
 * @param {(progress: {id: string, status: 'exists'|'downloading'|'done'|'error'}) => void} [onProgress]
 * @returns {Promise<{downloaded: number}>} Count of clips actually downloaded this call
 *   (excludes ones that already existed).
 */
export async function downloadClips(clips, onProgress = () => {}) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const todo = clips.filter(c => { const has = isDownloaded(c); if (has) onProgress({ id: c.id, status: 'exists' }); return !has; });
  if (!todo.length) return { downloaded: 0 };
  const t = await token();
  const u = await me(t);
  let count = 0;
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const entries = await resolveUrls(batch[0].broadcaster_id, u.id, batch.map(c => c.id), t);
    for (const c of batch) {
      const e = entries.find(x => (x.clip_id || x.id) === c.id) || {};
      const url = e.landscape_download_url || e.portrait_download_url || e.download_url;
      if (!url) { onProgress({ id: c.id, status: 'error' }); continue; }
      onProgress({ id: c.id, status: 'downloading' });
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      metrics.recordTwitchCall();
      metrics.recordTwitchBytes(buf.length);
      fs.writeFileSync(clipFile(c), buf);
      onProgress({ id: c.id, status: 'done' });
      count++;
    }
  }
  return { downloaded: count };
}
