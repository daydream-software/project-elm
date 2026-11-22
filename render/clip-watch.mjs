/**
 * Watch the downloaded-clips directory for MP4s added, replaced, edited in place or
 * removed OUTSIDE the app (e.g. someone trims a downloaded clip in a video editor and
 * saves over it), and report which clip ids changed, so live overlays can be told to
 * re-fetch their playlist (whose clip URLs are versioned by mtime + size — see
 * twitch.mjs clipUrl).
 *
 * Debounced: an editor's save is many writes (or a temp file + rename), so changes
 * are reported once the directory has been quiet for SETTLE_MS. fs.watch can
 * occasionally miss an event (a documented Node caveat); the cost is only that the
 * overlay picks the edit up at its next playlist re-fetch (any config save) instead.
 */
import fs from 'node:fs';
import { CLIPS_DIR } from './twitch.mjs';

const SETTLE_MS = 1500;     // quiet period after the last write before reporting
const RETRY_MS = 10_000;    // re-arm delay while realclips/ is missing or the watcher died
const CLIP_FILE = /^([A-Za-z0-9_-]+)\.mp4$/;   // `<id>.mp4` only — not thumbs, temp files, manifests

/**
 * Start watching `CLIPS_DIR`. Survives the directory not existing yet (before the
 * first download) or being deleted and recreated: it re-arms every RETRY_MS until it
 * can watch again.
 *
 * @param {(ids: ?string[]) => void} onChange - Called with the changed clip ids, or
 *   `null` when it can't say which (the platform reported no filename, or the directory
 *   went unwatched for a while) — treat that as "any clip may have changed".
 * @returns {() => void} Stops watching.
 */
export function watchClips(onChange) {
  let watcher = null;
  let settleTimer = null;
  let retryTimer = null;
  let unknownFile = false;
  let unwatchedGap = false;   // the watcher was lost: the next successful arm() must report
  const pending = new Set();

  const flush = () => {
    settleTimer = null;
    const ids = unknownFile ? null : [...pending];
    pending.clear();
    unknownFile = false;
    onChange(ids);
  };

  const scheduleFlush = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(flush, SETTLE_MS);
  };

  const scheduleRetry = () => {
    retryTimer = setTimeout(arm, RETRY_MS);
    retryTimer.unref();
  };

  // The watcher is dead (directory deleted, or an fs error): drop it and keep retrying.
  // Anything may change while nothing is watching, so the re-arm reports an unknown change.
  const lose = () => {
    if (!watcher) return;
    watcher.close();
    watcher = null;
    unwatchedGap = true;
    scheduleRetry();
  };

  const onEvent = (_eventType, filename) => {
    if (filename == null) {
      unknownFile = true;
      scheduleFlush();
      return;
    }
    const m = CLIP_FILE.exec(String(filename));
    if (m) {
      pending.add(m[1]);
      scheduleFlush();
      return;
    }
    // Linux reports the deletion of the watched directory itself as a 'rename' of its
    // own name and then goes silent — no 'error', no 'close' — so check for that here.
    if (!fs.existsSync(CLIPS_DIR)) lose();
  };

  function arm() {
    retryTimer = null;
    try {
      watcher = fs.watch(CLIPS_DIR, onEvent);
    } catch {
      scheduleRetry();   // realclips/ doesn't exist (yet, or any more)
      return;
    }
    watcher.on('error', lose);
    if (unwatchedGap) {   // re-armed after a gap: report it
      unwatchedGap = false;
      unknownFile = true;
      scheduleFlush();
    }
  }

  arm();
  return () => {
    clearTimeout(settleTimer);
    clearTimeout(retryTimer);
    if (watcher) watcher.close();
  };
}
