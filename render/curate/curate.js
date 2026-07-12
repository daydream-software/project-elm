/* Selection UI: in-browser Twitch login → browse clips (with downloaded badge) →
   download the ones you want (only downloaded clips can be included) → hide the ones
   you never want to feature → set a custom play order by drag & drop → save as a named
   configuration and open its live overlay URL (paste into an OBS Browser Source — any
   number of saved configurations can run as separate sources at once). Talks to server.mjs. */

const $ = (id) => document.getElementById(id);
let clips = [];
let sequence = [];          // included clip ids, in play order (custom drag order = source of truth)
const hidden = new Set();    // clip ids the user never wants to feature
let configs = [];           // saved configurations (name, sequence, order, toggles)
let loadedConfigId = null;  // the config `sequence`/order/toggles below were loaded from (null = unsaved/new)

// Persist the selection, order, hidden set, and in-progress configuration across refreshes.
const SEL_KEY = 'elm.selected', ORDER_KEY = 'elm.order', HIDDEN_KEY = 'elm.hidden', LOADED_KEY = 'elm.loadedConfig';
try { const a = JSON.parse(localStorage.getItem(SEL_KEY) || '[]'); if (Array.isArray(a)) sequence = a; } catch {}
try { JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]').forEach(id => hidden.add(id)); } catch {}
loadedConfigId = localStorage.getItem(LOADED_KEY) || null;
const saveSel = () => { try { localStorage.setItem(SEL_KEY, JSON.stringify(sequence)); } catch {} };
const saveHidden = () => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch {} };
const isIncluded = (id) => sequence.includes(id);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`; };
const fmtViews = (n) => Number(n || 0).toLocaleString('en-US');
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-US'); } catch { return ''; } };

/* ---- Views ---- */
function showLogin(mode) {
  $('login').hidden = false; $('filterOptionsBar').hidden = true; $('grid').innerHTML = '';
  $('sequence').hidden = true; $('catalogBar').hidden = true;
  closeConfigsFlyout(); $('cfgSwitchBtn').disabled = true; $('configQuickSave').disabled = true; $('preview').disabled = true;
  $('login-idle').hidden = mode !== 'idle';
  $('login-code').hidden = mode !== 'code';
  $('login-setup').hidden = mode !== 'setup';
}
function showApp() {
  $('login').hidden = true; $('filterOptionsBar').hidden = false;
  $('catalogBar').hidden = false; $('sequence').hidden = false;
  $('cfgSwitchBtn').disabled = false; $('configQuickSave').disabled = false;
}

/* ---- Login (device code) ---- */
async function doLogin() {
  try {
    const { verification_uri, user_code } = await api('/api/login', { method: 'POST' });
    showLogin('code');
    const a = $('login-url'); a.href = verification_uri; a.textContent = verification_uri;
    $('login-usercode').textContent = user_code;
    const iv = setInterval(async () => {
      const st = await api('/api/status');
      if (st.authorized) { clearInterval(iv); showApp(); loadClips(); }
    }, 3000);
  } catch (e) { alert('Login: ' + e.message); showLogin('idle'); }
}

/* ---- Clips ---- */
// Always fetches the FULL catalog (no days/first/all params — those are now pure
// client-side filters in render(), applied instantly with no round-trip; see below).
async function loadClips() {
  $('status').textContent = 'Loading…';
  try {
    const data = await api('/api/clips');
    clips = data.clips;
    updateCatalogStatus(data.catalogUpdatedAt);
    render();
  } catch (e) {
    if (/logged in|NO_TOKEN/i.test(e.message)) return showLogin('idle');
    $('status').textContent = '⚠ ' + e.message;
  }
}

/* ---- Local clip catalog: status line + "Update from Twitch" (SSE progress) ----
   Browsing/curating always reads the catalog (loadClips above) — this is the only
   action that talks to Twitch's clip listing directly. */
function updateCatalogStatus(updatedAt) {
  $('catalogStatus').textContent = updatedAt
    ? `Catalog updated ${new Date(updatedAt).toLocaleString()}`
    : 'Catalog never updated — click Update to pull your clips from Twitch';
}
function refreshCatalog() {
  const btn = $('catalogUpdate');
  btn.disabled = true;
  $('catalogProgress').hidden = false;
  $('catalogProgressText').textContent = 'Starting…';
  const es = new EventSource('/api/catalog/events');
  // `persistText` replaces the status line and STAYS there — loadClips() below would
  // otherwise immediately stomp it back to the plain "Catalog updated …" message, which
  // is why persistText is applied AFTER loadClips resolves, not before.
  const finish = (progressText, persistText) => {
    $('catalogProgressText').textContent = progressText;
    es.close();
    btn.disabled = false;
    setTimeout(async () => {
      $('catalogProgress').hidden = true;
      await loadClips();
      if (persistText) $('catalogStatus').textContent = persistText;
    }, 1500);
  };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'progress') {
      $('catalogProgressText').textContent = `${msg.fetched} clips fetched…`;
    } else if (msg.type === 'done') {
      const when = new Date(msg.updatedAt).toLocaleString();
      finish(
        `Done — ${msg.total} clips (${msg.added} new, ${msg.updated} updated, ${msg.newlyMissing} removed from Twitch).`,
        `Catalog updated ${when} — ${msg.total} clips (${msg.added} new, ${msg.updated} updated, ${msg.newlyMissing} removed from Twitch).`,
      );
    } else if (msg.type === 'error') {
      finish('⚠ ' + msg.error, '⚠ Update failed: ' + msg.error);
    }
  };
  es.onerror = () => { /* the 'error' message above (or a done) already handles cleanup in the normal case */ };
  api('/api/catalog/refresh', { method: 'POST' }).catch(e => finish('⚠ ' + e.message, '⚠ Update failed: ' + e.message));
}

// Period + Max/Load-all + search + Show-hidden: pure client-side filters over the
// already-loaded catalog — no fetch, applied instantly on every change (see init()'s
// event wiring). Shared by render() and the bulk actions (Download all/Include all),
// which should act on what's currently shown, not silently reach into the full catalog.
function visibleClips() {
  const showHidden = $('showHidden').checked;
  const q = $('clipSearch').value.trim().toLowerCase();
  const days = Number($('days').value) || 0;
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const inPeriod = clips.filter(c => !since || !c.createdAt || new Date(c.createdAt) >= since);
  const capped = $('allClips').checked ? inPeriod : inPeriod.slice(0, Number($('first').value) || 50);
  return capped.filter(c => (showHidden || !hidden.has(c.id))
    && (!q || (c.title || '').toLowerCase().includes(q) || (c.game || '').toLowerCase().includes(q)));
}

// Shared by both dropdown openers (a card's ⋯ menu, the config-switch menu) and by the
// outside-click/Escape closers below — closing through ONE function means opening
// either dropdown always closes the other (they used to each close only their own
// kind, so a kebab menu and the config-switch menu could both stay open at once).
function closeAllMenus() {
  document.querySelectorAll('.kebab-menu').forEach(m => m.hidden = true);
  document.querySelectorAll('.kebab').forEach(k => k.classList.remove('open'));
  $('cfgMenu').hidden = true;
  $('cfgSwitchBtn').setAttribute('aria-expanded', 'false');
}

function render() {
  const grid = $('grid');
  const q = $('clipSearch').value.trim().toLowerCase();
  const visible = visibleClips();
  grid.innerHTML = visible.length ? '' : `<div class="empty">${q ? 'No clips match your search.' : 'No clips.'}</div>`;
  for (const c of visible) {
    const isHidden = hidden.has(c.id);
    const thumb = (c.thumbnail || '').replace('{width}', '480').replace('{height}', '272');
    const included = c.downloaded && isIncluded(c.id) && !isHidden;
    const card = document.createElement('div');
    card.className = 'card' + (included ? ' selected' : '') + (isHidden ? ' is-hidden' : '');
    card.dataset.id = c.id;

    // Primary action (big hover CTA over the thumbnail): hidden → Unhide; downloaded →
    // Add/remove from the reel; else → Download. Secondary actions (Hide, Delete
    // download — rare and/or destructive) live behind the ⋯ menu instead of competing
    // for space with Preview and the primary CTA.
    const delTitle = c.orphaned
      ? 'Delete download — this clip no longer exists on Twitch, so this is FINAL (no re-download possible)'
      : 'Delete download — frees the file; you can re-download';
    const ctaLabel = isHidden ? '↩ Unhide' : c.downloaded ? (included ? '✓ In reel' : '+ Add to reel') : '⬇ Download';
    const ctaClass = included ? ' in' : '';
    // aria-pressed only makes sense for the include on/off toggle (downloaded, not
    // hidden) — Download/Unhide are one-shot actions, not a persistent toggle state.
    const ctaIsToggle = !isHidden && c.downloaded;
    const ctaAria = ctaIsToggle ? ` aria-pressed="${included}"` : '';
    const kebab = isHidden ? '' : `
      <button class="kebab" type="button" title="More" aria-label="More actions">⋯</button>
      <div class="kebab-menu" hidden>
        <button class="k-hide" type="button">✕ Hide</button>
        ${c.downloaded ? `<button class="k-del danger" type="button" title="${esc(delTitle)}">🗑 Delete download</button>` : ''}
      </div>`;

    const thumbAttrs = isHidden ? '' : ` role="button" tabindex="0" title="${c.downloaded ? 'Click to include / exclude' : 'Click to download'}"`;

    const badgeClass = c.orphaned ? 'orphan' : c.uncataloged ? 'pending' : (c.downloaded ? 'dl' : 'nodl');
    const badgeText = c.orphaned ? '⚠ Removed from Twitch' : c.uncataloged ? '◌ Not yet cataloged' : (c.downloaded ? '✓ Downloaded' : 'not downloaded');
    // Twitch's own thumbnail never hard-fails for a deleted clip (see ensureHomemadeThumbnail
    // above) — so for an orphaned or not-yet-cataloged clip with no generated thumbnail yet,
    // kick one off now rather than waiting for an onerror that will never come.
    if ((c.orphaned || c.uncataloged) && c.downloaded && !/\.thumb\.jpg(\?|$)/.test(c.thumbnail || '')) ensureHomemadeThumbnail(c.id);
    card.innerHTML = `
      <div class="thumb"${thumbAttrs}>
        <img loading="lazy" src="${esc(thumb)}" alt="" data-id="${esc(c.id)}" onerror="handleThumbError(this)" />
        <span class="badge ${badgeClass}">${badgeText}</span>
        <span class="dur">${fmtDur(c.duration)}</span>
        <button class="play-btn" type="button" title="Preview clip" aria-label="Preview clip">▶</button>
        <div class="primary-cta"><button class="cta-btn${ctaClass}" type="button"${ctaAria}>${ctaLabel}</button></div>
        ${kebab}
      </div>
      <div class="card-body">
        <div class="card-title">${esc(c.title || '(untitled)')}</div>
        <div class="card-meta">${c.game ? esc(c.game) + ' · ' : ''}👁 ${fmtViews(c.views)} · ${fmtDate(c.createdAt)}</div>
      </div>`;

    card.querySelector('.play-btn').addEventListener('click', e => { e.stopPropagation(); openPreview(c); });

    const act = isHidden ? () => toggleHidden(c.id)
      : c.downloaded ? () => setInclude(c.id, !isIncluded(c.id)) : () => downloadOne(c.id);
    card.querySelector('.cta-btn').addEventListener('click', e => { e.stopPropagation(); act(); });

    if (!isHidden) {
      card.querySelector('.thumb').addEventListener('click', act);
      card.querySelector('.thumb').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      const keb = card.querySelector('.kebab'), menu = card.querySelector('.kebab-menu');
      keb.addEventListener('click', e => {
        e.stopPropagation();
        const wasOpen = !menu.hidden;
        closeAllMenus();
        if (!wasOpen) { menu.hidden = false; keb.classList.add('open'); }
      });
      menu.querySelector('.k-hide').addEventListener('click', e => { e.stopPropagation(); menu.hidden = true; toggleHidden(c.id); });
      const del = menu.querySelector('.k-del');
      if (del) del.addEventListener('click', e => { e.stopPropagation(); menu.hidden = true; deleteDownload(c.id); });
    }
    grid.appendChild(card);
  }
  renderSequence();
  updateActions();
}

function setInclude(id, on) {
  if (on) { if (!sequence.includes(id)) sequence.push(id); }
  else { const i = sequence.indexOf(id); if (i >= 0) sequence.splice(i, 1); }
  const card = $('grid').querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('selected', on);
    const cta = card.querySelector('.cta-btn');
    if (cta) { cta.textContent = on ? '✓ In reel' : '+ Add to reel'; cta.classList.toggle('in', on); cta.setAttribute('aria-pressed', String(on)); }
  }
  saveSel();
  renderSequence();
  updateActions();
}

function toggleHidden(id) {
  if (hidden.has(id)) {
    hidden.delete(id);
  } else {
    hidden.add(id);
    const i = sequence.indexOf(id); if (i >= 0) sequence.splice(i, 1); // hidden clips are never included
  }
  saveHidden(); saveSel();
  render();
}

function updateActions() {
  saveSel();
  const dl = clips.filter(c => c.downloaded).length;
  const hid = clips.filter(c => hidden.has(c.id)).length;
  const orph = clips.filter(c => c.orphaned).length;
  // "Included" isn't reported here anymore — the reel panel's count/duration is now the
  // single place that answers "what have I built", instead of duplicating it.
  $('status').textContent = `${dl}/${clips.length} downloaded${hid ? ` · ${hid} hidden` : ''}${orph ? ` · ${orph} removed from Twitch` : ''}`;
  refreshCfgDirty();
}

// Channel/Game are sub-parts of the title-card lower third, not independent overlay
// elements — disable (don't clear) them while Title card is off, so their value survives
// for whenever it's turned back on.
function syncOnscreenToggles() {
  const on = $('showTitle').checked;
  $('showChannel').disabled = !on;
  $('showGame').disabled = !on;
}

// Order-mode field/direction metadata, fetched from /api/status (server.mjs's
// ORDER_FIELDS is the single source of truth) — populated in init(). Building the
// comparator from plain {field, dir} data here instead of hand-copying per-mode
// comparator functions means the actual sort RULE only lives server-side; this stays
// in sync automatically instead of needing a matching edit in two files.
let ORDER_FIELDS = {};
function buildComparator(mode) {
  const f = ORDER_FIELDS[mode];
  if (!f) return null;
  return f.isDate
    ? (a, b) => f.dir * (new Date(a[f.field]) - new Date(b[f.field]))
    : (a, b) => f.dir * (a[f.field] - b[f.field]);
}

/* ---- Your reel: always visible (previously this only existed when Order = Custom, so
   there was no way to see your included clips as a list in Random/Views/Recent/Oldest). ---- */
function renderSequence() {
  const custom = $('order').value === 'custom';
  // Random genuinely has no fixed play order — the overlay reshuffles every loop — so
  // the panel below shows clips unsorted and unnumbered rather than implying an order
  // that will never actually play out that way.
  const isRandom = $('order').value === 'random';
  let items = sequence.map(id => clips.find(c => c.id === id)).filter(c => c && c.downloaded && !hidden.has(c.id));
  if (!custom && !isRandom) {
    const cmp = buildComparator($('order').value);
    if (cmp) items = items.slice().sort(cmp);
  }
  const totalDur = items.reduce((s, c) => s + (c.duration || 0), 0);
  $('reelStats').textContent = items.length
    ? `${items.length} clip${items.length === 1 ? '' : 's'} · ${fmtDur(totalDur)} total`
    : 'No clips included yet';
  $('seqHint').textContent = custom
    ? 'drag the tiles to set the play order'
    : isRandom
      ? 'reshuffled every loop — order below isn\'t the play order'
      : 'switch Order to Custom to drag-reorder';

  const list = $('seq-list');
  list.innerHTML = items.length ? '' : '<div class="seq-empty">Include clips below — they\'ll show up here.</div>';
  items.forEach((c, i) => {
    const thumb = (c.thumbnail || '').replace('{width}', '160').replace('{height}', '90');
    const tile = document.createElement('div');
    tile.className = 'seq-tile';
    tile.draggable = custom;
    tile.dataset.id = c.id;
    tile.innerHTML = `
      <span class="seq-grip${custom ? '' : ' static'}" aria-hidden="true">⠿</span>
      <span class="seq-num"${isRandom ? ' title="Shuffled — not a fixed position"' : ''}>${isRandom ? '🔀' : i + 1}</span>
      <img class="seq-thumb" src="${esc(thumb)}" alt="" />
      <span class="seq-title">${esc(c.title || '(untitled)')}</span>
      <span class="seq-dur">${fmtDur(c.duration)}</span>
      <button class="seq-remove" type="button" title="Remove from reel" aria-label="Remove from reel">✕</button>`;
    tile.querySelector('.seq-remove').addEventListener('click', () => setInclude(c.id, false));
    list.appendChild(tile);
  });
}

// Single-column list (the reel is a narrow side panel, not a wrapping multi-row strip) —
// insertion point is just the first tile whose vertical centre is past the pointer.
function getDragAfterElement(container, y) {
  const tiles = [...container.querySelectorAll('.seq-tile:not(.dragging)')];
  return tiles.find(t => {
    const box = t.getBoundingClientRect();
    return y < box.top + box.height / 2;
  }) || null;
}

let dragId = null;   // id of the tile currently being dragged

const clearDropMarker = (list) => {
  list.querySelectorAll('.drop-before').forEach(el => el.classList.remove('drop-before'));
  list.classList.remove('drop-at-end');
};

/* Reorder `sequence` so `id` lands before `beforeId` (or at the end when null).
   Runs on drop only — the tiles never move mid-drag, so there is no reflow flicker. */
function commitReorder(id, beforeId) {
  if (!id) return;
  const visible = [...$('seq-list').querySelectorAll('.seq-tile')].map(t => t.dataset.id);
  const from = visible.indexOf(id); if (from < 0) return;
  visible.splice(from, 1);
  const at = beforeId == null ? -1 : visible.indexOf(beforeId);
  if (at < 0) visible.push(id); else visible.splice(at, 0, id);
  const shown = new Set(visible);
  // Keep any included ids not shown in the strip (outside the loaded window) after the visible ones.
  sequence = [...visible, ...sequence.filter(x => !shown.has(x))];
  saveSel();
  renderSequence();
  updateActions();
}

function initDrag() {
  const list = $('seq-list');
  list.addEventListener('dragstart', e => {
    const tile = e.target.closest('.seq-tile'); if (!tile) return;
    dragId = tile.dataset.id;
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  });
  // Show a drop indicator only — do NOT move the dragged tile (moving it reflows the
  // grid under the cursor and makes the target oscillate → flicker).
  list.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = getDragAfterElement(list, e.clientY);
    clearDropMarker(list);
    if (after) after.classList.add('drop-before');
    else list.classList.add('drop-at-end');
  });
  list.addEventListener('drop', e => {
    if (!dragId) return;
    e.preventDefault();
    const after = list.querySelector('.seq-tile.drop-before');
    commitReorder(dragId, after ? after.dataset.id : null);
  });
  list.addEventListener('dragend', () => {   // fires on drop AND on cancel — always clean up
    dragId = null;
    clearDropMarker(list);
    const dt = list.querySelector('.dragging'); if (dt) dt.classList.remove('dragging');
  });
}

async function downloadOne(id) {
  $('status').textContent = 'Downloading…';
  try {
    await api('/api/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    if (!hidden.has(id) && !sequence.includes(id)) { sequence.push(id); saveSel(); }  // auto-include what you just downloaded
    await loadClips();                    // refresh badges → clip now shows Include (checked)
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function downloadAll() {
  const ids = visibleClips().filter(c => !c.downloaded && !hidden.has(c.id)).map(c => c.id);
  if (!ids.length) { $('status').textContent = 'Nothing to download.'; return; }
  $('status').textContent = `Downloading ${ids.length}…`;
  try {
    await api('/api/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    await loadClips();
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function deleteDownload(id) {
  const c = clips.find(x => x.id === id);
  const msg = c && c.orphaned
    ? 'This clip no longer exists on Twitch — deleting the local file is FINAL, there is no re-downloading it. Delete anyway?'
    : 'Delete this clip\'s downloaded file? It leaves the reel but stays on Twitch — you can re-download it anytime.';
  if (!confirm(msg)) return;
  $('status').textContent = 'Deleting…';
  try {
    await api('/api/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    const i = sequence.indexOf(id); if (i >= 0) { sequence.splice(i, 1); saveSel(); }  // no longer downloadable → drop from reel
    await loadClips();   // refresh badges → card reverts to "Download"
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

/* ---- Clip preview (popup overlay, same window) ---- */
function openPreview(c) {
  const body = $('previewBody');
  $('previewTitle').textContent = c.title || '(untitled)';
  if (c.downloaded) {
    body.innerHTML = `<video src="/render/realclips/${encodeURIComponent(c.id)}.mp4" controls autoplay playsinline></video>`;
  } else {
    // Not downloaded yet: fall back to the official Twitch clip embed (needs a user
    // gesture to autoplay with sound, which this click just provided).
    const parent = encodeURIComponent(location.hostname || 'localhost');
    body.innerHTML = `<iframe src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(c.id)}&parent=${parent}&autoplay=true" allow="autoplay; fullscreen" frameborder="0"></iframe>`;
  }
  $('previewOverlay').hidden = false;
}
function closePreview() {
  $('previewOverlay').hidden = true;
  $('previewBody').innerHTML = '';   // drop the video/iframe so playback actually stops
}

/* ---- Homemade thumbnail fallback (no ffmpeg / server dependency) ----
   Twitch doesn't actually 404 a dead thumbnail URL — it 302-redirects to its own
   generic .../ttv-static/404_preview-WxH.jpg placeholder, which <img> loads "successfully"
   (no error event). So we can't detect this via onerror; instead, render() below calls
   ensureHomemadeThumbnail directly for any orphaned clip that doesn't already have a
   generated thumbnail. It grabs a frame from the LOCAL mp4 in a hidden <video>, draws it
   to a <canvas>, and uploads the JPEG once so future loads (and the overlay's own
   metadata) get it straight from the server instead of regenerating every time.
   onerror is kept too, as a plain safety net for thumbnails that genuinely fail to load. */
const thumbRegenAttempted = new Set();   // per-page-load: only try once per clip id
async function ensureHomemadeThumbnail(id) {
  if (thumbRegenAttempted.has(id)) return;
  thumbRegenAttempted.add(id);
  try {
    const video = document.createElement('video');
    video.src = `/render/realclips/${encodeURIComponent(id)}.mp4`;
    video.muted = true;
    video.playsInline = true;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(1, video.duration / 2); }, { once: true });
      video.addEventListener('seeked', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('video load failed')), { once: true });
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    const img = document.querySelector(`img[data-id="${CSS.escape(id)}"]`);
    if (img) { img.src = dataUrl; img.closest('.thumb').classList.remove('thumb-broken'); }
    await api('/api/thumbnail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, dataUrl }) });
  } catch { /* leave whatever thumbnail is already showing — nothing more we can do */ }
}
function handleThumbError(img) {
  img.closest('.thumb').classList.add('thumb-broken');
  const c = clips.find(x => x.id === img.dataset.id);
  if (c && c.downloaded) ensureHomemadeThumbnail(img.dataset.id);
}

function openOverlay() {
  if (!loadedConfigId) { alert('Save this as a configuration first, then open its overlay.'); return; }
  window.open(`/overlay/?config=${encodeURIComponent(loadedConfigId)}`, '_blank');
}

/* ---- Saved configurations (flyout) ---- */
function openConfigsFlyout() {
  const el = $('configsFlyout');
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('open'));
}
function closeConfigsFlyout() {
  const el = $('configsFlyout');
  el.classList.remove('open');
  setTimeout(() => { el.hidden = true; }, 200);   // matches the CSS slide transition
}

function setLoadedConfig(id) {
  loadedConfigId = id;
  try { id ? localStorage.setItem(LOADED_KEY, id) : localStorage.removeItem(LOADED_KEY); } catch {}
  $('preview').disabled = !id;
  const c = id && configs.find(x => x.id === id);
  $('cfgSwitchName').textContent = c ? c.name : 'New configuration';
  renderCfgMenu();
}

// Unsaved-changes dot on the topbar switch: dirty if a loaded config's live state
// (sequence/order/on-overlay toggles) no longer matches what was last loaded/saved, or
// if there's no loaded config yet but the reel isn't empty (a new, never-saved draft).
let savedSnapshot = null;
// Guards against a startup race: loadClips() (fired without awaiting in init()) can
// resolve and trigger a dirty check before init() has finished resolving which config
// is loaded and setting savedSnapshot — without this guard that reads as "dirty"
// against a not-yet-set null snapshot and flashes the dot for an unedited config.
let configsReady = false;
const snapshotNow = () => JSON.stringify([sequence, $('order').value, $('showTitle').checked, $('showChannel').checked, $('showGame').checked]);
function refreshCfgDirty() {
  if (!configsReady) return;
  const dirty = loadedConfigId ? snapshotNow() !== savedSnapshot : sequence.length > 0;
  $('cfgDot').classList.toggle('show', dirty);
}

async function loadConfigs() {
  try {
    const data = await api('/api/configs');
    configs = data.configs;
    renderConfigList();
    renderCfgMenu();
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

function renderCfgMenu() {
  const list = $('cfgMenuList');
  list.innerHTML = configs.length
    ? configs.map(c => `<button class="cfg-item${c.id === loadedConfigId ? ' current' : ''}" type="button" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join('')
    : '<div class="config-empty">No saved configurations yet.</div>';
  list.querySelectorAll('.cfg-item').forEach(btn => btn.addEventListener('click', () => { $('cfgMenu').hidden = true; loadConfig(btn.dataset.id); }));
}

function renderConfigList() {
  const list = $('configList');
  const q = $('configSearch').value.trim().toLowerCase();
  const visible = configs.filter(c => !q || c.name.toLowerCase().includes(q));
  list.innerHTML = visible.length ? '' : `<div class="config-empty">${configs.length ? 'No configurations match your search.' : 'No saved configurations yet — set up a reel below, then Save.'}</div>`;
  for (const c of visible) {
    const row = document.createElement('div');
    row.className = 'config-item' + (c.id === loadedConfigId ? ' loaded' : '');
    row.innerHTML = `
      <div class="config-item-info">
        <span class="config-item-name">${esc(c.name)}</span>
        <span class="config-item-meta">${c.sequence.length} clip${c.sequence.length === 1 ? '' : 's'} · ${esc(c.order)}</span>
      </div>
      <div class="config-item-actions">
        <button class="btn ghost load" type="button">Load</button>
        <button class="btn ghost dup" type="button">Duplicate</button>
        <a class="btn ghost open" href="/overlay/?config=${encodeURIComponent(c.id)}" target="_blank" rel="noreferrer">Open ↗</a>
        <button class="del" type="button" title="Delete configuration" aria-label="Delete configuration">🗑</button>
      </div>`;
    row.querySelector('.load').addEventListener('click', () => loadConfig(c.id));
    row.querySelector('.dup').addEventListener('click', () => duplicateConfig(c.id));
    row.querySelector('.del').addEventListener('click', () => deleteConfigItem(c.id));
    list.appendChild(row);
  }
}

function loadConfig(id) {
  const c = configs.find(x => x.id === id);
  if (!c) return;
  sequence = c.sequence.slice();
  $('order').value = c.order;
  localStorage.setItem(ORDER_KEY, c.order);
  $('showTitle').checked = c.showTitle !== false;
  $('showChannel').checked = c.showBroadcaster !== false;
  $('showGame').checked = c.showGame !== false;
  // Setting .checked directly doesn't fire 'change', so persist these the same way the
  // change handler does — otherwise a reload restores stale toggle values from
  // localStorage instead of this config's, which then reads as a false "unsaved change".
  localStorage.setItem('elm.showTitle', $('showTitle').checked ? '1' : '0');
  localStorage.setItem('elm.showChannel', $('showChannel').checked ? '1' : '0');
  localStorage.setItem('elm.showGame', $('showGame').checked ? '1' : '0');
  syncOnscreenToggles();
  $('configName').value = c.name;
  setLoadedConfig(id);
  savedSnapshot = snapshotNow();
  saveSel();
  render();
  $('status').textContent = `Loaded "${c.name}".`;
}

async function saveConfigNow() {
  const name = $('configName').value.trim();
  if (!name) {
    openConfigsFlyout();
    $('status').textContent = '⚠ Name the configuration before saving.';
    $('configName').focus();
    return;
  }
  try {
    const saved = await api('/api/configs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: loadedConfigId || undefined, name, sequence, order: $('order').value,
        showTitle: $('showTitle').checked, showBroadcaster: $('showChannel').checked, showGame: $('showGame').checked,
      }),
    });
    // loadConfigs() first — setLoadedConfig() reads the config's name out of the
    // `configs` array, which for a brand-new (just-created) config doesn't have it yet
    // until this refresh runs; the old order showed "New configuration" right after
    // saving a new config instead of its actual name.
    await loadConfigs();
    setLoadedConfig(saved.id);
    savedSnapshot = snapshotNow();
    refreshCfgDirty();
    // Past tense on purpose — this reports what THIS save just did, not an ongoing
    // autosave. Nothing here saves again until the button is pressed. The overlay clause
    // only appears when one is actually connected — overlayCount comes from the server's
    // live SSE subscriber count for this config, not assumed.
    $('status').textContent = saved.overlayCount
      ? `Saved "${saved.name}" — its open overlay just refreshed to match.`
      : `Saved "${saved.name}".`;
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

function newConfig() {
  setLoadedConfig(null);
  $('configName').value = '';
  $('configName').focus();
  refreshCfgDirty();
  $('status').textContent = 'Editing a new (unsaved) configuration.';
}

async function duplicateConfig(id) {
  const c = configs.find(x => x.id === id);
  if (!c) return;
  try {
    await api('/api/configs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${c.name} (copy)`, sequence: c.sequence, order: c.order, showTitle: c.showTitle, showBroadcaster: c.showBroadcaster, showGame: c.showGame }),
    });
    await loadConfigs();
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function deleteConfigItem(id) {
  const c = configs.find(x => x.id === id);
  if (!confirm(`Delete configuration "${c ? c.name : id}"? Any overlay open on it will stop updating.`)) return;
  try {
    await api(`/api/configs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (id === loadedConfigId) { setLoadedConfig(null); refreshCfgDirty(); }
    await loadConfigs();
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

/* ---- Init ---- */
async function init() {
  $('login-btn').addEventListener('click', doLogin);
  // Period/Max/Load-all are pure client-side filters (see visibleClips()) — apply
  // instantly on change, no fetch, no explicit "Load" click needed.
  $('days').addEventListener('change', render);
  $('first').addEventListener('input', render);
  $('allClips').addEventListener('change', () => { $('first').disabled = $('allClips').checked; render(); });
  $('catalogUpdate').addEventListener('click', refreshCatalog);
  $('dlall').addEventListener('click', downloadAll);
  $('all').addEventListener('click', () => { visibleClips().forEach(c => { if (c.downloaded && !hidden.has(c.id) && !isIncluded(c.id)) sequence.push(c.id); }); render(); });
  $('none').addEventListener('click', () => { sequence = []; render(); });
  $('preview').addEventListener('click', openOverlay);
  $('previewClose').addEventListener('click', closePreview);
  $('previewOverlay').addEventListener('click', e => { if (e.target.id === 'previewOverlay') closePreview(); });
  $('configsClose').addEventListener('click', closeConfigsFlyout);
  $('configsFlyout').querySelector('.flyout-backdrop').addEventListener('click', closeConfigsFlyout);
  $('cfgSwitchBtn').addEventListener('click', e => {
    e.stopPropagation();
    const menu = $('cfgMenu');
    const wasOpen = !menu.hidden;
    closeAllMenus();
    if (!wasOpen) { menu.hidden = false; $('cfgSwitchBtn').setAttribute('aria-expanded', 'true'); }
  });
  $('cfgManageBtn').addEventListener('click', () => { closeAllMenus(); openConfigsFlyout(); });
  $('manageLink2').addEventListener('click', openConfigsFlyout);
  // Closes any open card ⋯ menu or the config-switch dropdown on an outside click.
  document.addEventListener('click', closeAllMenus);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('previewOverlay').hidden) closePreview();
    else if (!$('configsFlyout').hidden) closeConfigsFlyout();
    else closeAllMenus();
  });
  $('clipSearch').addEventListener('input', render);
  $('configSave').addEventListener('click', saveConfigNow);
  $('configQuickSave').addEventListener('click', saveConfigNow);
  $('configNew').addEventListener('click', newConfig);
  $('configSearch').addEventListener('input', renderConfigList);
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('elm.theme', next);
  });
  $('order').value = localStorage.getItem(ORDER_KEY) || 'random';
  $('order').addEventListener('change', () => { localStorage.setItem(ORDER_KEY, $('order').value); renderSequence(); updateActions(); });
  $('showHidden').checked = localStorage.getItem('elm.showHidden') === '1';
  $('showHidden').addEventListener('change', () => { localStorage.setItem('elm.showHidden', $('showHidden').checked ? '1' : '0'); render(); });
  for (const id of ['showTitle', 'showChannel', 'showGame']) {
    const saved = localStorage.getItem('elm.' + id);
    if (saved !== null) $(id).checked = saved === '1';
    $(id).addEventListener('change', () => { localStorage.setItem('elm.' + id, $(id).checked ? '1' : '0'); updateActions(); });
  }
  // Channel/Game only ever render as part of the title-card lower third (see
  // overlay/player.js updateLowerThird — it bails out entirely when showTitle is off,
  // regardless of these two), so checking them with Title card off wouldn't do anything.
  // Disabled, not reset, so their value is preserved for whenever Title card comes back.
  $('showTitle').addEventListener('change', syncOnscreenToggles);
  syncOnscreenToggles();
  initDrag();
  $('preview').disabled = !loadedConfigId;
  try {
    const st = await api('/api/status');
    ORDER_FIELDS = st.orderFields || {};
    if (!st.hasCreds) return showLogin('setup');
    if (st.authorized) {
      showApp(); loadClips();   // fired without awaiting — runs concurrently with loadConfigs() below
      await loadConfigs();
      // A config saved in a previous session may have since been deleted elsewhere.
      const still = configs.find(c => c.id === loadedConfigId);
      if (still) {
        $('configName').value = still.name;
        setLoadedConfig(still.id);
        savedSnapshot = JSON.stringify([still.sequence, still.order, still.showTitle !== false, still.showBroadcaster !== false, still.showGame !== false]);
      } else setLoadedConfig(null);
      // Only from here on is savedSnapshot meaningful — loadClips() above can resolve
      // and call refreshCfgDirty() before this point (it doesn't await loadConfigs()),
      // which would otherwise compare against a not-yet-set savedSnapshot and flash the
      // dot on for an unedited, already-saved config.
      configsReady = true;
      refreshCfgDirty();
    } else showLogin('idle');
  } catch { showLogin('idle'); }
}
init();

// Presence heartbeat: lets the CLI dashboard (dashboard.mjs) report "web UI open" as a
// real connection instead of guessing from recent HTTP activity. Open unconditionally
// (even on the login screen) for as long as this tab is open — the browser closes it
// automatically on navigate/close, no explicit cleanup needed.
new EventSource('/api/ui/presence');
