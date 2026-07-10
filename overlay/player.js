/* =============================================================================
 * Project Elm — overlay player
 * Reads playlist.json and chains clips together with a double-buffered crossfade.
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
 * ========================================================================== */

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

function showMessage(text) {
  els.message.textContent = text;
  els.message.hidden = false;
}

/* Fisher–Yates shuffle (copy, does not mutate the input). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeLayer(el) {
  return {
    el,
    video: el.querySelector('.clip-video'),
    clip: null,
    timer: null,   // safety advance timer (fires only if the video's own events don't)
  };
}

class Player {
  constructor(order, settings) {
    this.order = order;
    this.settings = settings;
    this.pos = 0;              // index (in this.order) of the "front" clip
    this.transitioning = false;
    this.layers = els.layerEls.map(makeLayer);
    this.front = this.layers[0];
    this.back = this.layers[1];
    this.transitionSec = settings.transitionMs / 1000;

    // Permanent listeners on each <video>, guarded by state checks.
    for (const layer of this.layers) {
      layer.video.addEventListener('timeupdate', () => this.onTimeUpdate(layer));
      layer.video.addEventListener('ended', () => this.onEnded(layer));
      layer.video.addEventListener('error', () => this.onVideoError(layer));
    }
  }

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

  /* Prepare a layer for a clip WITHOUT making it visible (preload the <video>). */
  prepare(layer, clip) {
    layer.clip = clip;
    if (layer.timer) { clearTimeout(layer.timer); layer.timer = null; }
    layer.video.muted = this.settings.muted;
    layer.video.src = clip.mp4;
    layer.video.load();
  }

  /* Start playback of a (already prepared) layer. */
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

  async tryPlay(video) {
    try { await video.play(); return true; }
    catch (_) { return false; }
  }

  /* Fallback advance: if a clip never fires timeupdate/ended (missing or corrupt
   * MP4), force the transition shortly after its expected duration so the reel
   * never stalls on a black frame. Healthy clips transition via onTimeUpdate first. */
  armSafetyTimer(layer) {
    if (layer.timer) clearTimeout(layer.timer);
    const dur = Number(layer.clip.duration) || 30;
    const ms = Math.max(500, (dur + 1) * 1000);
    layer.timer = setTimeout(() => {
      if (this.front === layer && !this.transitioning) this.beginTransition();
    }, ms);
  }

  onTimeUpdate(layer) {
    if (layer !== this.front || this.transitioning) return;
    const v = layer.video;
    if (!isFinite(v.duration)) return;
    if (v.duration - v.currentTime <= this.transitionSec) this.beginTransition();
  }

  onEnded(layer) {
    // Safety net: clip shorter than the transition, or unknown duration.
    if (layer === this.front && !this.transitioning) this.beginTransition();
  }

  onVideoError(layer) {
    // The MP4 broke. If it's on screen, skip past it now; a broken preload on the
    // back layer is caught by its safety timer once it becomes the front.
    if (layer === this.front && !this.transitioning) this.beginTransition();
  }

  beginTransition() {
    if (this.transitioning) return;
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
      // Wrap point: for random, reshuffle the whole playlist for the next cycle
      // (avoiding an immediate repeat of the clip currently playing) BEFORE
      // preloading its first clip — keeps the loop seamless AND varies the order
      // each cycle, so a random reel never replays the same sequence.
      if (this.settings.order === 'random') this.reshuffleAvoiding(this.front.clip);
      this.prepare(this.back, this.order[0]);
    }
  }

  reshuffleAvoiding(avoidClip) {
    let arr;
    do { arr = shuffle(this.order); } while (arr.length > 1 && arr[0] === avoidClip);
    this.order = arr;
  }

  finishEnd() {
    // End of playlist without loop: fade to black on the last clip.
    this.front.el.classList.remove('front');
    els.lowerThird.classList.remove('show');
  }

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

  showGate(onClick) {
    els.startGate.hidden = false;
    els.startGate.addEventListener('click', () => {
      els.startGate.hidden = true;
      onClick();
    }, { once: true });
  }
}

async function main() {
  // playlist.json lives at the project root; the overlay is served from /overlay/.
  // Overridable via ?playlist=... (path relative to the page).
  const playlistUrl = new URLSearchParams(location.search).get('playlist') || '../playlist.json';
  let data;
  try {
    const res = await fetch(playlistUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    showMessage('Could not load ' + playlistUrl + ' — serve the overlay over http (node server.mjs). ' + e.message);
    return;
  }

  const settings = { ...DEFAULTS, ...(data.settings || {}) };
  const clips = (data.clips || []).filter(c => c && c.mp4);
  if (!clips.length) {
    showMessage('playlist.json has no playable clips (needs an "mp4" field).');
    return;
  }

  const order = settings.order === 'sequential' ? clips.slice() : shuffle(clips);
  new Player(order, settings).start();
}

main();
