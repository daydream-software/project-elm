/* =============================================================================
 * dashboard.mjs — live status panel for `node render/server.mjs`, running in
 * the same process (no IPC, no second process to keep in sync). Redraws in
 * place using plain ANSI cursor movement — no TUI dependency (this project
 * has none, on purpose, see README). If stdout isn't a TTY (piped, logged to
 * a file, run under a process manager) we fall back to the old one-line
 * startup log instead of spraying escape codes into a log file.
 *
 * Robustness rules, since a broken dashboard must never take down clip
 * serving: every redraw is wrapped in try/catch and swallows its own errors;
 * the only two places server.mjs used to console.log/console.error now go
 * through log() below, so nothing else writes to the terminal and corrupts
 * the in-place redraw.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import * as tw from './twitch.mjs';
import * as cfg from './configs.mjs';
import * as metrics from './metrics.mjs';

const REFRESH_MS = 1000;
const MAX_LOG_LINES = 5;
const MAX_NAME_LEN = 40;
const useColor = !process.env.NO_COLOR;

const CLIP_STATS_SAFETY_MS = 30_000;   // periodic re-scan, in case a watch event was ever missed

const state = { port: 0, subscribers: new Map(), uiSubscribers: new Set(), getLogin: () => ({}) };
const logLines = [];
let panelActive = false;
let timer = null;
let clipStatsSafetyTimer = null;
let lastLineCount = 0;
let pulseFrame = 0;

function colorize(s, code) { return useColor ? `\x1b[${code}m${s}\x1b[0m` : s; }

/** Funnel for anything this module used to hand straight to console.log/error.
 *  While the live panel is running these fold into it (last few lines); when
 *  there's no panel (non-TTY) they print immediately, same as before. */
export function log(line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  if (!panelActive) { console.log(stamped); return; }
  logLines.push(stamped);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
}

function humanSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(1)} ${units[u]}`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function truncate(name) {
  return name.length > MAX_NAME_LEN ? name.slice(0, MAX_NAME_LEN - 1) + '…' : name;
}

function dirStats(dir, ext) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return { count: 0, bytes: 0 }; }
  let count = 0, bytes = 0;
  for (const f of files) {
    if (ext && !f.endsWith(ext)) continue;
    try { bytes += fs.statSync(path.join(dir, f)).size; count++; } catch { /* raced a delete — skip it */ }
  }
  return { count, bytes };
}

/* Clip count/size is watched instead of scanned every render tick — statting
 * every file once a second gets wasteful once there are hundreds of clips.
 * fs.watch() can occasionally miss an event (a documented Node caveat) and
 * throws synchronously if realclips/ doesn't exist yet (before the first
 * download creates it), so this stays best-effort: a low-frequency safety
 * re-scan in start() corrects any drift and retries the watch if it's down. */
let clipStats = { count: 0, bytes: 0 };
let clipStatsWatcher = null;
let clipStatsDebounce = null;

function refreshClipStats() { clipStats = dirStats(tw.CLIPS_DIR, '.mp4'); }

function scheduleClipStatsRefresh() {
  clearTimeout(clipStatsDebounce);
  clipStatsDebounce = setTimeout(refreshClipStats, 150);   // coalesce a burst of writes into one scan
}

function watchClipsDir() {
  try {
    clipStatsWatcher = fs.watch(tw.CLIPS_DIR, scheduleClipStatsRefresh);
    clipStatsWatcher.on('error', () => { clipStatsWatcher = null; });
  } catch { /* realclips/ doesn't exist yet — the safety-net timer retries */ }
}

function authLine() {
  if (!tw.CLIENT_ID) return colorize('⚠ No TWITCH_CLIENT_ID (.env) — see README.md → Setup.', '33');
  if (tw.hasToken()) return colorize('authorized ✓', '32');
  const login = state.getLogin() || {};
  if (login.error) return colorize(`error — ${login.error}`, '31');
  if (login.user_code) return `waiting for login — open ${login.verification_uri} and enter ${login.user_code}`;
  return 'not logged in yet (log in from the web UI)';
}

/* Active overlays = configs with at least one open SSE connection (see
 * server.mjs's `subscribers`). This reports "connected", not "playing" — the
 * overlay never reports its play/pause state back to the server (OBS
 * visibility is handled entirely client-side in player.js), so a source
 * that's off-program in OBS still shows as connected here. */
function overlayLines() {
  const rows = [];
  for (const [id, set] of state.subscribers) {
    if (!set.size) continue;
    const config = cfg.getConfig(id);
    let earliest = Infinity;
    for (const res of set) if (res._connectedAt < earliest) earliest = res._connectedAt;
    const name = truncate(config ? config.name : `(deleted config ${id})`);
    rows.push(`    • ${name} — ${set.size} client${set.size === 1 ? '' : 's'}, connected ${formatDuration(Date.now() - earliest)}`);
  }
  if (!rows.length) return ['Overlays    none connected'];
  return [`Overlays    ${rows.length} active (SSE-connected)`, ...rows];
}

function overlayClientCount() {
  let n = 0;
  for (const set of state.subscribers.values()) n += set.size;
  return n;
}

/* The two things actually worth a glance at a distance: is a curate UI tab open
 * (uiSubscribers, a heartbeat SSE the page opens for its whole tab lifetime — see
 * server.mjs's /api/ui/presence), and is an overlay connected (subscribers, same idea
 * per config). Each gets its own dot so "someone's on the web UI" and "OBS is pulling
 * a reel" read as distinct facts, not folded into one vague activity pulse. */
function statusLine(label, count, extra) {
  const on = count > 0;
  if (on) pulseFrame++;
  const dot = on ? colorize('●', pulseFrame % 2 ? '1;32' : '2;32') : colorize('○', '2');
  const text = on ? extra : (label === 'Web UI' ? 'closed' : 'none connected');
  return `${label.padEnd(12)}${dot} ${text}`;
}

function buildPanel() {
  const uiCount = state.uiSubscribers.size;
  const overlayCount = overlayClientCount();

  const clips = clipStats;
  const configs = cfg.listConfigs();
  const serverRate = metrics.serverRatePerMin();   // also updates .peakPerMin as a side effect
  const twitchRate = metrics.twitchRatePerMin();

  const lines = [
    `${colorize('Project Elm', '1')} — dashboard`,
    `${statusLine('Web UI', uiCount, `open (${uiCount} tab${uiCount === 1 ? '' : 's'})`)} — http://localhost:${state.port}/`,
    statusLine('Overlay', overlayCount, `${overlayCount} connected`),
    `Twitch      ${authLine()}`,
    `Clips       ${clips.count} downloaded · ${humanSize(clips.bytes)} on disk`,
    `Configs     ${configs.length} saved`,
    '',
    ...overlayLines(),
    '',
    `Server  (browser ↔ server)   ${metrics.serverRequests.total} requests · ${serverRate}/min (peak ${metrics.serverRequests.peakPerMin}/min)`,
    `Twitch  (server ↔ twitch)    ${metrics.twitchCalls.total} calls · ${twitchRate}/min (peak ${metrics.twitchCalls.peakPerMin}/min) · ${humanSize(metrics.twitchBytes.total)} downloaded`,
  ];
  if (logLines.length) lines.push('', ...logLines);
  return lines;
}

function render() {
  try {
    const lines = buildPanel();
    if (lastLineCount > 0) process.stdout.write(`\x1b[${lastLineCount}A`);
    for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`);
    const extra = lastLineCount - lines.length;
    if (extra > 0) {
      for (let i = 0; i < extra; i++) process.stdout.write('\x1b[2K\n');
      process.stdout.write(`\x1b[${extra}A`);
    }
    lastLineCount = lines.length;
  } catch { /* a redraw hiccup must never take the server down — skip this frame */ }
}

/** Start the dashboard. `subscribers` is server.mjs's live config-id → Set<res>
 *  map (passed by reference so this always reflects the real connection state);
 *  `uiSubscribers` is the same idea for open curate-UI tabs; `getLogin` returns
 *  its in-memory device-login state. */
export function start({ port, subscribers, uiSubscribers, getLogin }) {
  state.port = port;
  if (subscribers) state.subscribers = subscribers;
  if (uiSubscribers) state.uiSubscribers = uiSubscribers;
  if (getLogin) state.getLogin = getLogin;

  if (!process.stdout.isTTY) {
    console.log(`\n  Project Elm — selection UI at http://localhost:${port}/`);
    if (!tw.CLIENT_ID) console.log('  ⚠ No TWITCH_CLIENT_ID (.env) — see README.md → Setup.');
    return;
  }

  panelActive = true;
  process.stdout.write('\x1b[?25l'); // hide cursor while the panel owns the screen
  // Restore the cursor on ANY exit path (SIGINT/SIGTERM below, but also SIGHUP,
  // an uncaught exception, etc.) — 'exit' fires for all of those, so this is the
  // one place that must run, not a per-signal special case.
  process.on('exit', () => {
    clearInterval(timer);
    clearInterval(clipStatsSafetyTimer);
    clearTimeout(clipStatsDebounce);
    if (clipStatsWatcher) clipStatsWatcher.close();
    process.stdout.write('\x1b[?25h\n');
  });
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  refreshClipStats();
  watchClipsDir();
  clipStatsSafetyTimer = setInterval(() => {
    refreshClipStats();
    if (!clipStatsWatcher) watchClipsDir();
  }, CLIP_STATS_SAFETY_MS);

  render();
  timer = setInterval(render, REFRESH_MS);
}
