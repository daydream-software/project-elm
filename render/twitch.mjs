/* =============================================================================
 * twitch.mjs — shared Twitch logic (auth + list + download) for the CLI and the
 * selection server. PUBLIC app (no secret), Device Code Flow. Downloaded clips are
 * named by clip id, so "already downloaded" is just a file-existence check.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
export const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const loadJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
// Only used for the token file → keep it owner-readable only (0o600).
const saveJson = (f, o) => { fs.writeFileSync(f, JSON.stringify(o, null, 2)); try { fs.chmodSync(f, 0o600); } catch {} };

async function postForm(url, params) {
  const r = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}

/* ---- filenames / downloaded state ---- */
export const clipFile = (clip) => path.join(CLIPS_DIR, `${clip.id}.mp4`);
export const isDownloaded = (clip) => fs.existsSync(clipFile(clip));

/** Delete a downloaded clip's local MP4 (reversible — it can be re-downloaded).
 *  Returns true if a file was removed. The id is validated to a safe charset so a
 *  crafted id can't escape CLIPS_DIR. */
export function deleteDownload(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const f = path.join(CLIPS_DIR, `${id}.mp4`);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

/* ---- Device Code Flow ---- */
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
    if (ok && j.access_token) { saveJson(TOKEN_FILE, { ...j, expires_at: Date.now() + j.expires_in * 1000 }); return; }
    const msg = String(j.message || j.error || '');
    if (/pending/i.test(msg)) continue;
    if (/slow/i.test(msg)) { await sleep(pollMs); continue; }
    if (/expired|invalid/i.test(msg)) throw new Error('device code error: ' + msg);
  }
  throw new Error('Authorization timed out.');
}

async function refresh(t) {
  const { ok, j } = await postForm(`${ID}/token`, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: t.refresh_token });
  if (!ok || !j.access_token) throw new Error('refresh failed — rerun login. ' + JSON.stringify(j));
  const nt = { ...j, expires_at: Date.now() + j.expires_in * 1000 };
  saveJson(TOKEN_FILE, nt);   // rotating refresh token
  return nt;
}
export function hasToken() { return fs.existsSync(TOKEN_FILE); }
let refreshing = null;   // shared in-flight refresh — single-use refresh tokens must not race
export async function token() {
  let t = loadJson(TOKEN_FILE);
  if (!t) throw new Error('NO_TOKEN');
  if (Date.now() > t.expires_at - 60_000) {
    if (!refreshing) refreshing = refresh(t).finally(() => { refreshing = null; });
    t = await refreshing;
  }
  return t;
}

/* ---- Helix ---- */
async function helix(pathq, t) {
  const r = await fetch(`${HELIX}/${pathq}`, { headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + t.access_token } });
  if (!r.ok) throw new Error(`Helix ${pathq.split('?')[0]} → ${r.status} ${await r.text()}`);
  return r.json();
}
export async function me(t) { return (await helix('users', t)).data[0]; }

export async function listClips({ days = 0, first = 30 } = {}) {
  const t = await token();
  const u = await me(t);
  let q = `clips?broadcaster_id=${u.id}&first=${Math.min(100, first)}`;
  if (days) {
    const ended = new Date(), started = new Date(Date.now() - days * 86_400_000);
    q += `&started_at=${started.toISOString()}&ended_at=${ended.toISOString()}`;
  }
  const clips = ((await helix(q, t)).data || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { user: u, clips };
}

/** Fetch clips by their exact ids (Helix Get Clips id=…, up to 100 per call).
 *  Used so selecting a clip outside the "top 100" listing still resolves. */
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

/** Resolve Twitch game ids → names (game_id "0" = no game, skipped). */
export async function gameNames(ids) {
  const uniq = [...new Set(ids.filter(id => id && id !== '0'))].slice(0, 100);
  if (!uniq.length) return {};
  const t = await token();
  const j = await helix('games?' + uniq.map(id => 'id=' + encodeURIComponent(id)).join('&'), t);
  const map = {};
  for (const g of j.data || []) map[g.id] = g.name;
  return map;
}

/* ---- Download (official endpoint), named by clip id, skip if present ---- */
async function resolveUrls(broadcasterId, editorId, ids, t) {
  const qs = `broadcaster_id=${encodeURIComponent(broadcasterId)}&editor_id=${encodeURIComponent(editorId)}&`
           + ids.map(id => 'clip_id=' + encodeURIComponent(id)).join('&');
  const r = await fetch(`${HELIX}/clips/downloads?${qs}`, { headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + t.access_token } });
  const body = await r.text();
  if (!r.ok) throw new Error(`clips/downloads → ${r.status} ${body}`);
  return (JSON.parse(body).data) || [];
}

/** Download the given clips (Helix clip objects). Skips ones already on disk.
 *  onProgress({id, status}) where status ∈ 'exists'|'downloading'|'done'|'error'. */
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
      fs.writeFileSync(clipFile(c), buf);
      onProgress({ id: c.id, status: 'done' });
      count++;
    }
  }
  return { downloaded: count };
}
