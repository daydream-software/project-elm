/* =============================================================================
 * Project Elm — overlay player
 * Loads a saved configuration (?config=<id>) and chains its clips with a
 * double-buffered crossfade.
 *
 * Two stacked video layers (.layer):
 *   - the "front" layer (.front class, opacity 1) plays the current clip;
 *   - the "back" layer (opacity 0) preloads the next clip.
 * Near the end of the current clip, we start the next one and cross the opacities,
 * then swap the two layers' roles. No black gap between clips.
 *
 * Each clip is a direct MP4 played in a <video> (fully controlled transitions).
 * A per-clip safety timer forces the reel forward if a clip's MP4 is missing or
 * corrupt (so no timeupdate/ended ever fires) — the overlay never stalls on black.
 *
 * Two live features, no OBS source refresh ever required:
 *  - Live reload: an SSE connection re-fetches the configuration whenever it's
 *    saved elsewhere and hot-swaps the upcoming play order (applyLive below) —
 *    the clip currently on screen is never interrupted.
 *  - OBS visibility: the `obsSourceActiveChanged` event (built into every OBS
 *    Browser Source, see github.com/obsproject/obs-browser) tells us when this
 *    source goes off/on program. Off program, we pause AND rewind to clip 1, so
 *    the reel always resumes clean instead of mid-clip. This requires "Shutdown
 *    source when not visible" to be OFF in the source's properties — with it on,
 *    OBS reloads the page instead, which is the hard refresh this avoids.
 *
 * Debugging inside OBS: open this overlay's URL with `&debug=1` appended (e.g. as
 * a temporary second Browser Source, or in a normal Chrome tab) to show a small
 * on-screen HUD with live SSE / OBS-event / video state — there is no console to
 * read otherwise. For real devtools on the actual OBS-rendered page, launch OBS
 * with `--remote-debugging-port=9222` and open chrome://inspect in a normal Chrome.
 * ========================================================================== */

/**
 * @typedef {object} Clip
 * @property {string} mp4 - URL of the downloaded clip file.
 * @property {string} [title]
 * @property {string} [game]
 * @property {string} [broadcaster]
 * @property {number} [duration] - Seconds; used only as a fallback for the safety timer.
 */

/**
 * @typedef {object} PlayerSettings
 * @property {'random'|'sequential'} order
 * @property {boolean} loop
 * @property {number} transitionMs
 * @property {boolean} showTitle
 * @property {boolean} [showGame]
 * @property {boolean} [showBroadcaster]
 * @property {boolean} muted
 */

const DEFAULTS = {
  order: 'random',       // 'random' | 'sequential'
  loop: true,
  transitionMs: 600,
  showTitle: true,
  muted: false,
};

const els = {
  layerEls: [document.getElementById('layer-a'), document.getElementById('layer-b')],
  lowerThird: document.getElementById('lower-third'),
  ltTitle: document.querySelector('#lower-third .lt-title'),
  ltMeta: document.querySelector('#lower-third .lt-meta'),
  startGate: document.getElementById('start-gate'),
  message: document.getElementById('message'),
};

/** Show the on-screen status message (e.g. "no clips yet", a load error). */
function showMessage(text) {
  els.message.textContent = text;
  els.message.hidden = false;
}
/** Hide the on-screen status message. */
function hideMessage() { els.message.hidden = true; }

/**
 * Fisher–Yates shuffle (copy, does not mutate the input).
 *
 * @param {Clip[]} arr
 * @returns {Clip[]} A new, shuffled array.
 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Wrap a `.layer` DOM element into the small state object the {@link Player} tracks
 * per layer.
 *
 * @param {HTMLElement} el
 * @returns {{el: HTMLElement, video: HTMLVideoElement, clip: ?Clip, timer: ?number}}
 */
function makeLayer(el) {
  return {
    el,
    video: el.querySelector('.clip-video'),
    clip: null,
    timer: null,   // safety advance timer (fires only if the video's own events don't)
  };
}

/** Plays a configuration's clips back-to-back with a double-buffered crossfade. */
class Player {
  /**
   * @param {Clip[]} order - Initial play order.
   * @param {PlayerSettings} settings
   */
  constructor(order, settings) {
    this.order = order;
    this.settings = settings;
    this.pos = 0;              // index (in this.order) of the "front" clip
    this.transitioning = false;
    this.suspended = false;    // true while off-program (OBS source inactive)
    this.pendingOrder = null;  // a freshly-fetched order, applied at the next loop wrap
    this.layers = els.layerEls.map(makeLayer);
    this.front = this.layers[0];
    this.back = this.layers[1];
    this.transitionSec = settings.transitionMs / 1000;

    // Listeners on each <video>, guarded by state checks. Kept so stop() can remove
    // them — the DOM's <video> elements are shared/reused across Player instances
    // (a configuration can go empty then get clips again over one page's lifetime,
    // see main()'s applyFetched), and a dead instance's listeners would otherwise
    // keep firing on the live video and fight the new instance for the same DOM.
    this._listeners = this.layers.map(layer => {
      const onTime = () => this.onTimeUpdate(layer);
      const onEnd = () => this.onEnded(layer);
      const onErr = () => this.onVideoError(layer);
      layer.video.addEventListener('timeupdate', onTime);
      layer.video.addEventListener('ended', onEnd);
      layer.video.addEventListener('error', onErr);
      return { layer, onTime, onEnd, onErr };
    });
  }

  /** Prepare and start the first clip, and preload the second into the back layer. */
  async start() {
    document.documentElement.style.setProperty('--transition-ms', this.settings.transitionMs + 'ms');
    this.prepare(this.front, this.order[0]);
    this.front.el.classList.add('front');
    await this.startLayer(this.front, /* firstPlay */ true);
    this.updateLowerThird(this.front.clip);
    // Preload the next clip into the back layer.
    if (this.order.length > 1 || this.settings.loop) {
      this.prepare(this.back, this.order[(1) % this.order.length]);
    }
  }

  /**
   * Prepare a layer for a clip WITHOUT making it visible (preload the <video>).
   *
   * @param {ReturnType<typeof makeLayer>} layer
   * @param {Clip} clip
   */
  prepare(layer, clip) {
    layer.clip = clip;
    if (layer.timer) { clearTimeout(layer.timer); layer.timer = null; }
    layer.video.muted = this.settings.muted;
    layer.video.src = clip.mp4;
    layer.video.load();
  }

  /**
   * Start playback of an already-prepared layer.
   *
   * @param {ReturnType<typeof makeLayer>} layer
   * @param {boolean} [firstPlay=false] - True for the very first clip on page load,
   *   where autoplay may be blocked pending a user gesture.
   */
  async startLayer(layer, firstPlay = false) {
    const ok = await this.tryPlay(layer.video);
    if (!ok && firstPlay) {
      // Autoplay blocked on the first clip (a normal browser tab) → wait for a
      // click; don't arm the safety timer or we'd skip the clip before it starts.
      this.showGate(async () => { if (await this.tryPlay(layer.video)) this.armSafetyTimer(layer); });
      return;
    }
    // Playing — or a promoted clip whose MP4 is broken and won't play. Either way,
    // arm the safety net so a clip that never fires timeupdate/ended still advances.
    this.armSafetyTimer(layer);
  }

  /**
   * @param {HTMLVideoElement} video
   * @returns {Promise<boolean>} Whether playback actually started.
   */
  async tryPlay(video) {
    try { await video.play(); return true; }
    catch (_) { return false; }
  }

  /**
   * Fallback advance: if a clip never fires timeupdate/ended (missing or corrupt
   * MP4), force the transition shortly after its expected duration so the reel
   * never stalls on a black frame. Healthy clips transition via onTimeUpdate first.
   *
   * @param {ReturnType<typeof makeLayer>} layer
   */
  armSafetyTimer(layer) {
    if (layer.timer) clearTimeout(layer.timer);
    const dur = Number(layer.clip.duration) || 30;
    const ms = Math.max(500, (dur + 1) * 1000);
    layer.timer = setTimeout(() => {
      if (this.front === layer && !this.transitioning) this.beginTransition();
    }, ms);
  }

  /** `timeupdate` handler: begins the crossfade once within `transitionSec` of the end. */
  onTimeUpdate(layer) {
    if (layer !== this.front || this.transitioning || this.suspended) return;
    const v = layer.video;
    if (!isFinite(v.duration)) return;
    if (v.duration - v.currentTime <= this.transitionSec) this.beginTransition();
  }

  /** `ended` handler — safety net for a clip shorter than the transition, or unknown duration. */
  onEnded(layer) {
    if (layer === this.front && !this.transitioning && !this.suspended) this.beginTransition();
  }

  /**
   * `error` handler. The MP4 broke. If it's on screen, skip past it now; a broken
   * preload on the back layer is caught by its safety timer once it becomes the front.
   */
  onVideoError(layer) {
    if (layer === this.front && !this.transitioning && !this.suspended) this.beginTransition();
  }

  /** Start crossfading from the front layer to the (already-preloaded) back layer. */
  beginTransition() {
    if (this.transitioning || this.suspended) return;
    this.transitioning = true;

    let nextPos = this.pos + 1;
    if (nextPos >= this.order.length) {
      if (this.settings.loop) nextPos = 0; // `back` already holds order[0] (see finalize)
      else { this.finishEnd(); return; }
    }

    const from = this.front, to = this.back;
    // Invariant: `to` has already been prepared with order[nextPos]. Safety if not.
    if (to.clip !== this.order[nextPos]) this.prepare(to, this.order[nextPos]);

    this.startLayer(to);
    this.updateLowerThird(to.clip);

    // Crossfade: back fades in, front fades out.
    to.el.classList.add('front');
    from.el.classList.remove('front');

    setTimeout(() => this.finalize(from, to, nextPos), this.settings.transitionMs);
  }

  /**
   * Complete a crossfade: pause/clean up the old front layer, promote the new one,
   * and preload whatever comes after it.
   *
   * @param {ReturnType<typeof makeLayer>} from - The layer that was on screen.
   * @param {ReturnType<typeof makeLayer>} to - The layer now on screen.
   * @param {number} nextPos - `this.order` index `to` now represents.
   */
  finalize(from, to, nextPos) {
    from.video.pause();
    if (from.timer) { clearTimeout(from.timer); from.timer = null; }
    from.el.classList.remove('front');

    this.front = to;
    this.back = from;
    this.pos = nextPos;
    this.transitioning = false;

    // Preload the next clip into the freed layer.
    const followPos = this.pos + 1;
    if (followPos < this.order.length) {
      this.prepare(this.back, this.order[followPos]);
    } else if (this.settings.loop) {
      // Wrap point: a live-reloaded order (see applyLive) takes over here — the
      // natural point to switch playlists without ever interrupting a clip that's
      // already on screen. Otherwise, for random, reshuffle for the next cycle
      // (avoiding an immediate repeat of the clip currently playing) BEFORE
      // preloading its first clip — keeps the loop seamless AND varies the order
      // each cycle, so a random reel never replays the same sequence.
      if (this.pendingOrder) { this.order = this.pendingOrder; this.pendingOrder = null; this.pos = -1; }
      else if (this.settings.order === 'random') this.reshuffleAvoiding(this.front.clip);
      this.prepare(this.back, this.order[0]);
    }
  }

  /**
   * Hot-swap in a freshly-fetched configuration (SSE live reload). Never touches
   * what's currently on screen: while playing, the new order is staged and takes
   * over at the next loop wrap (see finalize); while suspended (OBS source off
   * program), it's safe to apply immediately since nothing is visible anyway.
   *
   * @param {PlayerSettings} settings
   * @param {Clip[]} clips
   */
  applyLive(settings, clips) {
    this.settings = { ...this.settings, ...settings };
    this.transitionSec = this.settings.transitionMs / 1000;
    document.documentElement.style.setProperty('--transition-ms', this.settings.transitionMs + 'ms');
    // Cosmetic toggles (title/game/channel) apply to the clip already on screen right away.
    this.updateLowerThird(this.front.clip);
    const freshOrder = this.settings.order === 'sequential' ? clips.slice() : shuffle(clips);
    // main()'s applyFetched calls stop() instead of applyLive() once clips drops to
    // zero — this is just a defensive fallback if applyLive is ever called directly.
    if (!freshOrder.length) return;
    if (this.suspended) { this.order = freshOrder; this.resetToStart(); }
    else this.pendingOrder = freshOrder;
  }

  /**
   * Pause both layers and rewind to clip 1 — used when the OBS source goes off
   * program, so it resumes clean (see resume()) instead of mid-clip.
   */
  suspend() {
    if (this.suspended) return;
    this.suspended = true;
    for (const layer of this.layers) {
      layer.video.pause();
      if (layer.timer) { clearTimeout(layer.timer); layer.timer = null; }
    }
    this.resetToStart();
  }

  /** Rewind state to clip 1 (front) with clip 2 preloaded (back), without touching playback. */
  resetToStart() {
    if (this.pendingOrder) { this.order = this.pendingOrder; this.pendingOrder = null; }
    this.pos = 0;
    this.transitioning = false;
    this.prepare(this.front, this.order[0]);
    this.front.el.classList.add('front');
    this.back.el.classList.remove('front');
    this.updateLowerThird(this.order[0]);
    if (this.order.length > 1 || this.settings.loop) this.prepare(this.back, this.order[1 % this.order.length]);
  }

  /**
   * Back on program: play from the rewound clip 1 (autoplay-gated the same way a
   * fresh page load would be, in case a plain browser tab is previewing this).
   */
  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.startLayer(this.front, /* firstPlay */ true);
  }

  /**
   * Tear down completely — used when a live-reloaded configuration drops to zero
   * downloaded clips (see main()'s applyFetched). Removes this instance's video
   * listeners so a later Player built for the same DOM (once clips come back)
   * doesn't fight a zombie instance still reacting to the shared <video> elements.
   */
  stop() {
    this.suspended = true;   // belt-and-suspenders: inert even if a listener fires mid-teardown
    for (const { layer, onTime, onEnd, onErr } of this._listeners) {
      layer.video.removeEventListener('timeupdate', onTime);
      layer.video.removeEventListener('ended', onEnd);
      layer.video.removeEventListener('error', onErr);
      layer.video.pause();
      if (layer.timer) { clearTimeout(layer.timer); layer.timer = null; }
    }
    this.front.el.classList.remove('front');
    this.back.el.classList.remove('front');
    els.lowerThird.classList.remove('show');
  }

  /**
   * Reshuffle `this.order`, retrying until the first clip isn't `avoidClip` — avoids
   * an immediate repeat when a random reel wraps back to its own start.
   *
   * @param {Clip} avoidClip
   */
  reshuffleAvoiding(avoidClip) {
    let arr;
    do { arr = shuffle(this.order); } while (arr.length > 1 && arr[0] === avoidClip);
    this.order = arr;
  }

  /** End of playlist without loop: fade to black on the last clip. */
  finishEnd() {
    this.front.el.classList.remove('front');
    els.lowerThird.classList.remove('show');
  }

  /**
   * Update the lower-third title/meta text for a clip, per the current toggle settings.
   *
   * @param {?Clip} clip
   */
  updateLowerThird(clip) {
    const s = this.settings;
    if (!s.showTitle || !clip) { els.lowerThird.classList.remove('show'); return; }
    els.ltTitle.textContent = clip.title || '';
    const parts = [];
    if (s.showGame !== false && clip.game) parts.push(clip.game);
    if (s.showBroadcaster !== false && clip.broadcaster) parts.push(clip.broadcaster);
    const meta = parts.join(' · ');
    els.ltMeta.textContent = meta;
    els.lowerThird.classList.toggle('show', !!(clip.title || meta));
  }

  /**
   * Show the "click to start" gate (for blocked autoplay) and run `onClick` once
   * the user clicks it.
   *
   * @param {() => void} onClick
   */
  showGate(onClick) {
    els.startGate.hidden = false;
    els.startGate.addEventListener('click', () => {
      els.startGate.hidden = true;
      onClick();
    }, { once: true });
  }
}

/**
 * Fetch a configuration's resolved playlist from the server.
 *
 * @param {string} configId
 * @returns {Promise<{settings: object, clips: Clip[]}>}
 * @throws {Error} On a non-OK response.
 */
async function fetchPlaylist(configId) {
  const res = await fetch(`/api/configs/${encodeURIComponent(configId)}/playlist`, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/**
 * On-screen debug HUD (opt-in via ?debug=1 — see the header comment). There's no
 * console to read on the actual page OBS renders, so this surfaces the three things
 * worth checking live: is the SSE connection up, has an OBS visibility event ever
 * arrived, and what's the real <video> state right now (which may differ from what
 * OBS is visually compositing for an off-program source — OBS can stop requesting
 * frames from a source that isn't on program or preview, so its output can look
 * "frozen" even though the underlying page state already moved on).
 *
 * @returns {{sse: string, sseAt: ?Date, obs: string, obsAt: ?Date}} Mutable state the
 *   caller updates as SSE/OBS events arrive; rendered into the HUD every 300ms.
 */
function initDebugHud() {
  const hud = document.createElement('div');
  hud.id = 'debug-hud';
  hud.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;max-width:70vw;'
    + 'background:rgba(0,0,0,.78);color:#7bffcf;font:12px/1.5 monospace;padding:8px 12px;'
    + 'border-radius:6px;white-space:pre-wrap;pointer-events:none;';
  document.body.appendChild(hud);
  const state = { sse: 'connecting…', sseAt: null, obs: 'none received yet', obsAt: null };
  const fmt = (d) => d ? d.toLocaleTimeString() : '';
  setInterval(() => {
    const v = document.querySelector('.layer.front .clip-video');
    hud.textContent =
      `SSE: ${state.sse}${state.sseAt ? '  (last update ' + fmt(state.sseAt) + ')' : ''}\n`
      + `obsSourceActiveChanged: ${state.obs}${state.obsAt ? '  (' + fmt(state.obsAt) + ')' : ''}\n`
      + `video: ${v ? (v.paused ? 'paused' : 'playing') + ' @ ' + v.currentTime.toFixed(1) + 's — ' + (v.src.split('/').pop()) : 'n/a'}`;
  }, 300);
  return state;
}

/**
 * Entry point: reads `?config=<id>` (and `?debug=1`), loads the configuration,
 * starts the {@link Player}, and wires up live reload (SSE) + OBS visibility events.
 */
async function main() {
  // A saved configuration's overlay URL, e.g. /overlay/?config=<id> — copy that
  // from the "Open overlay" button in the selection UI into an OBS Browser Source.
  const params = new URLSearchParams(location.search);
  const configId = params.get('config');
  if (!configId) {
    showMessage('Missing ?config=<id> — open this overlay from a saved configuration in the selection UI.');
    return;
  }
  const debugState = params.has('debug') ? initDebugHud() : null;

  let player = null;   // null while the configuration has no downloaded clips

  /**
   * Apply a freshly-fetched playlist: creates the {@link Player} on first load,
   * hot-swaps it on subsequent (SSE-triggered) calls, and tears it down if the
   * configuration has no downloaded clips.
   *
   * @param {{settings?: object, clips?: Clip[]}} data
   */
  async function applyFetched(data) {
    const settings = { ...DEFAULTS, ...(data.settings || {}) };
    const clips = (data.clips || []).filter(c => c && c.mp4);
    if (!clips.length) {
      if (player) { player.stop(); player = null; }
      showMessage('This configuration has no clips yet.');
      return;
    }
    hideMessage();
    if (!player) {
      const order = settings.order === 'sequential' ? clips.slice() : shuffle(clips);
      player = new Player(order, settings);
      await player.start();
    } else {
      player.applyLive(settings, clips);
    }
  }

  let data;
  try { data = await fetchPlaylist(configId); }
  catch (e) { showMessage('Could not load configuration "' + configId + '" — ' + e.message); return; }
  await applyFetched(data);

  // Live reload: whenever the configuration is saved elsewhere (including dropping
  // to / growing back from zero downloaded clips), re-fetch and hot-swap without
  // ever refreshing this page.
  const es = new EventSource(`/api/events?config=${encodeURIComponent(configId)}`);
  if (debugState) {
    es.onopen = () => { debugState.sse = 'connected'; };
    es.onerror = () => { debugState.sse = 'error / reconnecting…'; };
  }
  es.onmessage = async () => {
    if (debugState) { debugState.sse = 'connected'; debugState.sseAt = new Date(); }
    try { await applyFetched(await fetchPlaylist(configId)); }
    catch (_) { /* config deleted, or a transient hiccup — keep playing what we have */ }
  };

  // OBS Browser Source visibility (built into OBS — see the header comment above):
  // pause + rewind while this source is off program, resume clean when it's back.
  window.addEventListener('obsSourceActiveChanged', (e) => {
    const active = !!(e.detail && e.detail.active);
    if (debugState) { debugState.obs = active ? 'active=true' : 'active=false'; debugState.obsAt = new Date(); }
    if (!player) return;   // no reel loaded right now — nothing to suspend/resume
    if (active) player.resume(); else player.suspend();
  });
}

main();
