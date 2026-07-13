/* =============================================================================
 * metrics.mjs — tiny in-memory activity counters for the CLI dashboard
 * (dashboard.mjs). Two independent channels: browser↔server (HTTP requests
 * this server receives) and server↔twitch (Helix/OAuth calls + clip download
 * bytes, the actual heavy transfer). Nothing here is persisted — it resets
 * whenever the server restarts, which is fine, it's a live "what's happening
 * right now" view, not an audit log.
 * ========================================================================== */

const RATE_WINDOW_MS = 60_000;   // "per minute" window for the rolling rate

/**
 * @typedef {object} Counter
 * @property {number} total - Lifetime count since the server started.
 * @property {number[]} timestamps - Timestamps within the last {@link RATE_WINDOW_MS}.
 * @property {number} peakPerMin - Highest per-minute rate observed so far.
 */

/** @returns {Counter} A fresh, empty counter. */
function makeCounter() {
  return { total: 0, timestamps: [], peakPerMin: 0 };
}
/** Drop timestamps older than the rolling rate window. */
function trim(counter) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  while (counter.timestamps.length && counter.timestamps[0] < cutoff) counter.timestamps.shift();
}
/** Record one event on a counter (increments `total`, timestamps it, trims the window). */
function bump(counter) {
  counter.total++;
  counter.timestamps.push(Date.now());
  trim(counter);
}
// Sampled once per dashboard render tick (~1s) rather than continuously, but
// that's enough resolution to catch any burst lasting more than a second —
// `peakPerMin` then keeps that high-water mark visible long after the burst
// itself has scrolled out of the 60s window, so a spike from hours ago isn't
// silently lost the next time someone looks at the panel.
/**
 * Current events-per-minute rate for a counter, updating its `peakPerMin`
 * high-water mark as a side effect.
 *
 * @param {Counter} counter
 * @returns {number}
 */
function ratePerMin(counter) {
  trim(counter);
  const rate = counter.timestamps.length;
  if (rate > counter.peakPerMin) counter.peakPerMin = rate;
  return rate;
}

/** Browser ↔ server HTTP request counter. */
export const serverRequests = makeCounter();
/** Server ↔ Twitch (Helix/OAuth) call counter. */
export const twitchCalls = makeCounter();
/** Total bytes downloaded from Twitch (clip downloads). Not rate-windowed, lifetime only. */
export const twitchBytes = { total: 0 };

/** Record one incoming HTTP request. */
export function recordServerRequest() { bump(serverRequests); }
/** Record one outgoing Twitch API call. */
export function recordTwitchCall() { bump(twitchCalls); }
/** Record `n` bytes downloaded from Twitch. */
export function recordTwitchBytes(n) { twitchBytes.total += n; }
/** Current server-requests-per-minute rate (also updates its peak). */
export function serverRatePerMin() { return ratePerMin(serverRequests); }
/** Current Twitch-calls-per-minute rate (also updates its peak). */
export function twitchRatePerMin() { return ratePerMin(twitchCalls); }
