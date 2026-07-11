/* =============================================================================
 * server.mjs — local selection UI server. Single entry point (no CLI needed):
 * in-browser Twitch login (device code), list clips with a "downloaded" badge,
 * pick + download the ones you want, save them as a named configuration, then
 * point an OBS Browser Source at that configuration's overlay URL. Uses twitch.mjs
 * (PUBLIC app, no secret). Serves the repo so /overlay/ and the downloaded clips
 * are reachable. Configurations live in render/configs/ (configs.mjs); saving one
 * pushes a live-reload event (SSE) to any overlay currently open for it.
 *
 * Browsing/curating/the overlay all read the local catalog (catalog.mjs) — Twitch
 * itself is only touched by login, an actual download, and an explicit "Update"
 * refresh (POST /api/catalog/refresh), never on a normal page load.
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tw from './twitch.mjs';
import * as cfg from './configs.mjs';
import * as catalog from './catalog.mjs';
import * as metrics from './metrics.mjs';
import * as dashboard from './dashboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');            // repo root (serves /overlay/, /render/…)
const PORT = Number(process.env.PORT) || 8080;
// Only accept requests addressed to localhost — defeats DNS-rebinding from other tabs.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

let LOGIN = { authorized: tw.hasToken() };     // in-memory device-login state

// Play order → (overlay order, display sort). 'random' = overlay reshuffles each
// loop; the others play in a fixed sorted order.
const ORDERS = {
  random: { overlay: 'random',     sort: (a, b) => b.views - a.views },
  views:  { overlay: 'sequential', sort: (a, b) => b.views - a.views },
  recent: { overlay: 'sequential', sort: (a, b) => new Date(b.createdAt) - new Date(a.createdAt) },
  oldest: { overlay: 'sequential', sort: (a, b) => new Date(a.createdAt) - new Date(b.createdAt) },
  custom: { overlay: 'sequential', sort: null },   // keep the exact incoming id order (drag sequence)
};

/* Resolve a saved config into what the overlay actually needs: catalog metadata for
 * its clips, filtered to what's downloaded right now, in the config's play order. Reads
 * the local catalog only — no live Twitch calls — so a clip deleted on Twitch AFTER
 * being downloaded keeps playing (cached title/game/broadcaster) instead of silently
 * dropping out of the reel. Always recomputed fresh from disk (never cached in memory)
 * so an overlay re-fetching this after an SSE "update" ping sees the current state. */
function resolvePlaylist(config) {
  const ord = ORDERS[config.order] || ORDERS.random;
  const seq = config.sequence || [];
  const chosen = seq
    .filter(id => tw.isDownloadedId(id))
    .map(id => { const e = catalog.getEntry(id); return e ? { id, ...e } : null; })
    .filter(Boolean);
  if (ord.sort) chosen.sort(ord.sort);
  return {
    settings: {
      order: ord.overlay, loop: true, transitionMs: 700, muted: false,
      showTitle: config.showTitle !== false,
      showBroadcaster: config.showBroadcaster !== false,
      showGame: config.showGame !== false,
    },
    clips: chosen.map(c => ({ mp4: `/render/realclips/${c.id}.mp4`, title: c.title, broadcaster: c.broadcaster, game: c.game, duration: c.duration })),
  };
}

/* ---- SSE: notify any open overlay that its configuration changed, so it can
 * re-fetch the playlist and hot-swap without a hard refresh of the OBS source. ---- */
const subscribers = new Map();   // config id -> Set<ServerResponse>
function subscribe(id, res) {
  let set = subscribers.get(id);
  if (!set) subscribers.set(id, set = new Set());
  res._connectedAt = Date.now();   // read by dashboard.mjs to show "connected for…"
  set.add(res);
  return () => { set.delete(res); if (!set.size) subscribers.delete(id); };
}
function notify(id) {
  const set = subscribers.get(id);
  if (!set) return;
  for (const res of set) res.write('data: update\n\n');
}

/* ---- SSE: push catalog-refresh progress to the "Update" button's progress bar. ---- */
const catalogSubscribers = new Set();
function catalogBroadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of catalogSubscribers) res.write(line);
}
let catalogRefreshing = false;

/* ---- SSE: a lightweight heartbeat the curate UI opens for its whole tab lifetime —
 * lets the CLI dashboard report "web UI open" as a real connection, not a guess from
 * recent request activity (which fires just as easily for a stray curl). ---- */
const uiSubscribers = new Set();

/* Kick off device-code login; resolve once we have the code (polling continues). */
function startLogin() {
  return new Promise((resolve, reject) => {
    tw.login({ onCode: (c) => { LOGIN = { authorized: false, ...c }; resolve(c); } })
      .then(() => { LOGIN.authorized = true; })
      .catch((e) => { LOGIN.error = e.message; reject(e); });
  });
}

const send = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); });
  req.on('end', () => resolve(d)); req.on('error', reject);
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/render/curate/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  // Never serve dotfiles/dirs (.env, .token.json, .last-clips.json, .git, `..`) —
  // they hold secrets or are outside the app surface.
  if (rel.split('/').some(seg => seg.startsWith('.'))) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
  const full = path.join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + rel); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  metrics.recordServerRequest();
  if (req.headers.host && !ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403).end('Forbidden host'); return; }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // Redirect bare "/" to the UI dir so its relative assets resolve correctly.
    if (p === '/') { res.writeHead(302, { Location: '/render/curate/' }); return res.end(); }
    if (p === '/api/status') {
      return send(res, 200, { hasCreds: !!tw.CLIENT_ID, authorized: tw.hasToken(), login: LOGIN });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (tw.hasToken()) return send(res, 200, { authorized: true });
      const code = await startLogin();                 // resolves with {verification_uri, user_code}
      return send(res, 200, { verification_uri: code.verification_uri, user_code: code.user_code });
    }
    if (p === '/api/clips') {
      // Reads the local catalog only — no Twitch call, ever, on this path. Returns
      // EVERY cataloged clip; Period/Max/search/Show-hidden are pure client-side
      // filters (see curate.js visibleClips()) so they apply instantly, no round-trip.
      const known = catalog.getAll();
      const fromCatalog = Object.entries(known).map(([id, e]) => ({
        id, title: e.title, game: e.game, views: e.views, duration: e.duration, createdAt: e.createdAt,
        thumbnail: e.missing ? (tw.generatedThumbUrl(id) || e.thumbnail) : e.thumbnail,
        downloaded: tw.isDownloadedId(id), orphaned: !!e.missing,
      }));
      // A downloaded file with no catalog entry at all (dropped in manually, or grabbed
      // before the very first catalog Update) still belongs in the grid.
      const knownIds = new Set(Object.keys(known));
      const uncataloged = tw.listDownloadedIds().filter(id => !knownIds.has(id)).map(id => ({
        id, title: '(not yet cataloged — click Update)', game: '', views: 0, duration: 0, createdAt: null,
        thumbnail: tw.generatedThumbUrl(id) || '', downloaded: true, orphaned: true,
      }));
      const combined = [...fromCatalog, ...uncataloged].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      return send(res, 200, { clips: combined, catalogUpdatedAt: catalog.lastUpdated() });
    }
    if (p === '/api/download' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: 'no ids' });
      const chosen = await tw.getClipsByIds(ids);   // resolve exact ids (not a top-100 refetch)
      const games = await tw.gameNames(chosen.map(c => c.game_id));
      const result = await tw.downloadClips(chosen);
      const downloaded_ids = chosen.filter(tw.isDownloaded).map(c => c.id);
      for (const c of chosen) {
        if (!tw.isDownloadedId(c.id)) continue;
        catalog.upsert(c.id, {
          title: c.title, game: games[c.game_id] || '', views: c.view_count, duration: c.duration,
          createdAt: c.created_at, thumbnail: c.thumbnail_url, broadcaster: c.broadcaster_name,
        });
      }
      cfg.configsReferencing(ids).forEach(notify);   // any live overlay using these clips: refresh
      return send(res, 200, { ...result, downloaded_ids });
    }
    if (p === '/api/thumbnail' && req.method === 'POST') {
      // A homemade fallback thumbnail (canvas frame-grab from the local mp4, uploaded by
      // the client once the real Twitch thumbnail 404s — see curate.js handleThumbError).
      const { id, dataUrl } = JSON.parse(await readBody(req) || '{}');
      const ok = tw.saveGeneratedThumbnail(id, dataUrl);
      return send(res, ok ? 200 : 400, { ok });
    }
    if (p === '/api/delete' && req.method === 'POST') {
      // Delete the local MP4 for the given ids (reversible — re-downloadable — UNLESS
      // Twitch no longer has it either, in which case forget it: nothing left to track).
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: 'no ids' });
      const deleted = ids.filter(id => tw.deleteDownload(id));
      for (const id of deleted) { const e = catalog.getEntry(id); if (e && e.missing) catalog.forget(id); }
      cfg.configsReferencing(ids).forEach(notify);   // any live overlay using these clips: refresh
      return send(res, 200, { deleted });
    }
    if (p === '/api/catalog/refresh' && req.method === 'POST') {
      if (catalogRefreshing) return send(res, 409, { error: 'Refresh already in progress' });
      catalogRefreshing = true;
      send(res, 200, { started: true });   // respond immediately — progress comes over SSE
      (async () => {
        try {
          const result = await catalog.refresh(({ fetched, page }) => catalogBroadcast({ type: 'progress', fetched, page }));
          catalogBroadcast({ type: 'done', ...result, updatedAt: catalog.lastUpdated() });
        } catch (e) {
          catalogBroadcast({ type: 'error', error: e.message });
          dashboard.log(`ERROR catalog refresh: ${e.stack || e.message}`);
        } finally {
          catalogRefreshing = false;
        }
      })();
      return;
    }
    if (p === '/api/catalog/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(':ok\n\n');
      catalogSubscribers.add(res);
      const heartbeat = setInterval(() => res.write(':hb\n\n'), 25_000);
      req.on('close', () => { clearInterval(heartbeat); catalogSubscribers.delete(res); });
      return;
    }
    if (p === '/api/ui/presence') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(':ok\n\n');
      res._connectedAt = Date.now();   // read by dashboard.mjs
      uiSubscribers.add(res);
      const heartbeat = setInterval(() => res.write(':hb\n\n'), 25_000);
      req.on('close', () => { clearInterval(heartbeat); uiSubscribers.delete(res); });
      return;
    }
    if (p === '/api/configs' && req.method === 'GET') {
      return send(res, 200, { configs: cfg.listConfigs() });
    }
    if (p === '/api/configs' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const saved = cfg.saveConfig(body);
      notify(saved.id);
      return send(res, 200, saved);
    }
    const cm = p.match(/^\/api\/configs\/([A-Za-z0-9_-]+)(?:\/(playlist))?$/);
    if (cm) {
      const [, id, sub] = cm;
      if (sub === 'playlist' && req.method === 'GET') {
        const config = cfg.getConfig(id);
        if (!config) return send(res, 404, { error: 'Config not found' });
        return send(res, 200, resolvePlaylist(config));
      }
      if (!sub && req.method === 'GET') {
        const config = cfg.getConfig(id);
        return config ? send(res, 200, config) : send(res, 404, { error: 'Config not found' });
      }
      if (!sub && req.method === 'DELETE') {
        const ok = cfg.deleteConfig(id);
        if (ok) notify(id);
        return send(res, ok ? 200 : 404, { ok });
      }
    }
    if (p === '/api/events') {
      // SSE: the overlay subscribes to its config id and re-fetches the playlist
      // whenever we push an "update" — the live-reload path, no OBS source refresh needed.
      const id = url.searchParams.get('config');
      if (!id) return send(res, 400, { error: 'config required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(':ok\n\n');
      const unsubscribe = subscribe(id, res);
      const heartbeat = setInterval(() => res.write(':hb\n\n'), 25_000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      return;
    }
    return serveStatic(res, req.url);
  } catch (e) {
    const msg = e.message === 'NO_TOKEN' ? 'Not logged in' : e.message;
    if (e.message !== 'NO_TOKEN') dashboard.log(`ERROR ${e.stack || e.message}`);
    return send(res, e.message === 'NO_TOKEN' ? 401 : 500, { error: msg });
  }
});

server.listen(PORT, '127.0.0.1', () => {   // localhost only — never expose to the LAN
  dashboard.start({ port: PORT, subscribers, uiSubscribers, getLogin: () => LOGIN });
});
