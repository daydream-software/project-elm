/* Selection UI: in-browser Twitch login → browse clips (with downloaded badge) →
   download the ones you want (only downloaded clips can be included) → pick order →
   preview in the overlay. Talks to server.mjs. */

const $ = (id) => document.getElementById(id);
let clips = [];
const selected = new Set();   // included clip ids (only downloaded clips)

// Persist the selection + chosen order across refreshes.
const SEL_KEY = 'elm.selected', ORDER_KEY = 'elm.order';
try { JSON.parse(localStorage.getItem(SEL_KEY) || '[]').forEach(id => selected.add(id)); } catch {}
const saveSel = () => { try { localStorage.setItem(SEL_KEY, JSON.stringify([...selected])); } catch {} };

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
  $('login').hidden = false; $('controls').hidden = true; $('grid').innerHTML = '';
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
  grid.innerHTML = clips.length ? '' : '<div class="empty">No clips.</div>';
  for (const c of clips) {
    const thumb = (c.thumbnail || '').replace('{width}', '480').replace('{height}', '272');
    const included = c.downloaded && selected.has(c.id);
    const card = document.createElement('div');
    card.className = 'card' + (included ? ' selected' : '');
    const foot = c.downloaded
      ? `<label><input type="checkbox" ${included ? 'checked' : ''} /> Include</label>`
      : `<button class="btn ghost dl-one" type="button">⬇ Download</button>`;
    card.innerHTML = `
      <div class="thumb" role="button" tabindex="0" title="${c.downloaded ? 'Click to include / exclude' : 'Click to download'}">
        <img loading="lazy" src="${esc(thumb)}" alt="" />
        <span class="badge ${c.downloaded ? 'dl' : 'nodl'}">${c.downloaded ? '✓ Downloaded' : 'not downloaded'}</span>
        <span class="dur">${fmtDur(c.duration)}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${esc(c.title || '(untitled)')}</div>
        <div class="card-meta">👁 ${fmtViews(c.views)} · ${fmtDate(c.createdAt)}</div>
      </div>
      <div class="card-foot">${foot}</div>`;

    const act = () => c.downloaded ? setInclude(c.id, card, !selected.has(c.id)) : downloadOne(c.id);
    card.querySelector('.thumb').addEventListener('click', act);
    card.querySelector('.thumb').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    if (c.downloaded) card.querySelector('input').addEventListener('change', e => setInclude(c.id, card, e.target.checked));
    else card.querySelector('.dl-one').addEventListener('click', () => downloadOne(c.id));
    grid.appendChild(card);
  }
  updateActions();
}

function setInclude(id, card, on) {
  if (on) selected.add(id); else selected.delete(id);
  card.classList.toggle('selected', on);
  const cb = card.querySelector('input[type=checkbox]'); if (cb) cb.checked = on;
  updateActions();
}

function updateActions() {
  saveSel();
  const dl = clips.filter(c => c.downloaded).length;
  const inc = clips.filter(c => c.downloaded && selected.has(c.id)).length;
  $('status').textContent = `${inc} included · ${dl}/${clips.length} downloaded`;
  $('preview').disabled = selected.size === 0;
}

async function downloadOne(id) {
  $('status').textContent = 'Downloading…';
  try {
    await api('/api/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    selected.add(id); saveSel();          // auto-include what you just downloaded
    await loadClips();                    // refresh badges → clip now shows Include (checked)
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function downloadAll() {
  const ids = clips.filter(c => !c.downloaded).map(c => c.id);
  if (!ids.length) { $('status').textContent = 'Nothing to download.'; return; }
  $('status').textContent = `Downloading ${ids.length}…`;
  try {
    await api('/api/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    await loadClips();
  } catch (e) { $('status').textContent = '⚠ ' + e.message; }
}

async function preview() {
  try {
    const data = await api('/api/playlist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...selected], order: $('order').value, showTitle: $('showTitle').checked, showBroadcaster: $('showChannel').checked, showGame: $('showGame').checked }),
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
  $('all').addEventListener('click', () => { clips.forEach(c => { if (c.downloaded) selected.add(c.id); }); render(); });
  $('none').addEventListener('click', () => { selected.clear(); render(); });
  $('preview').addEventListener('click', preview);
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('elm.theme', next);
  });
  $('order').value = localStorage.getItem(ORDER_KEY) || 'random';
  $('order').addEventListener('change', () => localStorage.setItem(ORDER_KEY, $('order').value));
  for (const id of ['showTitle', 'showChannel', 'showGame']) {
    const saved = localStorage.getItem('elm.' + id);
    if (saved !== null) $(id).checked = saved === '1';
    $(id).addEventListener('change', () => localStorage.setItem('elm.' + id, $(id).checked ? '1' : '0'));
  }
  try {
    const st = await api('/api/status');
    if (!st.hasCreds) return showLogin('setup');
    if (st.authorized) { showApp(); loadClips(); } else showLogin('idle');
  } catch { showLogin('idle'); }
}
init();
