#!/usr/bin/env node
/* =============================================================================
 * render-reel — stitch clip MP4s into one reel with crossfade transitions.
 *
 *   node render-reel.mjs <manifest.json>
 *
 * It normalizes heterogeneous clips (any resolution/fps) onto a common canvas,
 * burns an optional title lower-third per clip, then chains them with a video
 * crossfade (xfade) + audio crossfade (acrossfade) into a single MP4 that plays
 * anywhere (e.g. as an OBS Media Source: native autoplay + sound, no embed).
 *
 * ffmpeg/ffprobe are taken from $FFMPEG / $FFPROBE, else from PATH.
 *
 * Manifest (see manifest.example.json):
 * {
 *   "output": "reel.mp4",
 *   "width": 1920, "height": 1080, "fps": 30,
 *   "transition": "fade",        // any xfade type: fade, wipeleft, slideup, circleopen, dissolve…
 *   "transitionMs": 800,
 *   "showTitles": true,
 *   "fontfile": "/path/to.ttf",  // optional; auto-detected otherwise
 *   "clips": [ { "file": "a.mp4", "title": "Clutch", "game": "Valorant" }, "b.mp4" ]
 * }
 * ========================================================================== */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { die } from './cli-util.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_CANDIDATES = [
  path.join(HERE, '..', 'fonts', 'Geist-Bold.ttf'),   // bundled Geist — matches the web UI / overlay
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
];

/** Run a binary and return its stdout as a string, throwing on a non-zero exit. */
const sh = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
/** Run ffmpeg (quiet, always overwriting output), dying with a friendly message on failure. */
const ff = (args) => {
  try { execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] }); }
  catch { die('ffmpeg failed (see the error above).' + (FFMPEG === 'ffmpeg' ? ' Is ffmpeg on your PATH? Otherwise set FFMPEG/FFPROBE.' : '')); }
};

/** Probe a media file's duration in seconds (via ffprobe). */
function probeDuration(file) {
  return parseFloat(sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file]).trim());
}
/** Whether a media file has an audio stream (via ffprobe). */
function probeHasAudio(file) {
  return sh(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).includes('audio');
}
/** Whether the ffmpeg binary in use has a given filter compiled in (e.g. `'drawtext'`, which needs libfreetype). */
function hasFilter(name) {
  try { return sh(FFMPEG, ['-hide_banner', '-filters']).includes(name); } catch { return false; }
}

/* ---- Load + validate manifest ---- */
const manifestPath = process.argv[2];
if (!manifestPath) die('Usage: render-reel.mjs <manifest.json>');
const cfg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const baseDir = path.dirname(path.resolve(manifestPath));

const W = cfg.width || 1920, H = cfg.height || 1080, FPS = cfg.fps || 30;
const TRANSITION = cfg.transition || 'fade';
const OUT = path.resolve(baseDir, cfg.output || 'reel.mp4');
const font = cfg.fontfile || FONT_CANDIDATES.find(f => fs.existsSync(f)) || null;
const showTitles = cfg.showTitles !== false && !!font && hasFilter('drawtext');
if (cfg.showTitles !== false && !showTitles) {
  console.warn('⚠ titles disabled — ' + (!font ? 'no font found' : 'this ffmpeg lacks the drawtext filter (needs libfreetype)') + '.');
}

const clips = (cfg.clips || [])
  .map(c => (typeof c === 'string' ? { file: c } : c))
  .map(c => ({ ...c, path: path.resolve(baseDir, c.file) }));
if (!clips.length) die('manifest has no clips.');
for (const c of clips) if (!fs.existsSync(c.path)) die('clip not found: ' + c.path);

/* ---- Probe durations, clamp transition to fit the shortest clip ---- */
for (const c of clips) { c.dur = probeDuration(c.path); c.hasAudio = probeHasAudio(c.path); }
let T = (cfg.transitionMs ?? 800) / 1000;
const minDur = Math.min(...clips.map(c => c.dur));
if (clips.length > 1 && T > minDur * 0.5) {
  T = Math.max(0.2, minDur * 0.5 - 0.05);
  console.warn(`⚠ transition shortened to ${T.toFixed(2)}s (shortest clip ${minDur.toFixed(1)}s).`);
}

console.log(`reel: ${clips.length} clips → ${OUT}`);
console.log(`canvas ${W}x${H}@${FPS} · transition "${TRANSITION}" ${(T * 1000) | 0}ms · titles ${showTitles ? 'on' : 'off'} · loudness ${cfg.normalizeAudio === false ? 'off' : (cfg.targetLUFS ?? -16) + ' LUFS'}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));

/* ---- 1) Normalize each clip (letterbox to canvas, constant fps, stereo audio,
 *         optional title lower-third burned into the clip's first 4 s). ---- */
/**
 * Build a `drawtext` filter string burning a clip's title into its first 4s, or
 * `null` if titles are disabled/unavailable/this clip has none.
 *
 * @param {{title?: string}} c - Clip entry from the manifest.
 * @param {number} i - Clip index (used to name its title textfile uniquely).
 * @returns {?string}
 */
function titleFilter(c, i) {
  if (!showTitles || !font || !c.title) return null;
  const tf = path.join(work, `title-${i}.txt`);
  fs.writeFileSync(tf, String(c.title));               // textfile avoids escaping hell
  const fs2 = Math.round(H / 22);
  // enable=lt(t,4): show for the first 4 s only (well before the end-of-clip xfade).
  return `drawtext=fontfile=${font}:textfile=${tf}:fontcolor=white:fontsize=${fs2}`
       + `:box=1:boxcolor=black@0.55:boxborderw=22:borderw=2:bordercolor=black:x=64:y=h-th-72:enable=lt(t\\,4)`;
}

clips.forEach((c, i) => {
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1', `fps=${FPS}`, 'format=yuv420p',
    titleFilter(c, i),
  ].filter(Boolean).join(',');

  c.norm = path.join(work, `n${i}.mp4`);
  // Per-clip loudness normalization: real clips vary wildly in volume; loudnorm
  // brings each to a consistent target so no clip blares or whispers. (Single-pass.)
  const loud = cfg.normalizeAudio === false ? [] : ['-af', `loudnorm=I=${cfg.targetLUFS ?? -16}:TP=-1.5:LRA=11`];
  const venc = ['-c:v', 'libx264', '-preset', 'veryfast'];
  const aenc = ['-c:a', 'aac', '-ar', '48000', '-ac', '2'];
  if (c.hasAudio) {
    ff(['-i', c.path, '-vf', vf, ...loud, ...venc, ...aenc, c.norm]);
  } else {
    ff(['-i', c.path, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest', '-vf', vf, ...venc, ...aenc, c.norm]);
  }
  process.stdout.write(`  normalized ${i + 1}/${clips.length}\r`);
});
console.log('\n  normalized all clips');

/* ---- 2) Build the xfade (video) + acrossfade (audio) chain ---- */
if (clips.length === 1) {
  fs.copyFileSync(clips[0].norm, OUT);
} else {
  const inputs = clips.flatMap(c => ['-i', c.norm]);
  const vParts = [], aParts = [];
  let acc = clips[0].dur, vPrev = '0:v', aPrev = '0:a';
  for (let i = 1; i < clips.length; i++) {
    const offset = (acc - T).toFixed(3);
    const vOut = i === clips.length - 1 ? 'v' : `v${i}`;
    const aOut = i === clips.length - 1 ? 'a' : `a${i}`;
    const tr = clips[i].transition || TRANSITION;   // per-cut transition (into clip i), else global
    vParts.push(`[${vPrev}][${i}:v]xfade=transition=${tr}:duration=${T}:offset=${offset}[${vOut}]`);
    aParts.push(`[${aPrev}][${i}:a]acrossfade=d=${T}[${aOut}]`);
    vPrev = vOut; aPrev = aOut;
    acc += clips[i].dur - T;
  }
  const filter = [...vParts, ...aParts].join(';');
  ff([...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', OUT]);
}

/* ---- 3) Report + cleanup ---- */
const dur = probeDuration(OUT);
const size = (fs.statSync(OUT).size / 1e6).toFixed(1);
fs.rmSync(work, { recursive: true, force: true });
console.log(`✓ ${OUT} — ${dur.toFixed(1)}s, ${size} MB`);
