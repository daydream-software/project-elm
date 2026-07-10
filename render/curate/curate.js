/* Selection UI: in-browser Twitch login → browse clips (with downloaded badge) →
   download the ones you want (only downloaded clips can be included) → hide the ones
   you never want to feature → set a custom play order by drag & drop → preview in the
   overlay. Talks to server.mjs. */

const $ = (id) => document.getElementById(id);
let clips = [];
let sequence = [];          // included clip ids, in play order (custom drag order = source of truth)
const hidden = new Set();    // clip ids the user never wants to feature

// Persist the selection, order, and hidden set across refreshes.
const SEL_KEY = 'elm.selected', ORDER_KEY = 'elm.order', HIDDEN_KEY = 'elm.hidden';
try { const a = JSON.parse(localStorage.getItem(SEL_KEY) || '[]'); if (Array.isArray(a)) sequence = a; } catch {}
try { JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]').forEach(id => hidden.add(id)); } catch {}
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
  $('login').hidden = false; $('controls').hidden = true; $('grid').innerHTML = ''; $('sequence').hidden = true;
  $('login-idle').hidden = mode !== 'idle';
  $('login-code').hidden = mode !== 'code';
  $('login-setup').hidden = mode !== 'setup';
}
function showApp() { $('login').hidden = true; $('controls').hidden = false; }

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
async function loadClips() {
  $('status').textContent = 'Loading…';
  try {
    const data = await api(`/api/clips?days=${$('days').value}&first=${$('first').value}`);
    clips = data.clips;
    render();
  } catch (e) {
    if (/logged in|NO_TOKEN/i.test(e.message)) return showLogin('idle');
    $('status').textContent = '⚠ ' + e.message;
  }
}

function render() {
  const grid = $('grid');
  const showHidden = $('showHidden').checked;
  const visible = clips.filter(c => showHidden || !hidden.has(c.id));
  grid.innerHTML = visible.length ? '' : '<div class="empty">No clips.</div>';
  for (const c of visible) {
    const isHidden = hidden.has(c.id);
    const thumb = (c.thumbnail || '').replace('{width}', '480').replace('{height}', '272');
    const included = c.downloaded && isIncluded(c.id) && !isHidden;
    const card = document.createElement('div');
    card.className = 'card' + (included ? ' selected' : '') + (isHidden ? ' is-hidden' : '');
    card.dataset.id = c.id;

    // Foot: hidden → Unhide; downloaded → Include + Delete download; else → Download.
    const foot = isHidden
      ? `<button class="btn ghost unhide" type="button">↩ Unhide</button>`
      : c.downloaded
        ? `<label><input type="checkbox" ${included ? 'checked' : ''} /> Include</label>
           <button class="del-dl" type="button" title="Delete download — frees the file; you can re-download" aria-label="Delete download">🗑</button>`
        : `<button class="btn ghost dl-one" type="button">⬇ Download</button>`;

    // Corner control: hide (only on non-hidden cards — hidden cards unhide from the foot).
    const corner = isHidden ? '' :
      `<button class="hide-btn" type="button" title="Hide — never feature" aria-label="Hide clip">✕</button>`;

    const thumbAttrs = isHidden ? '' : ` role="button" tabindex="0" title="${c.downloaded ? 'Click to include / exclude' : 'Click to download'}"`;

    card.innerHTML = `
      <div class="thumb"${thumbAttrs}>
        <img loading="lazy" src="${esc(thumb)}" alt="" />
        <span class="badge ${c.downloaded ? 'dl' : 'nodl'}">${c.downloaded ? '✓ Downloaded' : 'not downloaded'}</span>
        <span class="dur">${fmtDur(c.duration)}</span>
        ${corner}
      </div>
      <div class="card-body">
        <div class="card-title">${esc(c.title || '(untitled)')}</div>
        <div class="card-meta">👁 ${fmtViews(c.views)} · ${fmtDate(c.createdAt)}</div>
      </div>
      <div class="card-foot">${foot}</div>`;

    if (isHidden) {
      card.querySelector('.unhide').addEventListener('click', () => toggleHidden(c.id));
    } else {
      card.querySelector('.hide-btn').addEventListener('click', e => { e.stopPropagation(); toggleHidden(c.id); });
      const act = () => c.downloaded ? setInclude(c.id, !isIncluded(c.id)) : downloadOne(c.id);
      card.querySelector('.thumb').addEventListener('click', act);
      card.querySelector('.thumb').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      if (c.downloaded) {
        card.querySelector('input').addEventListener('change', e => setInclude(c.id, e.target.checked));
        card.querySelector('.del-dl').addEventListener('click', e => { e.stopPropagation(); deleteDownload(c.id); });
      } else card.querySelector('.dl-one').addEventListener('click', () => downloadOne(c.id));
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
    const cb = card.querySelector('input[type=checkbox]'); if (cb) cb.checked = on;
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
  const inc = clips.filter(c => c.downloaded && isIncluded(c.id) && !hidden.has(c.id)).length;
  const hid = clips.filter(c => hidden.has(c.id)).length;
  $('status').textContent = `${inc} included · ${dl}/${clips.length} downloaded${hid ? ` · ${hid} hidden` : ''}`;
  $('preview').disabled = sequence.length === 0;
}

/* ---- Custom sequence (drag & drop) ---- */
function renderSequence() {
  const wrap = $('sequence');
  const custom = $('order').value === 'custom';
  wrap.hidden = !(custom && !$('controls').hidden);
  if (wrap.hidden) return;
  const list = $('seq-list');
  const items = sequence.map(id => clips.find(c => c.id === id)).filter(c => c && c.downloaded && !hidden.has(c.id));
  list.innerHTML = items.length ? '' : '<div class="seq-empty">Include clips below, then drag the tiles to set the play order.</div>';
  items.forEach((c, i) => {
    const thumb = (c.thumbnail || '').replace('{width}', '160').replace('{height}', '90');
    const tile = document.createElement('div');
    tile.className = 'seq-tile';
    tile.draggable = true;
    tile.dataset.id = c.id;
    tile.innerHTML = `
      <span class="seq-grip" aria-hidden="true">⠿</span>
      <span class="seq-num">${i + 1}</span>
      <img class="seq-thumb" src="${esc(thumb)}" alt="" />
      <span class="seq-title">${esc(c.title || '(untitled)')}</span>
      <button class="seq-remove" type="button" title="Remove from sequence" aria-label="Remove from sequence">✕</button>`;
    tile.querySelector('.seq-remove').addEventListener('click', () => setInclude(c.id, false));
    list.appendChild(tile);
  });
}

// Wrap-aware, row-first insertion point → the tile the drop should land BEFORE (null =
// append). Wide-and-short tiles make a naive nearest-centre metric jump to the row below
// (the vertical neighbour is closer than the horizontal one), so we pick the pointer's
// ROW first, then the first tile in it whose centre is right of the pointer. The strip
// wraps to multiple rows so a 15–20 clip reel stays fully visible — native HTML5 DnD
// cannot autoscroll a container.
function getDragAfterElement(container, x, y) {
  const tiles = [...container.querySelectorAll('.seq-tile:not(.dragging)')];
  if (!tiles.length) return null;
  const box = new Map(tiles.map(t => [t, t.getBoundingClientRect()]));
  const tops = [...new Set(tiles.map(t => Math.round(box.get(t).top)))].sort((a, b) => a - b);
  const lastBox = box.get(tiles[tiles.length - 1]);
  if (y > lastBox.top + lastBox.height) return null;               // below everything → append
  let rowTop = tops[0];
  for (const t of tops) if (y >= t) rowTop = t;                    // row containing / just above the pointer
  const row = tiles.filter(t => Math.round(box.get(t).top) === rowTop);
  for (const t of row) if (x < box.get(t).left + box.get(t).width / 2) return t;   // before first tile past x
  const next = tops[tops.indexOf(rowTop) + 1];                     // past the row → first tile of next row
  return next == null ? null : tiles.find(t => Math.round(box.get(t).top) === next);
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
    const after = getDragAfterElement(list, e.clientX, e.clientY);
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
  const ids = clips.filter(c => !c.downloaded && !hidden.has(c.id)).map(c => c.id);
  if (!ids.length) { $('status').textContent = 'Nothing to download.'; return; }
  $('status').textContent = `Downloading ${ids.length}…`;
  try {
    await api('/api/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    await loadClips();
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function deleteDownload(id) {
  if (!confirm('Delete this clip\'s downloaded file? It leaves the reel but stays on Twitch — you can re-download it anytime.')) return;
  $('status').textContent = 'Deleting…';
  try {
    await api('/api/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    const i = sequence.indexOf(id); if (i >= 0) { sequence.splice(i, 1); saveSel(); }  // no longer downloadable → drop from reel
    await loadClips();   // refresh badges → card reverts to "Download"
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function preview() {
  try {
    const data = await api('/api/playlist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: sequence, order: $('order').value, showTitle: $('showTitle').checked, showBroadcaster: $('showChannel').checked, showGame: $('showGame').checked }),
    });
    if (!data.count) { $('status').textContent = '⚠ No downloaded clips included — download + include some first.'; return; }
    window.open(data.url, '_blank');
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

/* ---- Init ---- */
async function init() {
  $('login-btn').addEventListener('click', doLogin);
  $('load').addEventListener('click', loadClips);
  $('dlall').addEventListener('click', downloadAll);
  $('all').addEventListener('click', () => { clips.forEach(c => { if (c.downloaded && !hidden.has(c.id) && !isIncluded(c.id)) sequence.push(c.id); }); render(); });
  $('none').addEventListener('click', () => { sequence = []; render(); });
  $('preview').addEventListener('click', preview);
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('elm.theme', next);
  });
  $('order').value = localStorage.getItem(ORDER_KEY) || 'random';
  $('order').addEventListener('change', () => { localStorage.setItem(ORDER_KEY, $('order').value); renderSequence(); });
  $('showHidden').checked = localStorage.getItem('elm.showHidden') === '1';
  $('showHidden').addEventListener('change', () => { localStorage.setItem('elm.showHidden', $('showHidden').checked ? '1' : '0'); render(); });
  for (const id of ['showTitle', 'showChannel', 'showGame']) {
    const saved = localStorage.getItem('elm.' + id);
    if (saved !== null) $(id).checked = saved === '1';
    $(id).addEventListener('change', () => localStorage.setItem('elm.' + id, $(id).checked ? '1' : '0'));
  }
  initDrag();
  try {
    const st = await api('/api/status');
    if (!st.hasCreds) return showLogin('setup');
    if (st.authorized) { showApp(); loadClips(); } else showLogin('idle');
  } catch { showLogin('idle'); }
}
init();
