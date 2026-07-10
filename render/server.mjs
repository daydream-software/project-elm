/* =============================================================================
 * server.mjs — local selection UI server. Single entry point (no CLI needed):
 * in-browser Twitch login (device code), list clips with a "downloaded" badge,
 * pick + download the ones you want, then preview in the overlay or render an MP4.
 * Uses twitch.mjs (PUBLIC app, no secret). Serves the repo so /overlay/ and the
 * downloaded clips are reachable for preview.
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tw from './twitch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');            // repo root (serves /overlay/, /render/…)
const PORT = Number(process.env.PORT) || 8080;
// Only accept requests addressed to localhost — defeats DNS-rebinding from other tabs.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

let LOGIN = { authorized: tw.hasToken() };     // in-memory device-login state

// Play order → (overlay order, display sort). 'random' = overlay reshuffles each
// loop; the others play in a fixed sorted order.
const ORDERS = {
  random: { overlay: 'random',     sort: (a, b) => b.view_count - a.view_count },
  views:  { overlay: 'sequential', sort: (a, b) => b.view_count - a.view_count },
  recent: { overlay: 'sequential', sort: (a, b) => new Date(b.created_at) - new Date(a.created_at) },
  oldest: { overlay: 'sequential', sort: (a, b) => new Date(a.created_at) - new Date(b.created_at) },
};

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
      const days = Number(url.searchParams.get('days')) || 0;
      const first = Number(url.searchParams.get('first')) || 30;
      const { user, clips } = await tw.listClips({ days, first });
      const out = clips.map(c => ({
        id: c.id, title: c.title, game_id: c.game_id, views: c.view_count,
        duration: c.duration, createdAt: c.created_at, thumbnail: c.thumbnail_url,
        downloaded: tw.isDownloaded(c),
      }));
      return send(res, 200, { user: { id: user.id, name: user.display_name }, clips: out });
    }
    if (p === '/api/download' && req.method === 'POST') {
      const { ids } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: 'no ids' });
      const chosen = await tw.getClipsByIds(ids);   // resolve exact ids (not a top-100 refetch)
      const result = await tw.downloadClips(chosen);
      return send(res, 200, { ...result, downloaded_ids: chosen.filter(tw.isDownloaded).map(c => c.id) });
    }
    if (p === '/api/playlist' && req.method === 'POST') {
      // Write an overlay playlist.json (mp4 = local downloaded files) for preview.
      const { ids, order, showTitle, showBroadcaster, showGame } = JSON.parse(await readBody(req) || '{}');
      const ord = ORDERS[order] || ORDERS.random;
      const clips = await tw.getClipsByIds(ids || []);   // resolve exact ids (not a top-100 refetch)
      const chosen = (ids || []).map(id => clips.find(c => c.id === id)).filter(c => c && tw.isDownloaded(c)).sort(ord.sort);
      const games = await tw.gameNames(chosen.map(c => c.game_id));
      const playlist = {
        settings: {
          order: ord.overlay, loop: true, transitionMs: 700, muted: false,
          showTitle: showTitle !== false,
          showBroadcaster: showBroadcaster !== false,
          showGame: showGame !== false,
        },
        clips: chosen.map(c => ({ mp4: `/render/realclips/${c.id}.mp4`, title: c.title, broadcaster: c.broadcaster_name, game: games[c.game_id] || '', duration: c.duration })),
      };
      fs.writeFileSync(path.join(ROOT, 'overlay', 'reel.playlist.json'), JSON.stringify(playlist, null, 2));
      return send(res, 200, { ok: true, count: chosen.length, url: '/overlay/?playlist=reel.playlist.json' });
    }
    return serveStatic(res, req.url);
  } catch (e) {
    const msg = e.message === 'NO_TOKEN' ? 'Not logged in' : e.message;
    if (e.message !== 'NO_TOKEN') console.error(e);
    return send(res, e.message === 'NO_TOKEN' ? 401 : 500, { error: msg });
  }
});

server.listen(PORT, '127.0.0.1', () => {   // localhost only — never expose to the LAN
  console.log(`\n  Project Elm — selection UI at http://localhost:${PORT}/`);
  console.log(tw.CLIENT_ID ? '' : '  ⚠ No TWITCH_CLIENT_ID (.env) — see README.md → Setup.');
});
