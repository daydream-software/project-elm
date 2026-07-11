/* =============================================================================
 * metrics.mjs — tiny in-memory activity counters for the CLI dashboard
 * (dashboard.mjs). Two independent channels: browser↔server (HTTP requests
 * this server receives) and server↔twitch (Helix/OAuth calls + clip download
 * bytes, the actual heavy transfer). Nothing here is persisted — it resets
 * whenever the server restarts, which is fine, it's a live "what's happening
 * right now" view, not an audit log.
 * ========================================================================== */

const RATE_WINDOW_MS = 60_000;   // "per minute" window for the rolling rate

function makeCounter() {
  return { total: 0, timestamps: [], peakPerMin: 0 };
}
function trim(counter) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  while (counter.timestamps.length && counter.timestamps[0] < cutoff) counter.timestamps.shift();
}
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
function ratePerMin(counter) {
  trim(counter);
  const rate = counter.timestamps.length;
  if (rate > counter.peakPerMin) counter.peakPerMin = rate;
  return rate;
}

export const serverRequests = makeCounter();
export const twitchCalls = makeCounter();
export const twitchBytes = { total: 0 };

export function recordServerRequest() { bump(serverRequests); }
export function recordTwitchCall() { bump(twitchCalls); }
export function recordTwitchBytes(n) { twitchBytes.total += n; }

export function serverRatePerMin() { return ratePerMin(serverRequests); }
export function twitchRatePerMin() { return ratePerMin(twitchCalls); }
