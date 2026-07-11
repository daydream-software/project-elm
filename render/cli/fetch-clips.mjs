#!/usr/bin/env node
/* fetch-clips — CLI over twitch.mjs. Pull your own Twitch clips, then render-reel.
 *   node render/cli/fetch-clips.mjs login
 *   node render/cli/fetch-clips.mjs list [--days N] [--first N]
 *   node render/cli/fetch-clips.mjs pull <all|1,3,5> [--days N] [--first N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tw from '../twitch.mjs';
import * as catalog from '../catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error('✗ ' + m); process.exit(1); };
const fmtDur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`; };
const LIST_FILE = path.join(HERE, '.last-clips.json');
const saveList = (c) => fs.writeFileSync(LIST_FILE, JSON.stringify(c));
const loadList = () => (fs.existsSync(LIST_FILE) ? JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) : null);

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const days = Number(flag('days', 0)) || 0;
const first = Number(flag('first', 30));

if (!tw.CLIENT_ID) die('Missing TWITCH_CLIENT_ID. Copy .env.example to .env (see README.md → Setup).');

try {
  if (cmd === 'login') {
    await tw.login({ onCode: ({ verification_uri, user_code }) => {
      console.log('\n  ┌─ Authorize the Twitch app ─────────────────────────');
      console.log(`  │  1. Open:  ${verification_uri}`);
      console.log(`  │  2. Enter code:  ${user_code}`);
      console.log('  │  (sign in with your channel account)');
      console.log('  └────────────────────────────────────────────────────');
      console.log('  Waiting for authorization…');
    } });
    console.log('✓ Authorized — token saved (.token.json).');

  } else if (cmd === 'list') {
    const { user, clips } = await tw.listClips({ days, first });
    saveList(clips);
    console.log(`\n${user.display_name} — ${clips.length} clips${days ? ` (last ${days}d)` : ''}:\n`);
    clips.forEach((c, i) => console.log(
      `  [${String(i + 1).padStart(2)}] ${tw.isDownloaded(c) ? '✓' : ' '} ${fmtDur(c.duration)} ${String(c.view_count).padStart(6)} views  ${c.title}`));
    console.log(`\n(✓ = already downloaded)   pull all   |   pull 1,3,5`);

  } else if (cmd === 'pull') {
    const sel = args[1];
    if (!sel) die('Usage: pull <all|1,3,5>');
    let clips = loadList();
    if (!clips) { clips = (await tw.listClips({ days, first })).clips; saveList(clips); }
    const chosen = sel === 'all' ? clips : sel.split(',').map(n => clips[Number(n.trim()) - 1]).filter(Boolean);
    if (!chosen.length) die('nothing selected');
    await tw.downloadClips(chosen, ({ id, status }) => {
      const c = chosen.find(x => x.id === id);
      if (status === 'downloading') console.log(`  downloading  ${c.title}`);
      if (status === 'exists') console.log(`  (already)    ${c.title}`);
    });
    const games = await tw.gameNames(chosen.map(c => c.game_id));
    for (const c of chosen) {
      if (!tw.isDownloadedId(c.id)) continue;
      catalog.upsert(c.id, catalog.fromHelixClip(c, games[c.game_id]));
    }
    const manifest = {
      output: 'reel.mp4', width: 1920, height: 1080, fps: 30,
      transition: 'fade', transitionMs: 800, showTitles: true,
      clips: chosen.map(c => ({ file: `${c.id}.mp4`, title: c.title })),
    };
    fs.writeFileSync(path.join(tw.CLIPS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`✓ ${chosen.length} selected → ${tw.CLIPS_DIR}`);
    console.log('Render:  node render/render-reel.mjs render/realclips/manifest.json');

  } else {
    console.log('Usage: node render/cli/fetch-clips.mjs <login|list|pull>');
  }
} catch (e) {
  die(e.message === 'NO_TOKEN' ? 'No token — run first:  node render/cli/fetch-clips.mjs login' : e.message);
}
