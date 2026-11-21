// Tristakfy: a phone-first music web app. YouTube Music comes from the home server, SoundCloud
// from the always-on server; when home is off, YouTube songs fall back to a SoundCloud copy.

const APP_NAME = 'Tristakfy';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const keyOf = (t) => `${t.source}:${t.id}`;
const SRC_NAME = { yt: 'YouTube', sc: 'SoundCloud' };
const songs = (n) => `${n} ${n === 1 ? 'song' : 'songs'}`;

// ------------------------------------------------------------------ saved state
// Everything lives in this phone's browser storage. iOS can clear it, so Settings has Backup/Restore.
const STORE_KEY = 'driftwave.v1';
const DEFAULTS = {
  liked: [], playlists: [], recent: [], searches: { yt: [], sc: [] },
  settings: { ytServer: '', scServer: '', key: '', autoplay: true, fallback: true, ytKind: 'songs', statsRange: '30', discTab: 'find', theme: 'sunset' },
  session: null,
  sync: { h: {}, lk: {}, dead: {}, unliked: {} },
  stats: { events: [], tracks: {}, days: {}, hours: Array(24).fill(0), me: '', others: {} },
  discover: null,
  agenre: {},
  arel: {},             // Smart mix: artist -> related artists (Deezer)
  trending: null,
};
const S = loadState();
function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d) return { ...structuredClone(DEFAULTS), ...d, sync: { ...DEFAULTS.sync, ...d.sync }, settings: { ...DEFAULTS.settings, ...d.settings }, searches: { ...DEFAULTS.searches, ...d.searches } };
  } catch {}
  return structuredClone(DEFAULTS);
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { track(); persist(); }, 120);
  scheduleSync();
}
function persist() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} }

// ------------------------------------------------------------------ library sync
// Likes and playlists are also kept on the home server so the phone and the PC see the same library.
// Each playlist carries an `updated` time, and deletions are remembered ("dead"/"unliked") so that
// removing something on one device removes it everywhere instead of coming back.
const plHash = (p) => p.name + '|' + (p.download ? 1 : 0) + '|' + p.tracks.map(keyOf).join(',');
function track() {
  const sy = S.sync, now = Date.now();
  const ids = new Set(S.playlists.map((p) => p.id));
  for (const p of S.playlists) {
    const h = plHash(p);
    if (sy.h[p.id] !== h) { p.updated = now; sy.h[p.id] = h; delete sy.dead[p.id]; }
    else if (!p.updated) p.updated = p.created || now;
  }
  for (const id of Object.keys(sy.h)) if (!ids.has(id)) { delete sy.h[id]; sy.dead[id] ||= now; }
  const keys = new Set(S.liked.map(keyOf));
  S.liked.forEach((t, i) => { const k = keyOf(t); if (!t.likedAt) t.likedAt = now - i; if (!sy.lk[k]) { sy.lk[k] = 1; delete sy.unliked[k]; } });
  for (const k of Object.keys(sy.lk)) if (!keys.has(k)) { delete sy.lk[k]; sy.unliked[k] = now; }
}
function rebase() {
  S.sync.h = Object.fromEntries(S.playlists.map((p) => [p.id, plHash(p)]));
  S.sync.lk = Object.fromEntries(S.liked.map((t) => [keyOf(t), 1]));
}
function mergeLib(r, l) {
  r = { playlists: r?.playlists || [], liked: r?.liked || [], dead: r?.dead || {}, unliked: r?.unliked || {}, stats: r?.stats };
  const maxMap = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = Math.max(o[k] || 0, v); return o; };
  const dead = maxMap(r.dead, l.dead), unl = maxMap(r.unliked, l.unliked);
  const pm = new Map();
  for (const p of [...r.playlists, ...l.playlists]) { const o = pm.get(p.id); if (!o || (p.updated || 0) > (o.updated || 0)) pm.set(p.id, p); }
  const playlists = [...pm.values()].filter((p) => !(dead[p.id] && dead[p.id] >= (p.updated || 0))).sort((a, b) => (b.created || 0) - (a.created || 0));
  const lm = new Map();
  for (const t of [...r.liked, ...l.liked]) { const k = keyOf(t), o = lm.get(k); if (!o || (t.likedAt || 0) > (o.likedAt || 0)) lm.set(k, t); }
  const liked = [...lm.values()].filter((t) => !(unl[keyOf(t)] > (t.likedAt || 0))).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  return { playlists, liked, dead, unliked: unl, stats: mergeStats(r.stats, l.stats) };
}
// Stats from two devices: plays are combined (each play is unique by time + song), genres are kept
// once known, and listening time is stored per device so the phone's and the PC's add up.
function mergeStats(r, l) {
  r = r || {}; l = l || {};
  const seen = new Map();
  for (const e of [...(r.events || []), ...(l.events || [])]) seen.set(e[0] + '|' + e[1], e);
  let events = [...seen.values()].sort((a, b) => a[0] - b[0]);
  if (events.length > 6000) events = events.slice(-6000);
  const used = new Set(events.map((e) => e[1])), tracks = {};
  for (const src of [r.tracks || {}, l.tracks || {}]) {
    for (const [k, b] of Object.entries(src)) {
      if (!used.has(k)) continue;
      const a = tracks[k];
      tracks[k] = !a ? b : { ...a, ...b, g: b.g || a.g || (a.g === '' || b.g === '' ? '' : undefined), gt: Math.max(a.gt || 0, b.gt || 0) || undefined };
      if (tracks[k].g === undefined) delete tracks[k].g;
      if (tracks[k].gt === undefined) delete tracks[k].gt;
    }
  }
  const dev = {};
  for (const src of [r.dev || {}, l.dev || {}]) {
    for (const [id, v] of Object.entries(src)) {
      const o = (dev[id] ||= { days: {}, hours: Array(24).fill(0) });
      for (const [d, secs] of Object.entries(v.days || {})) o.days[d] = Math.max(o.days[d] || 0, secs);
      (v.hours || []).forEach((secs, i) => { o.hours[i] = Math.max(o.hours[i] || 0, secs); });
    }
  }
  return { events, tracks, dev };
}
const statsDoc = () => { const st = stats(); return { events: st.events, tracks: st.tracks, dev: { ...st.others, [st.me]: { days: st.days, hours: st.hours } } }; };
function applyStatsDoc(d) {
  if (!d) return;
  const st = stats();
  st.events = d.events || []; st.tracks = d.tracks || {};
  const { [st.me]: mine, ...others } = d.dev || {};
  st.others = others;
  if (mine) { st.days = mine.days || {}; st.hours = mine.hours || Array(24).fill(0); }
}
const statsSig = (d) => {
  if (!d) return '';
  const ev = d.events || [], tr = Object.values(d.tracks || {}); let secs = 0;
  for (const v of Object.values(d.dev || {})) { for (const x of Object.values(v.days || {})) secs += x; }
  return [ev.length, ev.length ? ev[ev.length - 1][0] : 0, tr.length, tr.filter((t) => t.g).length, Math.round(secs)].join(':');
};
const canonLib = (d) => JSON.stringify({
  p: [...(d.playlists || [])].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => [p.id, p.name, p.updated || 0, p.tracks.map(keyOf)]),
  l: (d.liked || []).map((t) => keyOf(t) + ':' + (t.likedAt || 0)).sort(),
  d: Object.entries(d.dead || {}).sort(), u: Object.entries(d.unliked || {}).sort(), s: statsSig(d.stats),
});
const syncInfo = { at: 0, ok: null };
let syncTimer, syncing = false, syncAgain = false;
function scheduleSync(delay = 2500) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, delay); }
function libUrl(rev) {
  const u = new URL(baseFor('yt') + '/api/library', location.href);
  if (rev !== undefined) u.searchParams.set('rev', rev);
  if (S.settings.key) u.searchParams.set('k', S.settings.key);
  return u.toString();
}
async function syncNow() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      track();
      const res = await fetch(libUrl(), { cache: 'no-store' });
      if (!res.ok) throw new Error('status ' + res.status);
      const remote = await res.json();
      const local = { playlists: S.playlists, liked: S.liked, dead: S.sync.dead, unliked: S.sync.unliked, stats: statsDoc() };
      const merged = mergeLib(remote.data, local);
      const changedHere = canonLib(merged) !== canonLib(local);
      S.playlists = merged.playlists; S.liked = merged.liked; S.sync.dead = merged.dead; S.sync.unliked = merged.unliked;
      applyStatsDoc(merged.stats); if (changedHere) { dirty.add('discover'); dlGc().then(dlPump); }
      rebase(); persist();
      if (changedHere && !$('#sheet').classList.contains('open') && !document.querySelector('.row.pulling') && ['home', 'library', 'playlist'].includes(route().name)) {
        if (route().name !== 'playlist' || getPlaylist(route().id) || route().id === 'liked') renderView(); else back();
      }
      if (canonLib(merged) === canonLib(remote.data || {})) { syncInfo.ok = true; break; }
      const put = await fetch(libUrl(remote.rev), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) });
      if (put.status === 409) { if (attempt === 2) throw new Error('busy'); continue; }
      if (!put.ok) throw new Error('status ' + put.status);
      syncInfo.ok = true; break;
    }
    syncInfo.at = Date.now();
  } catch { syncInfo.ok = false; }
  finally {
    syncing = false;
    const el = document.getElementById('sync-status'); if (el) el.textContent = syncLabel();
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}
function syncLabel() {
  if (syncInfo.ok === null) return 'Not synced yet.';
  if (syncInfo.ok === false) return "Couldn't reach the home server, so changes stay on this device for now and sync later.";
  const m = Math.round((Date.now() - syncInfo.at) / 60000);
  return m < 1 ? 'Synced just now.' : `Synced ${m} min ago.`;
}

// ------------------------------------------------------------------ servers
function baseFor(src) {
  return ((src === 'yt' ? S.settings.ytServer : S.settings.scServer) || '').trim().replace(/\/+$/, '');
}
function apiUrl(src, path, params = {}) {
  const u = new URL(baseFor(src) + path, location.href);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  if (S.settings.key) u.searchParams.set('k', S.settings.key);
  return u.toString();
}
async function api(src, path, params, timeout = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(apiUrl(src, path, params), { signal: ctl.signal });
    if (!r.ok) {
      let msg = `Server answered ${r.status}`;
      try { msg = (await r.json()).detail || (await r.json()).error || msg; } catch {}
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long to answer');
    if (e instanceof TypeError) { const err = new Error("Can't reach the server"); err.offline = true; throw err; }
    throw e;
  } finally { clearTimeout(timer); }
}

// health: true = online, false = offline / source turned off, null = not checked yet
const health = { yt: null, sc: null, demo: false };
async function checkHealth() {
  const probe = async (src) => {
    try {
      const h = await api(src, '/api/health', {}, 6000);
      health.demo = health.demo || h.demo;
      return !!h.sources?.[src === 'yt' ? 'youtube' : 'soundcloud'];
    } catch { return false; }
  };
  const [yt, sc] = await Promise.all([probe('yt'), probe('sc')]);
  const changed = yt !== health.yt || sc !== health.sc;
  health.yt = yt; health.sc = sc;
  if (changed) { renderStatusChips(); if (route().name === 'search' && !searchState.results[searchState.src]) renderView(); }
}

// ------------------------------------------------------------------ toast & sheet
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function openSheet(html, onClick) {
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  sheet.onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) onClick(b.dataset.act, b); };
  $('#scrim').classList.add('open'); sheet.classList.add('open');
}
function closeSheet() { $('#scrim').classList.remove('open'); $('#sheet').classList.remove('open'); }
$('#scrim').addEventListener('click', closeSheet);

// ------------------------------------------------------------------ library helpers
const isLiked = (t) => S.liked.some((x) => keyOf(x) === keyOf(t));
function toggleLike(t) {
  const k = keyOf(t);
  const plain = slim(t);
  if (isLiked(t)) { S.liked = S.liked.filter((x) => keyOf(x) !== k); toast('Removed from Liked Songs'); }
  else { S.liked.unshift(plain); toast('Added to Liked Songs'); }
  save(); refreshLikeButtons(); if (['home', 'playlist', 'library'].includes(route().name)) renderView();
}
const slim = ({ source, id, title, artist, album, duration, artwork, url, genre }) => ({ source, id, title, artist, album, duration, artwork, url, ...(genre ? { genre } : {}) });
function addRecent(t) {
  S.recent = [slim(t), ...S.recent.filter((x) => keyOf(x) !== keyOf(t))].slice(0, 50); save();
}
function newPlaylist(name, firstTrack) {
  const p = { id: 'p' + Date.now().toString(36), name: name.trim() || 'My playlist', tracks: firstTrack ? [slim(firstTrack)] : [], created: Date.now() };
  S.playlists.unshift(p); save(); return p;
}
const getPlaylist = (id) => S.playlists.find((p) => p.id === id);
function listFor(id) {
  if (id === 'liked') return { name: 'Liked Songs', tracks: S.liked, kind: 'liked' };
  if (id === 'recent') return { name: 'Recently played', tracks: S.recent, kind: 'recent' };
  const p = getPlaylist(id); return p ? { name: p.name, tracks: orderedTracks(p), kind: 'playlist', p } : null;
}

// ------------------------------------------------------------------ art
function art(url, cls = 'art') {
  return url ? `<div class="${cls} ph" data-art="${esc(url)}"></div>` : `<div class="${cls} ph"></div>`;
}
function absArt(url) { return url ? new URL(url.startsWith('/api/') ? baseFor('sc') + url : url, location.href).toString() : ''; }
function playlistArt(tracks, cls) {
  const arts = [...new Set(tracks.map((t) => t.artwork).filter(Boolean))].slice(0, 4);
  if (arts.length < 4) return art(arts[0] ? absArt(arts[0]) : '', cls);
  return `<div class="${cls} mosaic">${arts.map((a) => `<div class="ph" data-art="${esc(absArt(a))}"></div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ routing
// Each tab has its own stack of pages, like a native app.
const stacks = { home: [{ name: 'home' }], search: [{ name: 'search' }], library: [{ name: 'library' }], discover: [{ name: 'discover' }] };
const TABS = ['home', 'search', 'library', 'discover'];
let tab = 'home';
const scrollMemo = {};
const route = () => stacks[tab][stacks[tab].length - 1];
const pager = $('#views');
const pane = (t = tab) => $('#pane-' + t);
const dirty = new Set();   // panes whose content is out of date (they get redrawn just before they slide in)
function animateView(kind) {
  const v = pane().firstElementChild; if (!v) return;
  v.classList.remove('push', 'pop'); void v.offsetWidth; v.classList.add(kind);
}
function go(r) { scrollMemo[tab + stacks[tab].length] = pane().scrollTop; stacks[tab].push(r); syncSub(); renderView(); pane().scrollTop = 0; animateView('push'); }
function back() { if (stacks[tab].length > 1) { stacks[tab].pop(); syncSub(); renderView(); pane().scrollTop = scrollMemo[tab + stacks[tab].length] || 0; animateView('pop'); } }
const syncSub = () => document.body.classList.toggle('in-sub', stacks[tab].length > 1);
function setTab(t) {
  tab = t; syncSub(); $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  if (t === 'discover') { scanLibraryGenres(); ensureDiscover(); }
}
let pagerTarget = null, pagerTimer;   // while a tap-triggered slide is running, ignore the pages it passes over
function pagerTo(t, smooth) {
  pagerTarget = t; clearTimeout(pagerTimer); pagerTimer = setTimeout(() => { pagerTarget = null; }, 1500);
  pager.scrollTo({ left: TABS.indexOf(t) * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
}
function switchTab(t) {
  if (t === tab) {
    if (stacks[t].length > 1) { stacks[t] = [stacks[t][0]]; syncSub(); renderView(); animateView('pop'); }
    pane().scrollTo({ top: 0, behavior: 'smooth' });
    if (t === 'search') $('#q')?.focus();
    return;
  }
  setTab(t); freshen(t); pagerTo(t, true);
}
// Swiping the pager changes the tab as soon as the next page is more than half in view.
pager.addEventListener('scroll', () => {
  if (pagerTarget) {
    if (Math.abs(pager.scrollLeft - TABS.indexOf(pagerTarget) * pager.clientWidth) < 2) pagerTarget = null;
    return;
  }
  const t = TABS[Math.round(pager.scrollLeft / pager.clientWidth)];
  if (t && t !== tab) { setTab(t); freshen(t); }
}, { passive: true });
pager.addEventListener('touchstart', () => { pagerTarget = null; dirty.forEach(freshen); }, { passive: true });
window.addEventListener('resize', () => pagerTo(tab, false));
$('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });

// lists shown on screen, so a tap on a row knows which list (and position) it belongs to
const shown = {};
function trackRows(listId, tracks, opts = {}) {
  shown[listId] = { tracks, ctx: opts.ctx || '', ctxId: opts.ctxId };
  if (!tracks.length) return '';
  const cur = P.queue[P.index];
  return `<div class="list">${tracks.map((t, i) => `
    <div class="row${cur && keyOf(cur) === keyOf(t) ? ' playing' : ''}${DL.have.has(keyOf(t)) ? ' dl' : ''}" data-list="${listId}" data-i="${i}" data-k="${esc(keyOf(t))}">
      ${art(absArt(t.artwork))}
      <div class="meta"><div class="t">${esc(t.title)}</div>
        <div class="a"><span class="dlb" title="Downloaded">${icon('download')}</span>${isLiked(t) ? `<span class="liked-mark">${icon('heart-fill')}</span>` : ''}<span class="badge ${t.source}">${t.source === 'yt' ? 'YT' : 'SC'}</span>${esc(t.artist)}${t.duration ? ` · ${fmt(t.duration)}` : ''}</div></div>
      <button class="more" data-more aria-label="More options">${icon('more')}</button>
    </div>`).join('')}</div>`;
}
$('#views').addEventListener('click', (e) => {
  const row = e.target.closest('.row[data-list]');
  if (row) {
    const L = shown[row.dataset.list]; const i = +row.dataset.i;
    if (e.target.closest('[data-more]')) trackSheet(L.tracks[i], { listId: L.ctxId, index: i });
    else playList(L.tracks, i, L.ctx);
    return;
  }
  const a = e.target.closest('[data-go]');
  if (a) { const [name, id] = a.dataset.go.split(':'); go({ name, id }); return; }
  const act = e.target.closest('[data-action]');
  if (act) actions[act.dataset.action]?.(act, e);
});

// Swipe a song left to add it to the queue. The row follows the finger, a queue icon appears
// behind it, and letting go past the line adds the song.
// Touch events (not pointer events) are used on purpose: they let us claim a mostly-sideways drag
// right away, so iOS doesn't take it over as a scroll half-way and cancel the swipe.
(() => {
  const FULL = 72, MAX = 120;
  let g = null, mute = 0;
  pager.addEventListener('click', (e) => { if (Date.now() < mute) { e.stopPropagation(); e.preventDefault(); } }, true);

  const begin = (target, x, y) => {
    const row = target.closest('.row[data-list]');
    g = row && !target.closest('[data-more]') ? { row, x, y, on: false } : null;
  };
  const move = (x, y) => {            // true = this drag is ours, so the caller must block scrolling
    if (!g) return false;
    const dx = x - g.x, dy = y - g.y;
    if (!g.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return false; }    // it's a scroll
      if (dx > -6 || Math.abs(dx) < Math.abs(dy) * 1.2) return false;                      // not clearly sideways yet
      g.on = true; g.row.classList.remove('snap'); g.row.classList.add('pulling');
    }
    const pull = Math.min(-dx, 400);
    const shown_ = Math.min(pull > FULL ? FULL + (pull - FULL) * 0.25 : pull, MAX);       // a little give past the line
    g.row.style.transform = `translateX(${-shown_}px)`;
    g.row.style.setProperty('--pull', Math.min(1, pull / FULL).toFixed(3));
    g.row.classList.toggle('armed', pull >= FULL);
    return true;
  };
  const finish = (commit) => {
    if (!g) return;
    const { row, on } = g; g = null;
    if (!on) return;
    mute = Date.now() + 450;                                            // the lift-off must not count as a tap
    const armed = row.classList.contains('armed');
    row.classList.add('snap'); row.style.transform = ''; row.style.setProperty('--pull', 0); row.classList.remove('pulling', 'armed');
    if (armed && commit) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 800); }
    setTimeout(() => row.classList.remove('snap'), 540);
    if (armed && commit) {
      const L = shown[row.dataset.list]; const t = L?.tracks[+row.dataset.i];
      if (t) { addToQueue(t, false); toast(`Added “${t.title}” to queue`); }
    }
  };

  // finger
  pager.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { g = null; return; }
    begin(e.target, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  pager.addEventListener('touchmove', (e) => {
    if (move(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
  }, { passive: false });
  pager.addEventListener('touchend', () => finish(true));
  pager.addEventListener('touchcancel', () => finish(false));

  // mouse (desktop)
  pager.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) begin(e.target, e.clientX, e.clientY); });
  pager.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && g) move(e.clientX, e.clientY); });
  pager.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') finish(true); });
})();

// ------------------------------------------------------------------ views
function renderPane(t) {
  const r = stacks[t][stacks[t].length - 1];
  const html = { home: viewHome, search: viewSearch, library: viewLibrary, discover: viewDiscover, genre: viewGenre, storage: viewStorage, playlist: viewPlaylist, settings: viewSettings, import: viewImport }[r.name](r);
  pane(t).innerHTML = `<div class="view">${html}</div>`;
  dirty.delete(t);
  if (r.name === 'search') bindSearch();
  if (r.name === 'settings') bindSettings();
  if (r.name === 'import') bindImport();
  if (r.name === 'discover' && S.settings.discTab === 'match') bindMatch();
  if (r.name === 'playlist') dlEnsure(r.id);
}
const freshen = (t) => { if (dirty.has(t)) renderPane(t); };
function renderView() {
  renderPane(tab);
  TABS.forEach((t) => { if (t !== tab) dirty.add(t); });
}

function statusChipsHtml() {
  const chip = (src, label) => {
    const v = health[src]; const cls = v === null ? '' : v ? 'on' : 'off';
    return `<span class="status ${cls}" data-status="${src}"><i></i>${label} ${v === null ? '…' : v ? 'online' : 'offline'}</span>`;
  };
  return `<div class="status-row">${chip('yt', 'YouTube (home)')}${chip('sc', 'SoundCloud')}${health.demo ? '<span class="status">Demo mode</span>' : ''}</div>`;
}
function renderStatusChips() { const el = $('.status-row'); if (el) el.outerHTML = statusChipsHtml(); }

function viewHome() {
  const tiles = [`<button class="tile" data-go="playlist:liked"><div class="art liked-art">${icon('heart-fill')}</div><span>Liked Songs</span></button>`];
  S.playlists.slice(0, 5).forEach((p) => tiles.push(`<button class="tile" data-go="playlist:${p.id}">${playlistArt(p.tracks, 'art')}<span>${esc(p.name)}</span></button>`));
  const recent = S.recent.slice(0, 12);
  shown.homeRecent = { tracks: recent, ctx: 'Recently played' };
  return `
    <div class="view-head"><h1>Home</h1><button class="icon-btn" data-go="settings" aria-label="Settings">${icon('gear')}</button></div>
    ${statusChipsHtml()}
    <div class="tiles" style="margin-top:14px">${tiles.join('')}</div>
    ${trendingHtml()}
    ${recent.length ? `<h2>Recently played</h2><div class="rail">${recent.map((t, i) => `
      <button class="card" data-action="playRecent" data-i="${i}">${art(absArt(t.artwork))}<div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></button>`).join('')}</div>`
    : `<div class="empty"><b>Welcome to ${APP_NAME}</b>Search YouTube or SoundCloud to start listening.<div style="margin-top:16px"><button class="btn primary" data-action="toSearch">Search for music</button></div></div>`}
    ${statsHtml()}
    ${S.liked.length ? `<h2>From your Liked Songs</h2>${trackRows('homeLiked', S.liked.slice(0, 5), { ctx: 'Liked Songs' })}` : ''}`;
}

// ---- search: separate searches for YouTube and SoundCloud
const searchState = { src: 'yt', q: { yt: '', sc: '' }, results: { yt: null, sc: null }, error: { yt: null, sc: null }, loading: { yt: false, sc: false }, suggest: [] };
function viewSearch() {
  const st = searchState; const src = st.src;
  const offline = health[src] === false;
  let body = '';
  if (st.loading[src]) body = '<div class="spinner"></div>';
  else if (st.error[src]) body = notice(src, st.error[src]);
  else if (st.results[src]) body = st.results[src].length ? trackRows('search', st.results[src], { ctx: `${SRC_NAME[src]} search` }) : `<div class="empty"><b>No results</b>Try different words.</div>`;
  else if (offline) body = notice(src);
  else {
    const recents = S.searches[src];
    body = recents.length ? `<h2>Recent ${SRC_NAME[src]} searches</h2><div class="suggest">${recents.map((q) => `<button data-action="searchFor" data-q="${esc(q)}">${icon('clock')}${esc(q)}</button>`).join('')}</div>
      <button class="btn" data-action="clearSearches">Clear recent searches</button>`
      : `<div class="empty"><b>Search ${SRC_NAME[src]}</b>${src === 'yt' ? 'Songs and music videos from YouTube Music.' : 'Remixes, mixes, underground and new artists.'}</div>`;
  }
  return `
    <div class="view-head"><h1>Search</h1></div>
    <div class="seg" role="tablist">
      <button data-action="setSrc" data-src="yt" class="${src === 'yt' ? 'active' : ''}"><span class="dot yt"></span>YouTube</button>
      <button data-action="setSrc" data-src="sc" class="${src === 'sc' ? 'active' : ''}"><span class="dot sc"></span>SoundCloud</button>
    </div>
    <form class="searchbox" id="search-form" autocomplete="off">
      <svg class="lead"><use href="#i-search"/></svg>
      <input id="q" type="search" enterkeyhint="search" placeholder="${src === 'yt' ? 'Songs, artists on YouTube' : 'Tracks, remixes on SoundCloud'}" value="${esc(st.q[src])}">
      <button type="button" class="clear ${st.q[src] ? '' : 'hidden'}" data-action="clearQ" aria-label="Clear">${icon('close')}</button>
    </form>
    ${src === 'yt' ? `<div class="chips"><button class="chip ${S.settings.ytKind === 'songs' ? 'active' : ''}" data-action="ytKind" data-kind="songs">Songs</button><button class="chip ${S.settings.ytKind === 'videos' ? 'active' : ''}" data-action="ytKind" data-kind="videos">Videos</button></div>` : ''}
    <div class="suggest" id="suggest"></div>
    ${body}`;
}
function notice(src, err) {
  const other = src === 'yt' ? 'sc' : 'yt';
  const msg = src === 'yt'
    ? 'YouTube search runs on your home server (PC or Raspberry Pi). Turn it on, or search SoundCloud meanwhile.'
    : 'The SoundCloud server is not answering. Check its address in Settings.';
  return `<div class="notice"><div><b>${err ? esc(err) : `${SRC_NAME[src]} is offline`}</b><span class="muted small">${err ? '' : msg}</span>
    <div><button class="btn primary" data-action="retry">Try again</button> ${health[other] !== false ? `<button class="btn" data-action="setSrc" data-src="${other}">Search ${SRC_NAME[other]}</button>` : ''}</div></div></div>`;
}
let searchTimer, suggestTimer, searchSeq = 0;
function bindSearch() {
  const input = $('#q');
  input.addEventListener('input', () => {
    const src = searchState.src; searchState.q[src] = input.value;
    $('.searchbox .clear').classList.toggle('hidden', !input.value);
    clearTimeout(searchTimer); clearTimeout(suggestTimer);
    if (src === 'yt' && input.value.trim().length >= 2 && health.yt) suggestTimer = setTimeout(() => loadSuggest(input.value), 200);
    else $('#suggest').innerHTML = '';
    if (input.value.trim().length >= 2) searchTimer = setTimeout(() => runSearch(false), 650);
  });
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); input.blur(); runSearch(true); });
}
async function loadSuggest(q) {
  try {
    const list = await api('yt', '/api/yt/suggest', { q }, 4000);
    if (searchState.q.yt !== q || searchState.loading.yt) return;
    $('#suggest').innerHTML = list.slice(0, 5).map((s) => `<button data-action="searchFor" data-q="${esc(s)}">${icon('search')}${esc(s)}</button>`).join('');
  } catch {}
}
async function runSearch(remember) {
  const st = searchState; const src = st.src; const q = st.q[src].trim();
  if (!q) return;
  const seq = ++searchSeq;
  st.loading[src] = true; st.error[src] = null; renderSearchBody();
  try {
    const res = src === 'yt' ? await api('yt', '/api/yt/search', { q, kind: S.settings.ytKind }) : await api('sc', '/api/sc/search', { q });
    if (seq !== searchSeq && st.src === src && st.q[src].trim() !== q) return;
    st.results[src] = res; health[src] = true;
    if (remember || res.length) { S.searches[src] = [q, ...S.searches[src].filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12); save(); }
  } catch (e) {
    st.error[src] = e.offline ? `${SRC_NAME[src]} server is offline` : e.message; st.results[src] = null;
    if (e.offline) health[src] = false;
  } finally { st.loading[src] = false; if (route().name === 'search') renderSearchBody(); }
}
function renderSearchBody() {
  // Re-render but keep the keyboard open and the caret where it was.
  const input = $('#q'); const focused = document.activeElement === input; const pos = input?.selectionStart;
  renderView();
  if (focused) { const i = $('#q'); i.focus(); try { i.setSelectionRange(pos, pos); } catch {} }
}

function viewLibrary() {
  return `
    <div class="view-head"><h1>Your Library</h1><div style="display:flex"><button class="icon-btn" data-action="newPlaylist" aria-label="New playlist">${icon('plus')}</button><button class="icon-btn" data-go="settings" aria-label="Settings">${icon('gear')}</button></div></div>
    <button class="lib-row" data-go="playlist:liked"><div class="art liked-art">${icon('heart-fill')}</div><div><div class="t">Liked Songs</div><div class="a">Playlist · ${songs(S.liked.length)}</div></div></button>
    <button class="lib-row" data-go="playlist:recent"><div class="art liked-art" style="background:linear-gradient(135deg,var(--accent-3),var(--accent))">${icon('clock')}</div><div><div class="t">Recently played</div><div class="a">${songs(S.recent.length)}</div></div></button>
    ${S.playlists.map(libRow).join('')}
    <button class="lib-row" data-go="import:new"><div class="art liked-art" style="background:linear-gradient(135deg,var(--accent-2),var(--accent))">${icon('swap')}</div><div><div class="t">Import playlist</div><div class="a">Bring songs over from Spotify</div></div></button>
    ${!S.playlists.length ? `<div class="empty" style="padding:24px 16px">Make playlists with songs from both YouTube and SoundCloud.<div style="margin-top:14px"><button class="btn primary" data-action="newPlaylist">Create playlist</button></div></div>` : ''}`;
}

function viewPlaylist(r) {
  const L = listFor(r.id);
  if (!L) return `<button class="icon-btn back" data-action="back">${icon('back')}</button><div class="empty"><b>Playlist not found</b></div>`;
  const total = L.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const cover = L.kind === 'liked' ? `<div class="art liked-art">${icon('heart-fill')}</div>` : playlistArt(L.tracks, 'art');
  return `
    <button class="icon-btn back" data-action="back" aria-label="Back">${icon('back')}</button>
    <div class="pl-head">${cover}<h1>${esc(L.name)}</h1><div class="muted small">${songs(L.tracks.length)}${total ? ` · ${Math.round(total / 60)} min` : ''}</div></div>
    ${plChips(L)}
    <div class="pl-actions">
      ${L.kind === 'playlist' ? `<button class="icon-btn" data-action="playlistMenu" data-id="${r.id}" aria-label="Playlist options">${icon('more')}</button>` : ''}
      ${L.kind === 'playlist' || L.kind === 'liked' ? dlButton(r.id) : ''}
      <div class="grow"></div>
      <button class="icon-btn ${P.shuffle ? 'on' : ''}" style="${P.shuffle ? 'color:var(--accent)' : ''}" data-action="shufflePlay" data-id="${r.id}" aria-label="${modeLabel()}">${icon('shuffle')}${P.smart ? '<span class="smt">✦</span>' : ''}</button>
      <button class="play-fab" data-action="playAll" data-id="${r.id}" aria-label="Play">${icon('play')}</button>
    </div>
    ${trackRows('pl', L.tracks, { ctx: L.name, ctxId: r.id }) || `<div class="empty"><b>Nothing here yet</b>Tap ⋯ on any song to add it.</div>`}`;
}

const THEMES = [
  ['sunset', 'Sunset', '#ff4f86', '#ffc247', '#0b0612'], ['aurora', 'Aurora', '#2ef2b0', '#b266ff', '#040b12'], ['neon', 'Neon', '#ff2bd6', '#22e5ff', '#08040f'], ['midnight', 'Midnight', '#6ee7f9', '#a78bfa', '#080910'],
  ['ocean', 'Ocean', '#38bdf8', '#2dd4bf', '#03101a'], ['forest', 'Forest', '#4ade80', '#a3e635', '#050f0a'], ['ember', 'Ember', '#e11d48', '#ffb020', '#0f0605'], ['rose', 'Rose', '#f472b6', '#c084fc', '#120711'],
  ['gold', 'Gold', '#fde68a', '#f59e0b', '#0a0906'], ['lavender', 'Lavender', '#a78bfa', '#f0abfc', '#0b0814'], ['mono', 'Mono', '#f5f5f5', '#8b8b93', '#070707'],
];
const THEME_BG = Object.fromEntries(THEMES.map((t) => [t[0], t[4]]));
function applyTheme(name) {
  name = THEME_BG[name] ? name : 'sunset';
  document.documentElement.dataset.theme = name;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[name]);
}
// designs: the shape of covers, what the background does, whether covers spin
const DEFAULT_STYLE = { covers: 'circle', bg: 'aurora', spin: 'on' };
const STYLE_OPTS = [
  ['covers', 'Cover shape', [['circle', 'Circles'], ['round', 'Rounded'], ['square', 'Square']]],
  ['bg', 'Background', [['aurora', 'Animated'], ['still', 'Still'], ['plain', 'Plain']]],
  ['spin', 'Spinning covers', [['on', 'Spin'], ['off', 'Still']]],
];
const styleOf = (k) => (S.settings.style || {})[k] || DEFAULT_STYLE[k];
function applyStyle() { for (const k of Object.keys(DEFAULT_STYLE)) document.documentElement.dataset[k] = styleOf(k); }
function viewSettings() {
  const s = S.settings;
  return `
    <button class="icon-btn back" data-action="back" aria-label="Back">${icon('back')}</button>
    <div class="view-head"><h1>Settings</h1></div>
    ${statusChipsHtml()}
    <div class="group-title" style="margin-top:18px">Appearance</div>
    <div class="group"><div class="field"><div class="theme-row">${THEMES.map(([k, n, a, b]) => `<button class="theme-opt${(s.theme || 'sunset') === k ? ' on' : ''}" data-action="setTheme" data-v="${k}"><i style="background:linear-gradient(135deg,${a},${b})"></i>${n}</button>`).join('')}</div></div></div>
    <div class="group-title">Style</div>
    <div class="group">${STYLE_OPTS.map(([k, label, opts]) => `<div class="field"><label>${label}</label><div class="seg wide">${opts.map(([v, n]) => `<button class="${styleOf(k) === v ? 'on' : ''}" data-action="setStyle" data-k="${k}" data-v="${v}">${n}</button>`).join('')}</div></div>`).join('')}</div>
    <div class="group-title">Servers</div>
    <div class="group">
      <div class="field"><label for="s-yt">YouTube server (home PC / Raspberry Pi)</label>
        <input id="s-yt" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Same as this app" value="${esc(s.ytServer)}">
        <div class="hint">Example: https://my-pc.tailnet-name.ts.net. Leave empty if this app is served by the home server.</div></div>
      <div class="field"><label for="s-sc">SoundCloud server (always on)</label>
        <input id="s-sc" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Same as this app" value="${esc(s.scServer)}">
        <div class="hint">Your cloud server's address. Leave empty if this app is served by it.</div></div>
      <div class="field"><label for="s-key">Access key</label>
        <input id="s-key" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Only if your servers use one" value="${esc(s.key)}"></div>
      <div class="btn-row"><button class="btn primary" data-action="saveServers">Save and check</button></div>
    </div>
    <div class="group-title">Playback</div>
    <div class="group">
      <div class="field toggle-row"><div><div>Autoplay</div><div class="hint">Keep playing similar songs when the queue ends.</div></div>
        <label class="switch"><input type="checkbox" id="s-autoplay" ${s.autoplay ? 'checked' : ''}><span></span></label></div>
      <div class="field toggle-row"><div><div>SoundCloud fallback</div><div class="hint">When the home server is off or a YouTube song fails, play the SoundCloud copy.</div></div>
        <label class="switch"><input type="checkbox" id="s-fallback" ${s.fallback ? 'checked' : ''}><span></span></label></div>
      <div class="field toggle-row"><div><div>Seamless transitions</div><div class="hint">When this song and the next are both downloaded, the next one blends in before this one ends, like a DJ mix, instead of stopping and starting.</div></div>
        <label class="switch"><input type="checkbox" id="s-seamless" ${s.seamless ? 'checked' : ''}><span></span></label></div>
      ${s.seamless ? `<div class="field"><label>Blend length</label><div class="seg wide">${MIX_LENS.map(([v, n]) => `<button class="${mixLen() === v ? 'on' : ''}" data-action="mixLen" data-v="${v}">${n} · ${v}s</button>`).join('')}</div>
        <div class="hint">Songs whose ending fades out get a longer blend, up to 60% longer.</div></div>` : ''}
    </div>
    <div class="group-title">Your library</div>
    <div class="group">
      <div class="btn-row"><button class="btn primary" data-go="import:new">Import from Spotify</button></div>
      <div class="field"><div class="hint" style="margin:0">Likes and playlists sync through your home server, so your phone and PC match. <span id="sync-status">${esc(syncLabel())}</span> A backup is still a good idea.</div></div>
      <div class="btn-row"><button class="btn" data-action="syncNow">Sync now</button></div>
      <button class="stg-link" data-go="storage">${icon('download')}<span>Downloads & storage<small>${DL.have.size ? `${songs(DL.have.size)} · ${mb([...DL.have.values()].reduce((a, b) => a + b, 0))}` : 'Save playlists on your phone for offline listening'}</small></span>${icon('back')}</button>
      <div class="btn-row"><button class="btn" data-action="backup">Back up library</button><button class="btn" data-action="restore">Restore backup</button></div>
    </div>
    <p class="muted small" style="text-align:center">${APP_NAME} · personal use</p>
    <input type="file" id="restore-file" accept="application/json,.json" class="hidden">`;
}
function bindSettings() {
  $('#s-autoplay').onchange = (e) => { S.settings.autoplay = e.target.checked; save(); };
  $('#s-fallback').onchange = (e) => { S.settings.fallback = e.target.checked; save(); };
  $('#s-seamless').onchange = (e) => {
    S.settings.seamless = e.target.checked; save();
    if (e.target.checked) { mxUnlock(); toast('Seamless transitions on: starts with the next downloaded song you play'); } else { mxDropPrep(); }
    renderView();
  };
  $('#restore-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.liked) || !Array.isArray(d.playlists)) throw new Error();
      S.liked = d.liked; S.playlists = d.playlists; S.recent = d.recent || S.recent; save(); toast('Library restored'); renderView();
    } catch { toast("That file isn't a library backup"); }
  };
}

// ------------------------------------------------------------------ actions
const actions = {
  back,
  toSearch: () => switchTab('search'),
  playRecent: (b) => playList(shown.homeRecent.tracks, +b.dataset.i, 'Recently played'),
  setSrc: (b) => {
    const src = b.dataset.src; if (searchState.src === src && route().name === 'search') return;
    // carry the words over if the other tab is empty, so "search SoundCloud instead" just works
    if (!searchState.q[src] && searchState.q[searchState.src]) { searchState.q[src] = searchState.q[searchState.src]; searchState.results[src] = null; }
    searchState.src = src; if (tab !== 'search') switchTab('search'); else renderView();
    if (searchState.q[src] && !searchState.results[src]) runSearch(false);
  },
  ytKind: (b) => { S.settings.ytKind = b.dataset.kind; save(); searchState.results.yt = null; renderView(); if (searchState.q.yt) runSearch(false); },
  searchFor: (b) => { searchState.q[searchState.src] = b.dataset.q; renderView(); runSearch(true); },
  clearQ: () => { const s = searchState.src; searchState.q[s] = ''; searchState.results[s] = null; searchState.error[s] = null; renderView(); $('#q').focus(); },
  clearSearches: () => { S.searches[searchState.src] = []; save(); renderView(); },
  retry: async () => { await checkHealth(); searchState.error[searchState.src] = null; if (searchState.q[searchState.src]) runSearch(false); else renderView(); },
  playAll: (b) => { const L = listFor(b.dataset.id); if (L?.tracks.length) { setShuffle(false); playList(L.tracks, 0, L.name); } },
  shufflePlay: (b) => {                                       // Off -> Shuffle -> Smart mix -> Off
    const L = listFor(b.dataset.id); if (!L?.tracks.length) return;
    const mode = NEXT_MODE[shuffleMode()];
    if (P.index < 0 || P.ctx !== L.name) {                        // something else is playing: start this playlist in that mode
      P.shuffle = mode !== 'off'; P.smart = mode === 'smart';
      playList(L.tracks, mode === 'off' ? 0 : Math.floor(Math.random() * L.tracks.length), L.name);
      syncShuffleUi(); if (P.smart) smartScan();
    } else setMode(mode);
    toastMode(); renderView();
  },
  newPlaylist: () => promptName('New playlist', '', (name) => { const p = newPlaylist(name); toast(`Created “${p.name}”`); if (tab === 'library') go({ name: 'playlist', id: p.id }); }),
  playlistMenu: (b) => playlistSheet(b.dataset.id),
  saveServers: async () => {
    S.settings.ytServer = $('#s-yt').value.trim(); S.settings.scServer = $('#s-sc').value.trim(); S.settings.key = $('#s-key').value.trim(); save();
    health.yt = health.sc = null; renderStatusChips(); await checkHealth(); renderStatusChips();
    toast(health.yt || health.sc ? 'Saved' : "Saved, but neither server answers yet");
  },
  backup: () => {
    const blob = new Blob([JSON.stringify({ app: APP_NAME, saved: new Date().toISOString(), liked: S.liked, playlists: S.playlists, recent: S.recent }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${APP_NAME.toLowerCase()}-library-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },
  restore: () => $('#restore-file').click(),
  setStyle: (b) => { S.settings.style = { ...(S.settings.style || {}), [b.dataset.k]: b.dataset.v }; save(); applyStyle(); renderPane(tab); },
  setTheme: (b) => { S.settings.theme = b.dataset.v; save(); applyTheme(b.dataset.v); renderPane(tab); },
  syncNow: async () => { await syncNow(); toast(syncInfo.ok ? 'Library synced' : "Couldn't reach the home server"); },
};

function promptName(title, value, done) {
  openSheet(`<div class="sheet-title">${esc(title)}</div><div class="sheet-pad"><input id="name-in" maxlength="80" placeholder="Playlist name" value="${esc(value)}">
    <div style="display:flex;gap:8px;justify-content:flex-end;padding-bottom:6px"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Save</button></div></div>`,
  (act) => { if (act === 'ok') { const v = $('#name-in').value.trim(); if (!v) return; closeSheet(); done(v); } else closeSheet(); });
  const inp = $('#name-in'); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sheet [data-act=ok]').click(); });
  setTimeout(() => inp.focus(), 250);
}

function trackSheet(t, ctx = {}) {
  const inPlaylist = ctx.listId && getPlaylist(ctx.listId);
  const items = [
    ['next', 'next-up', 'Play next'],
    ['queue', 'addq', 'Add to queue'],
    ['like', isLiked(t) ? 'heart-fill' : 'heart', isLiked(t) ? 'Remove from Liked Songs' : 'Add to Liked Songs'],
    ['addpl', 'plus', 'Add to playlist'],
    ['similar', 'compass', 'Find similar…'],
    t.source === 'yt' ? ['video', 'video', 'Play video'] : null,
    t.source === 'yt' ? ['scver', 'swap', 'Play the SoundCloud version'] : null,
    t.url ? ['copy', 'link', 'Copy link'] : null,
    inPlaylist ? ['remove', 'trash', 'Remove from this playlist', 'danger'] : null,
  ].filter(Boolean);
  openSheet(`<div class="sheet-head">${art(absArt(t.artwork))}<div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)} · ${SRC_NAME[t.source]}</div></div></div>
    ${items.map(([a, ic, label, cls]) => `<button class="act ${cls || ''}" data-act="${a}">${icon(ic)}${label}</button>`).join('')}`,
  async (act) => {
    closeSheet();
    if (act === 'next') { addToQueue(t, true); toast('Plays next'); }
    else if (act === 'queue') { addToQueue(t, false); toast('Added to queue'); }
    else if (act === 'like') toggleLike(t);
    else if (act === 'addpl') setTimeout(() => addToPlaylistSheet(t), 260);
    else if (act === 'copy') { try { await navigator.clipboard.writeText(t.url); toast('Link copied'); } catch { toast("Couldn't copy"); } }
    else if (act === 'similar') findSimilar(t);
    else if (act === 'video') playVideo(t);
    else if (act === 'remove') { let i = inPlaylist.tracks.indexOf(t); if (i < 0) i = inPlaylist.tracks.findIndex((x) => keyOf(x) === keyOf(t)); if (i >= 0) inPlaylist.tracks.splice(i, 1); save(); renderView(); dlGc(); toast('Removed'); }
    else if (act === 'scver') {
      toast('Looking on SoundCloud…');
      const alt = await scMatch(t);
      if (alt) playList([alt], 0, 'SoundCloud version'); else toast('No SoundCloud version found');
    }
  });
}
function addToPlaylistSheet(t) {
  openSheet(`<div class="sheet-title">Add to playlist</div>
    <button class="act" data-act="new">${icon('plus')}New playlist</button>
    ${S.playlists.map((p) => `<button class="act" data-act="p:${p.id}">${playlistArt(p.tracks, 'art')}${esc(p.name)}</button>`).join('')}`,
  (act) => {
    closeSheet();
    if (act === 'new') setTimeout(() => promptName('New playlist', '', (name) => { const p = newPlaylist(name, t); toast(`Added to “${p.name}”`); if (route().name === 'library') renderView(); }), 260);
    else {
      const p = getPlaylist(act.slice(2));
      if (p.tracks.some((x) => keyOf(x) === keyOf(t))) return toast(`Already in “${p.name}”`);
      p.tracks.push(slim(t)); save(); toast(`Added to “${p.name}”`);
      if (route().name === 'playlist' || route().name === 'library') renderView();
    }
  });
  $$('#sheet .act .art').forEach((el) => { el.style.cssText += ';width:36px;height:36px;border-radius:4px'; });
}
function playlistSheet(id) {
  const p = getPlaylist(id); if (!p) return;
  openSheet(`<div class="sheet-title">${esc(p.name)}</div>
    <button class="act" data-act="rename">${icon('edit')}Rename</button>
    <button class="act" data-act="queue">${icon('addq')}Add all to queue</button>
    <button class="act danger" data-act="delete">${icon('trash')}Delete playlist</button>`,
  (act) => {
    closeSheet();
    if (act === 'rename') setTimeout(() => promptName('Rename playlist', p.name, (name) => { p.name = name; save(); renderView(); }), 260);
    else if (act === 'queue') { orderedTracks(p).forEach((t) => addToQueue(t, false)); toast(`Added ${songs(p.tracks.length)} to queue`); }
    else if (act === 'delete') setTimeout(() => openSheet(`<div class="sheet-title">Delete “${esc(p.name)}”?</div><div class="sheet-pad muted small" style="padding-bottom:8px">This can't be undone (unless you have a backup).</div>
        <button class="act danger" data-act="yes">${icon('trash')}Delete</button><button class="act" data-act="no">Cancel</button>`,
      (a) => { closeSheet(); if (a === 'yes') { S.playlists = S.playlists.filter((x) => x.id !== id); delete SH[id]; save(); back(); dlGc(); toast('Playlist deleted'); } }), 260);
  });
}

// ------------------------------------------------------------------ player
// `audio` is whichever element plays the current song. Normally that's the page's own <audio>; with
// Seamless transitions on, downloaded songs play on two extra "decks" so one song can fade out while the
// next fades in, and `audio` switches to the incoming deck the moment a blend starts. Everything that
// reads `audio` (seek bar, lock screen, stats, A-B loop, lyrics) therefore follows the current song.
const mainEl = $('#audio');
let audio = mainEl;
const mkDeck = () => { const el = document.createElement('audio'); el.preload = 'auto'; el.setAttribute('playsinline', ''); document.body.appendChild(el); return el; };
const MX = { ctx: null, decks: [{ el: mkDeck() }, { el: mkDeck() }], prep: null, fading: null, fadeTimer: 0, info: {}, busy: new Set(), failed: new Set(), work: Promise.resolve() };
const DECKS = [mainEl, ...MX.decks.map((d) => d.el)];
// listen to "the current song", whichever element that is: events from a song fading out are ignored
function onAudio(type, fn) { for (const el of DECKS) el.addEventListener(type, (e) => { if (el === audio) fn(e); }); }
const P = { queue: [], index: -1, ctx: '', shuffle: false, smart: false, repeat: 'off', original: null, playing: null, via: '', errors: 0, autoplayed: new Set() };

// iOS only lets audio start from a tap. Playing a silent sound on the first tap "unlocks" the
// element, so later plays (after a network request, or from the lock screen) are allowed too.
let unlocked = false;
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
document.addEventListener('pointerdown', () => {
  if (unlocked || mainEl.src) return;
  unlocked = true; mainEl.src = SILENT; mainEl.play().then(() => mainEl.pause()).catch(() => {});
}, { capture: true, once: false });
// the blend decks and the mixer need the same unlocking; on a touch screen it's the finger lifting that counts
for (const type of ['pointerup', 'touchend']) document.addEventListener(type, () => { if (S.settings.seamless) mxUnlock(); }, { capture: true });

function streamUrl(t) { return apiUrl(t.source, `/api/${t.source}/stream/${encodeURIComponent(t.id)}`); }

async function scMatch(t) {
  if (health.sc === false) return null;
  try { return await api('sc', '/api/sc/match', { title: t.title, artist: t.artist, duration: t.duration || '' }, 12000); } catch { return null; }
}

function playList(tracks, i, ctx) {
  if (S.settings.miniHidden) { S.settings.miniHidden = false; applyMini(); }      // starting something brings the song bar back
  const kept = P.queue.slice(P.index + 1).filter((x) => x.q);     // songs you queued by hand survive a change of song
  P.queue = tracks.map(slim); P.index = i; P.ctx = ctx || ''; P.original = null; P.autoplayed.clear();
  if (P.shuffle) shuffleRest();                                  // shuffle / Smart mix: every other song of the list can come next
  if (kept.length) P.queue.splice(P.index + 1, 0, ...kept);
  loadCurrent(true);
}
function addToQueue(t, next) {
  if (P.index < 0) { playList([t], 0, 'Queue'); return; }
  // Songs you queue play before the rest of the playlist, in the order you added them
  // ("Play next" jumps ahead of the others you already queued). `q` marks them.
  const item = { ...slim(t), q: true };
  let at = P.index + 1;
  if (!next) while (P.queue[at]?.q) at++;
  P.queue.splice(at, 0, item);
  if (P.original) P.original.push(item);
  if (P.smart) smartPick();                                       // Smart mix picks what follows the queued songs
  renderQueue(); saveSession();
}

let loadSeq = 0;
// `pre`: a blend already started this song on the other deck ({ deck, url }), so only the screen changes
async function loadCurrent(autoplay, resumeAt = 0, pre = null) {
  const t = P.queue[P.index]; if (!t) return;
  const seq = ++loadSeq;
  P.via = ''; let src = t;
  updateNowPlaying(t); listenReset(t); abClear();                  // a loop belongs to one song
  const local = pre ? pre.url : DL.have.has(keyOf(t)) ? await dlUrl(t) : null;      // a downloaded copy always wins (and needs no server)
  if (seq !== loadSeq) { if (local && !pre) URL.revokeObjectURL(local); return; }
  // Home server off: go straight to SoundCloud instead of waiting for an error.
  if (!local && t.source === 'yt' && health.yt === false && S.settings.fallback) {
    setVia('Home server is off · looking on SoundCloud…');
    const alt = await scMatch(t);
    if (seq !== loadSeq) return;
    if (alt) { src = alt; P.via = 'Playing the SoundCloud version (home server is off)'; }
    else { setVia(''); toast('Home server is off and no SoundCloud copy was found'); return skipAfterError(); }
  }
  P.playing = src;
  if (local) P.via = S.settings.seamless ? 'Downloaded · plays offline · seamless' : 'Downloaded · plays offline';
  if (pre) audio = pre.deck;                                       // already playing: just make it the current song
  else {
    useEl(mainEl);                                               // songs always play on the main player (lock screen works)
    audio.src = local || streamUrl(src);
  }
  if (DL.cur && DL.cur !== MX.fading?.url) URL.revokeObjectURL(DL.cur);   // (the song fading out still needs its file)
  DL.cur = local;
  if (resumeAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = resumeAt; }, { once: true });
  setVia(P.via);
  if (autoplay && !pre) audio.play().catch((e) => { if (e.name === 'NotAllowedError') setPlayingUi(false); });
  addRecent(t); saveSession(); renderQueue(); highlightRows();
  if (lyricsOpen()) loadLyrics();
  if (P.smart) { smartPick(); smartFacts(); }
  prefetchNext();
  if (local && S.settings.seamless) mxAnalyze(t);
}

// Warm the server's cache for the next YouTube song so it starts faster.
function prefetchNext() {
  const n = P.queue[P.index + 1];
  if (n && n.source === 'yt' && health.yt && !DL.have.has(keyOf(n))) fetch(apiUrl('yt', `/api/yt/stream/${n.id}`), { headers: { Range: 'bytes=0-1' } }).catch(() => {});
}

async function next(auto = false) {
  if (P.repeat === 'one' && auto) { audio.currentTime = 0; audio.play(); return; }
  if (P.index < P.queue.length - 1) { P.index++; return loadCurrent(true); }
  if (P.repeat === 'all' && P.queue.length) { P.index = 0; return loadCurrent(true); }
  if (S.settings.autoplay && (await autoplayMore())) { P.index++; return loadCurrent(true); }
  if (auto) { setPlayingUi(false); audio.currentTime = 0; audio.pause(); }
}
function prev() {
  if (audio.currentTime > 3 || P.index <= 0) { audio.currentTime = 0; return; }
  P.index--; loadCurrent(true);
}
// a swipe means "the song before", even if this one has been playing a while
function previousSong() {
  if (P.index <= 0) { audio.currentTime = 0; return; }
  P.index--; loadCurrent(true);
}
async function autoplayMore() {
  const seed = P.queue[P.index]; if (!seed) return false;
  const src = seed.source === 'yt' && health.yt ? 'yt' : 'sc';
  try {
    let more;
    if (src === 'yt') more = await api('yt', `/api/yt/radio/${seed.id}`);
    else if (seed.source === 'sc') more = await api('sc', `/api/sc/related/${seed.id}`);
    else { const m = await scMatch(seed); more = m ? await api('sc', `/api/sc/related/${m.id}`) : []; }
    const have = new Set(P.queue.map(keyOf));
    more = more.filter((t) => !have.has(keyOf(t))).slice(0, 15);
    if (!more.length) return false;
    P.queue.push(...more); if (P.original) P.original.push(...more);
    P.ctx = P.ctx.startsWith('Autoplay') ? P.ctx : `Autoplay · based on ${seed.title}`;
    renderQueue(); return true;
  } catch { return false; }
}
function skipAfterError() {
  P.errors++;
  if (P.errors >= 3) { P.errors = 0; setPlayingUi(false); toast('Several songs failed to play. Check your servers in Settings.'); return; }
  setTimeout(() => next(true), 1200);
}

onAudio('ended', () => next(true));
onAudio('playing', () => { P.errors = 0; setPlayingUi(true); });
onAudio('play', () => setPlayingUi(true));
onAudio('pause', () => setPlayingUi(false));
onAudio('error', async () => {
  if (!audio.src || audio.src === SILENT || !P.playing) return;
  const t = P.queue[P.index];
  if (audio.src.startsWith('blob:') && DL.cur && t) {      // a downloaded file turned out to be unreadable: forget it and stream instead
    dlDelTrack(keyOf(t)); DL.cur = null; useEl(mainEl); audio.src = streamUrl(P.playing); audio.play().catch(() => {}); return;
  }
  // A YouTube song failed: try its SoundCloud copy before giving up.
  if (P.playing.source === 'yt' && S.settings.fallback && t) {
    setVia('YouTube failed · trying SoundCloud…');
    const seq = loadSeq; const alt = await scMatch(t);
    if (seq !== loadSeq) return;
    if (alt) { P.playing = alt; P.via = 'Playing the SoundCloud version (YouTube failed)'; setVia(P.via); audio.src = streamUrl(alt); audio.play().catch(() => {}); return; }
  }
  setVia(''); toast(`Couldn't play “${t?.title || 'this song'}”`); skipAfterError();
});

function setShuffle(on) {
  if (!on) P.smart = false;
  if (on === P.shuffle) { syncShuffleUi(); return; }
  P.shuffle = on;
  if (on) shuffleRest();
  else if (P.original) {
    const cur = P.queue[P.index];
    const upQ = P.queue.slice(P.index + 1).filter((x) => x.q);        // hand-queued songs stay right after this one
    const base = P.original.filter((x) => !x.q);
    let at = base.findIndex((x) => keyOf(x) === keyOf(cur));
    if (at < 0) { base.unshift(cur); at = 0; }
    base.splice(at + 1, 0, ...upQ);
    P.queue = base; P.index = at; P.original = null;
  }
  syncShuffleUi(); renderQueue(); saveSession();
}
// every song except the one playing gets a random place after it (songs already played too, like
// Spotify); songs you queued by hand stay right after the current one
function shuffleRest() {
  if (!P.original) P.original = P.queue.slice();                 // (Smart mix -> Shuffle keeps the real original)
  const cur = P.queue[P.index]; if (!cur) return;
  const queued = P.queue.filter((x, j) => j > P.index && x.q);
  const rest = P.queue.filter((x, j) => j !== P.index && !(j > P.index && x.q));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  P.queue = [cur, ...queued, ...rest]; P.index = 0;
}
function syncRepeat() {
  for (const id of ['#p-repeat', '#mini-repeat']) { $(id).classList.toggle('on', P.repeat !== 'off'); $(id + ' .one').classList.toggle('hidden', P.repeat !== 'one'); }
}
function cycleRepeat() {
  P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat];
  syncRepeat();
  toast({ off: 'Repeat off', all: 'Repeating the queue', one: 'Repeating this song' }[P.repeat]);
  saveSession();
}

// ---- now playing UI
function hueOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function updateNowPlaying(t) {
  $('#mini').classList.remove('hidden'); applyMini();
  const artUrl = absArt(t.artwork);
  for (const el of [$('#mini .art'), $('#player .big-art')]) setArt(el, artUrl);
  $('#mini .t').textContent = t.title; $('#mini .a').textContent = t.artist;
  $('#p-title').textContent = t.title;
  $('#p-artist').innerHTML = `<span class="badge ${t.source}">${t.source === 'yt' ? 'YT' : 'SC'}</span>${esc(t.artist)}`;
  $('#p-ctx').textContent = P.ctx || SRC_NAME[t.source];
  const hue = hueOf(t.title + t.artist);   // each song gets its own colour glow
  $('#player').style.setProperty('--tint', `hsl(${hue} 55% 24%)`);
  $('#player').style.setProperty('--glow', `hsl(${hue} 95% 60% / .42)`);
  document.documentElement.style.setProperty('--song-h', hue);      // the whole app's glow follows the song
  refreshLikeButtons(); updateTime();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || SRC_NAME[t.source],
      artwork: artUrl ? [{ src: artCandidates(artUrl, 720)[0], sizes: '512x512' }] : [{ src: new URL('icons/icon-512.png', location.href).toString(), sizes: '512x512', type: 'image/png' }],
    });
    registerMediaKeys();
  }
}
function setVia(msg) { $('#p-via').textContent = msg || ''; }
function setPlayingUi(playing) {
  const id = playing ? 'pause' : 'play';
  $('#mini-pp use').setAttribute('href', `#i-${id}`); $('#p-pp use').setAttribute('href', `#i-${id}`);
  $('#mini-pp').setAttribute('aria-label', playing ? 'Pause' : 'Play'); $('#p-pp').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#player').classList.toggle('paused', !playing);
  $('#mini').classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  document.body.classList.toggle('playing', playing);        // the background breathes while music plays
}
function refreshLikeButtons() {
  const t = P.queue[P.index]; const on = t && isLiked(t);
  $('#p-like').classList.toggle('on', !!on); $('#p-like use').setAttribute('href', on ? '#i-heart-fill' : '#i-heart');
  $('#mini-like use').setAttribute('href', on ? '#i-heart-fill' : '#i-heart'); $('#mini-like').classList.toggle('on', !!on);
}
function highlightRows() {
  const cur = P.queue[P.index]; const k = cur && keyOf(cur);
  $$('.row[data-list]').forEach((r) => { const L = shown[r.dataset.list]; const t = L?.tracks[+r.dataset.i]; r.classList.toggle('playing', !!t && keyOf(t) === k); });
}

let dragging = false, lastPosUpdate = 0;
function updateTime() {
  const d = audio.duration && isFinite(audio.duration) ? audio.duration : (P.queue[P.index]?.duration || 0);
  const c = dragging ? dragging.time : audio.currentTime || 0;
  const pct = d ? Math.min(100, (c / d) * 100) : 0;
  $('#mini .bar i').style.width = pct + '%';
  $('#p-seek .fill').style.width = pct + '%'; $('#p-seek .knob').style.left = pct + '%';
  try { const b = audio.buffered; if (b.length && d) $('#p-seek .buf').style.width = Math.min(100, (b.end(b.length - 1) / d) * 100) + '%'; } catch {}
  $('#p-cur').textContent = fmt(c); $('#p-dur').textContent = fmt(d);
  if (lyricsOpen()) syncLyrics(c);
  const now = Date.now();
  if ('mediaSession' in navigator && d && now - lastPosUpdate > 1000) {
    lastPosUpdate = now;
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: audio.playbackRate || 1 }); } catch {}
  }
  if (now - lastSessionSave > 5000) saveSession();
}
onAudio('timeupdate', updateTime);
onAudio('durationchange', updateTime);
onAudio('progress', updateTime);

// seek bar (drag with a finger)
const seekEl = $('#p-seek');
function seekAt(e) {
  const r = seekEl.getBoundingClientRect(); const d = audio.duration || 0;
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
}
seekEl.addEventListener('pointerdown', (e) => { seekEl.setPointerCapture(e.pointerId); dragging = { time: seekAt(e) }; updateTime(); });
seekEl.addEventListener('pointermove', (e) => { if (dragging) { dragging.time = seekAt(e); updateTime(); } });
seekEl.addEventListener('pointerup', () => { if (dragging) { if (isFinite(dragging.time)) audio.currentTime = dragging.time; dragging = false; updateTime(); } });
seekEl.addEventListener('pointercancel', () => { dragging = false; updateTime(); });

function togglePlay() {
  if (!audio.src || audio.src === SILENT) { if (P.index >= 0) loadCurrent(true, S.session?.position || 0); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

// controls
// the song bar: buttons, swipe left/right for next/previous, drag down to tuck it away (the little glowing handle brings it back)
function applyMini() {
  const stowed = !!S.settings.miniHidden, mini = $('#mini');
  mini.classList.toggle('stowed', stowed);
  $('#mini-handle').classList.toggle('hidden', !stowed || mini.classList.contains('hidden'));
}
(() => {
  const mini = $('#mini'), main = $('#mini .mini-main'), handle = $('#mini-handle');
  let g = null, swallow = 0;
  const stow = (on) => { S.settings.miniHidden = !!on; save(); applyMini(); };
  mini.addEventListener('click', (e) => {
    if (Date.now() < swallow) return;                  // that was the end of a drag, not a tap
    if (e.target.closest('#mini-pp')) return togglePlay();
    if (e.target.closest('#mini-like')) { const t = P.queue[P.index]; if (t) toggleLike(t); return; }
    if (e.target.closest('#mini-prev')) return prev();
    if (e.target.closest('#mini-next')) return next(false);
    if (e.target.closest('#mini-repeat')) return cycleRepeat();
    openPlayer();
  });
  mini.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; g = { x: e.clientX, y: e.clientY, mode: '', t: Date.now() }; });
  mini.addEventListener('pointermove', (e) => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.mode === 'y' && dy < 0) { g = null; return; }
      mini.classList.add('dragging'); try { mini.setPointerCapture(e.pointerId); } catch {}
    }
    if (g.mode === 'x') { main.style.transition = 'none'; main.style.transform = `translate3d(${(dx * 0.7).toFixed(1)}px, 0, 0)`; main.style.opacity = (1 - Math.min(Math.abs(dx), 180) / 360).toFixed(2); }
    else { const y = Math.max(0, dy); mini.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`; mini.style.opacity = (1 - Math.min(y, 120) / 200).toFixed(2); }
  });
  const release = (e, cancelled) => {
    if (!g) return;
    const { mode, t } = g, dx = e.clientX - g.x, dy = e.clientY - g.y, dt = Math.max(1, Date.now() - t); g = null;
    if (!mode) return;                                  // a plain tap: the click handler opens the player
    mini.classList.remove('dragging'); swallow = Date.now() + 350;
    if (mode === 'y') {
      mini.style.transform = ''; mini.style.opacity = '';
      if (!cancelled && (dy > 46 || dy / dt > 0.6)) stow(true);
      return;
    }
    if (cancelled || Math.abs(dx) < 30 || (Math.abs(dx) < 56 && Math.abs(dx) / dt < 0.5)) { main.style.transition = ''; main.style.transform = ''; main.style.opacity = ''; return; }
    const fwd = dx < 0;
    main.style.transition = 'transform .16s ease-in, opacity .16s ease-in';
    main.style.transform = `translate3d(${fwd ? '-' : ''}70%, 0, 0)`; main.style.opacity = '0';
    setTimeout(() => {
      main.style.transition = 'none'; main.style.transform = `translate3d(${fwd ? '' : '-'}60%, 0, 0)`; main.style.opacity = '0';
      if (fwd) next(false); else previousSong();
      void main.offsetWidth;
      main.style.transition = 'transform .45s cubic-bezier(.2, .9, .25, 1.05), opacity .3s ease'; main.style.transform = ''; main.style.opacity = '';
      setTimeout(() => { main.style.transition = ''; }, 500);
    }, 160);
  };
  mini.addEventListener('pointerup', (e) => release(e, false));
  mini.addEventListener('pointercancel', (e) => release(e, true));
  // the handle: tap it, or pull it up, to bring the song bar back
  let hy = null;
  handle.addEventListener('pointerdown', (e) => { hy = e.clientY; });
  handle.addEventListener('pointerup', (e) => { if (hy !== null && (Math.abs(e.clientY - hy) < 8 || e.clientY - hy < -12)) stow(false); hy = null; });
  handle.addEventListener('pointercancel', () => { hy = null; });
})();
$('#p-pp').onclick = togglePlay;
$('#p-next').onclick = () => next(false);
$('#p-prev').onclick = prev;
$('#p-shuffle').onclick = () => { setMode(NEXT_MODE[shuffleMode()]); toastMode(); };
$('#p-repeat').onclick = cycleRepeat;
$('#p-like').onclick = () => { const t = P.queue[P.index]; if (t) toggleLike(t); };
$('#p-close').onclick = closePlayer;
$('#p-more').onclick = () => { const t = P.queue[P.index]; if (t) trackSheet(t); };
$('#p-queue').onclick = () => openPanel('queue');
$('#p-lyrics').onclick = () => openPanel('lyrics');
$$('[data-close-panel]').forEach((b) => (b.onclick = () => closePanels()));

function openPlayer() { $('#player').classList.add('open'); document.body.classList.add('player-open'); }
function closePlayer() { closePanels(); $('#player').classList.remove('open'); document.body.classList.remove('player-open'); }
// drag the player's header down to close it, following the finger
(() => {
  const pl = $('#player'), top = $('#player .top');
  let y0 = null, dy = 0;
  top.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; y0 = e.clientY; dy = 0; top.setPointerCapture(e.pointerId); pl.style.transition = 'none'; });
  top.addEventListener('pointermove', (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); pl.style.transform = `translateY(${dy}px)`; });
  const end = () => {
    if (y0 === null) return; y0 = null; pl.style.transition = ''; pl.style.transform = '';
    if (dy > 110) closePlayer();
  };
  top.addEventListener('pointerup', end); top.addEventListener('pointercancel', end);
})();
// swipe the cover or the title left/right for the next/previous song: the cover follows your finger and
// tilts, flies off, and the next one swings in from the other side
(() => {
  const meta = $('#player .info .meta'), stage = $('#player .stage');
  let sx = null, sy = null, drag = false;
  const settle = () => { stage.classList.remove('dragging'); stage.style.transform = ''; };
  for (const zone of [stage, $('#player .info')]) {
    zone.style.touchAction = 'none';
    zone.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; sx = e.clientX; sy = e.clientY; drag = false; });
    zone.addEventListener('pointermove', (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!drag && (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2)) return;
      drag = true; stage.classList.add('dragging');
      stage.style.transform = `translate3d(${(dx * 0.55).toFixed(1)}px, 0, 0) rotate(${(dx * 0.045).toFixed(2)}deg) scale(${(1 - Math.min(Math.abs(dx), 240) / 2400).toFixed(3)})`;
    });
    zone.addEventListener('pointercancel', () => { sx = null; drag = false; settle(); });
    zone.addEventListener('pointerup', (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy; sx = null; drag = false;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || P.index < 0) return settle();
      const fwd = dx < 0;
      stage.classList.remove('dragging'); stage.classList.add('flinging');
      stage.style.transform = `translate3d(${fwd ? '-' : ''}95%, 0, 0) rotate(${fwd ? -16 : 16}deg) scale(.88)`; stage.style.opacity = '0';
      setTimeout(() => {
        stage.classList.remove('flinging', 'in-l', 'in-r'); stage.style.transition = 'none'; stage.style.transform = ''; stage.style.opacity = '';
        void stage.offsetWidth; stage.style.transition = ''; stage.classList.add(fwd ? 'in-r' : 'in-l');
        setTimeout(() => stage.classList.remove('in-l', 'in-r'), 700);
        meta.classList.remove('from-l', 'from-r'); void meta.offsetWidth; meta.classList.add(fwd ? 'from-r' : 'from-l');
        if (fwd) next(false); else previousSong();
      }, 170);
    });
  }
})();
// swipe down on the cover to close the player
(() => {
  let y0 = null;
  const stage = $('#player .stage');
  stage.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 80) closePlayer(); y0 = null; }, { passive: true });
})();

// lock screen / Control Center / headphones
// iOS shows skip-track buttons only when previous/next handlers are set and the ±10 s seek handlers
// are NOT. It also seems to read them when a song starts, so this runs again for every song.
function registerMediaKeys() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set('play', () => togglePlay());
  set('pause', () => audio.pause());
  set('previoustrack', () => prev());
  set('nexttrack', () => next(false));
  set('seekbackward', null);
  set('seekforward', null);
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}
registerMediaKeys();
onAudio('playing', registerMediaKeys);

// keyboard (handy when testing on a computer)
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.key === 'Escape') { closeSheet(); closePlayer(); }
});

// ---- panels: queue and lyrics
function openPanel(which) {
  closePanels();
  $(`#${which}-panel`).classList.add('open');
  $('#p-' + which).classList.add('on');
  if (which === 'queue') renderQueue(); else loadLyrics();
}
function closePanels() { $$('.panel').forEach((p) => p.classList.remove('open')); $('#p-queue').classList.remove('on'); $('#p-lyrics').classList.remove('on'); }
const lyricsOpen = () => $('#lyrics-panel').classList.contains('open');

function renderQueue() {
  if (!$('#queue-panel').classList.contains('open')) return;
  const cur = P.queue[P.index];
  const upNext = P.queue.slice(P.index + 1);
  let qCount = 0; while (upNext[qCount]?.q) qCount++;          // songs you queued by hand come first
  const qRows = (from, to) => `<div class="list">${upNext.slice(from, to).map((t, k) => { const i = from + k; return `
      <div class="row" data-qi="${P.index + 1 + i}">${art(absArt(t.artwork))}<div class="meta"><div class="t">${esc(t.title)}</div><div class="a"><span class="badge ${t.source}">${t.source === 'yt' ? 'YT' : 'SC'}</span>${esc(t.artist)}</div></div>
      <button class="more" data-qremove="${P.index + 1 + i}" aria-label="Remove from queue">${icon('close')}</button></div>`; }).join('')}</div>`;
  shown.queueCur = { tracks: cur ? [cur] : [], ctx: P.ctx };
  $('#queue-body').innerHTML = `
    <div class="label">Now playing</div>${cur ? trackRows('queueCur', [cur], { ctx: P.ctx }) : ''}
    ${qCount ? `<div class="label qhead"><span>Next in queue</span><button class="qclear" data-qclear>Clear queue</button></div>${qRows(0, qCount)}` : ''}
    <div class="label qhead"><span>Next up${P.ctx ? ` · ${esc(P.ctx)}` : ''}${P.smart ? ' · Smart mix ✦' : ''}</span>${upNext.length && !qCount ? '<button class="qclear" data-qclear>Clear queue</button>' : ''}</div>
    ${upNext.length > qCount ? qRows(qCount, upNext.length)
      : `<div class="muted small" style="padding:8px 0">${S.settings.autoplay ? 'Autoplay will add similar songs when this one ends.' : 'Nothing queued.'}</div>`}`;
}
$('#queue-body').addEventListener('click', (e) => {
  if (e.target.closest('[data-qclear]')) {          // drop everything after the song that's playing
    const gone = P.queue.splice(P.index + 1);
    if (P.original) { const keys = new Set(gone.map(keyOf)); P.original = P.original.filter((x) => !keys.has(keyOf(x))); }
    renderQueue(); saveSession(); toast(gone.length ? `Cleared ${songs(gone.length)} from the queue` : 'Queue is already empty');
    return;
  }
  const rm = e.target.closest('[data-qremove]');
  if (rm) { const i = +rm.dataset.qremove; const [t] = P.queue.splice(i, 1); if (P.original) { const j = P.original.findIndex((x) => keyOf(x) === keyOf(t)); if (j >= 0) P.original.splice(j, 1); } renderQueue(); saveSession(); return; }
  const row = e.target.closest('[data-qi]');
  if (row) {
    const cur = P.index, tgt = +row.dataset.qi;
    const skipped = P.queue.slice(cur + 1, tgt).filter((x) => x.q);
    if (skipped.length && !P.queue[tgt].q) {      // jumping ahead in the playlist keeps what you queued for after it
      P.queue = [...P.queue.slice(0, cur + 1), ...P.queue.slice(cur + 1, tgt).filter((x) => !x.q), P.queue[tgt], ...skipped, ...P.queue.slice(tgt + 1)];
      P.index = tgt - skipped.length;
    } else P.index = tgt;
    loadCurrent(true);
  }
});

let lyrics = { key: null, lines: null, plain: null };
async function loadLyrics() {
  const t = P.queue[P.index]; const body = $('#lyrics-body');
  if (!t) { body.innerHTML = '<div class="empty">Nothing playing</div>'; return; }
  if (lyrics.key === keyOf(t)) return renderLyrics();
  lyrics = { key: keyOf(t), lines: null, plain: null, loading: true };
  body.className = 'panel-body lyrics-body'; body.innerHTML = '<div class="spinner"></div>';
  const src = health.sc !== false ? 'sc' : 'yt';
  try {
    const d = await api(src, '/api/lyrics', { title: t.title, artist: t.artist, duration: t.duration || '' }, 12000);
    if (lyrics.key !== keyOf(t)) return;
    if (d.synced) lyrics.lines = d.synced.split('\n').map((l) => { const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/); return m ? { t: +m[1] * 60 + +m[2], text: m[3] } : null; }).filter((x) => x && x.text);
    else lyrics.plain = d.instrumental ? '♪ Instrumental ♪' : d.plain;
  } catch { lyrics.plain = null; }
  lyrics.loading = false; renderLyrics();
}
function renderLyrics() {
  const body = $('#lyrics-body');
  if (lyrics.lines?.length) { body.className = 'panel-body lyrics-body'; body.innerHTML = lyrics.lines.map((l, i) => `<p data-li="${i}">${esc(l.text)}</p>`).join(''); syncLyrics(audio.currentTime, true); }
  else if (lyrics.plain) { body.className = 'panel-body lyrics-body plain'; body.innerHTML = lyrics.plain.split('\n').map((l) => `<p>${esc(l) || '&nbsp;'}</p>`).join(''); }
  else body.innerHTML = '<div class="empty"><b>No lyrics found</b>LRCLIB doesn\'t have this song yet.</div>';
}
let lastLine = -1;
function syncLyrics(time, force) {
  if (!lyrics.lines?.length) return;
  let i = -1; for (let k = 0; k < lyrics.lines.length; k++) { if (lyrics.lines[k].t <= time + 0.25) i = k; else break; }
  if (i === lastLine && !force) return; lastLine = i;
  $$('#lyrics-body p').forEach((p, k) => { p.classList.toggle('now', k === i); p.classList.toggle('past', k < i); });
  const el = $(`#lyrics-body p[data-li="${i}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
}
$('#lyrics-body').addEventListener('click', (e) => { const p = e.target.closest('p[data-li]'); if (p && lyrics.lines) audio.currentTime = lyrics.lines[+p.dataset.li].t; });

// ---- remember what was playing (restored paused when the app reopens)
let lastSessionSave = 0;
function saveSession() {
  lastSessionSave = Date.now();
  S.session = P.index >= 0 ? { queue: P.queue.slice(0, 200), index: P.index, ctx: P.ctx, position: audio.currentTime || 0, repeat: P.repeat } : null;
  save();
}
window.addEventListener('pagehide', saveSession);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); else { checkHealth(); scheduleSync(300); } });
function restoreSession() {
  const s = S.session; if (!s?.queue?.length) return;
  P.queue = s.queue; P.index = Math.min(s.index, s.queue.length - 1); P.ctx = s.ctx || ''; P.repeat = s.repeat || 'off';
  syncRepeat();
  updateNowPlaying(P.queue[P.index]);
  const d = P.queue[P.index].duration || 0; const pct = d ? (s.position / d) * 100 : 0;
  $('#mini .bar i').style.width = pct + '%'; $('#p-cur').textContent = fmt(s.position);
}

// ------------------------------------------------------------------ import a playlist from Spotify
// Reads an Exportify CSV, Spotify's own data download (JSON) or a pasted list of songs, finds each
// song on YouTube (home server) or SoundCloud, and saves the result as a playlist.
const IMP = { stage: 'pick', lists: [], tracks: [], name: '', error: '', done: 0, total: 0, matched: 0, viaSc: 0, current: '', unmatched: [], cancel: false, playlistId: null };

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
const toSeconds = (v) => { const n = parseFloat(v); return !isFinite(n) || n <= 0 ? 0 : n > 1000 ? Math.round(n / 1000) : Math.round(n); };
function csvTracks(rows) {
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const ti = head.findIndex((h) => /^(track|song|title)( name)?$/.test(h) || h === 'name');
  const ai = head.findIndex((h) => /artist/.test(h));
  const di = head.findIndex((h) => /duration/.test(h));
  if (ti < 0) return null;
  return rows.slice(1).map((r) => ({ title: (r[ti] || '').trim(), artist: ai >= 0 ? (r[ai] || '').trim() : '', duration: di >= 0 ? toSeconds(r[di]) : 0 })).filter((t) => t.title);
}
function jsonLists(d) {
  const lists = [];
  const fromItems = (items) => items.map((it) => (it.track && typeof it.track === 'object' ? it.track : it)).map((t) => ({ title: (t.trackName || t.track || t.title || t.name || '').toString().trim(), artist: (t.artistName || t.artist || (Array.isArray(t.artists) ? t.artists.map((a) => a.name || a).join('; ') : '') || '').toString().trim(), duration: toSeconds(t.duration_ms || t.durationMs || t.duration) })).filter((t) => t.title);
  if (Array.isArray(d?.playlists)) d.playlists.forEach((p) => { const tr = fromItems(p.items || p.tracks || []); if (tr.length) lists.push({ name: p.name || 'Spotify playlist', tracks: tr }); });
  if (Array.isArray(d?.tracks) && d.tracks.length) { const tr = fromItems(d.tracks); if (tr.length) lists.push({ name: 'Liked Songs (from Spotify)', tracks: tr }); }
  if (Array.isArray(d) && d.length) { const tr = fromItems(d); if (tr.length) lists.push({ name: 'Imported playlist', tracks: tr }); }
  return lists;
}
function textTracks(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/^\s*\d+[.)]\s+/, '').trim()).filter(Boolean).map((l) => {
    let m = l.match(/^(.+?)\s+[-–—]\s+(.+)$/);                 // "Artist - Song"
    if (m) return { artist: m[1].trim(), title: m[2].trim(), duration: 0 };
    m = l.match(/^(.+?)\s+by\s+(.+)$/i);                        // "Song by Artist"
    if (m) return { title: m[1].trim(), artist: m[2].trim(), duration: 0 };
    return { title: l, artist: '', duration: 0 };
  });
}
// returns [{name, tracks}]
function parseImport(text, fileName = '') {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const t = text.trim();
  if (!t) throw new Error('That file is empty');
  if (t[0] === '{' || t[0] === '[') {
    let d; try { d = JSON.parse(t); } catch { throw new Error("That file looks like JSON but can't be read"); }
    const lists = jsonLists(d);
    if (!lists.length) throw new Error("I couldn't find any songs in that file. Use a playlist file from Spotify's data download (Playlist1.json) or an Exportify CSV.");
    if (lists.length === 1 && base && !/^playlist\d*$/i.test(base) && !/^yourlibrary$/i.test(base)) lists[0].name = lists[0].name === 'Imported playlist' ? base : lists[0].name;
    return lists;
  }
  const rows = parseCSV(t);
  if (rows.length > 1 && rows[0].length > 1) { const tr = csvTracks(rows); if (tr?.length) return [{ name: base || 'Spotify playlist', tracks: tr }]; }
  const tr = textTracks(t);
  if (!tr.length) throw new Error("I couldn't find any songs there");
  return [{ name: base || 'Imported playlist', tracks: tr }];
}
function dedupeTracks(tracks) {
  const seen = new Set();
  return tracks.filter((t) => { const k = (t.title + '|' + t.artist).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function matchTrack(t) {
  const params = { title: t.title, artist: (t.artist || '').split(';')[0].trim(), duration: t.duration || '' };
  if (health.yt !== false) {
    try { return await api('yt', '/api/yt/match', params, 20000); }
    catch (e) { if (e.offline) health.yt = false; }
  }
  if (health.sc !== false && S.settings.fallback) {
    try { const m = await api('sc', '/api/sc/match', params, 20000); IMP.viaSc++; return m; } catch (e) { if (e.offline) health.sc = false; }
  }
  return null;
}

async function runImport() {
  const I = IMP; I.stage = 'running'; I.cancel = false; I.unmatched = []; I.done = 0; I.matched = 0; I.viaSc = 0; I.total = I.tracks.length; I.current = '';
  const p = newPlaylist(I.name); I.playlistId = p.id;
  const results = new Array(I.tracks.length).fill(null);
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}   // keep the screen on while importing
  let next = 0;
  const flush = () => { p.tracks = results.filter(Boolean).map(slim).filter((t, i, a) => a.findIndex((x) => keyOf(x) === keyOf(t)) === i); save(); };
  const worker = async () => {
    while (!I.cancel) {
      const i = next++; if (i >= I.tracks.length) return;
      const t = I.tracks[i]; I.current = `${t.artist ? t.artist.split(';')[0] + ' – ' : ''}${t.title}`; renderImportProgress();
      let m = null; try { m = await matchTrack(t); } catch {}
      results[i] = m; I.done++;
      if (m) I.matched++; else I.unmatched.push(t);
      if (I.done % 5 === 0) flush();           // partial results are kept even if the phone locks mid-way
      renderImportProgress();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  flush(); try { wake?.release(); } catch {}
  I.stage = I.cancel ? 'stopped' : 'done'; I.current = '';
  if (route().name === 'import') renderView();
}

function viewImport() {
  const I = IMP;
  const back = `<button class="icon-btn back" data-action="importBack" aria-label="Back">${icon('back')}</button>`;
  if (I.stage === 'running') return `${back}<div class="view-head"><h1>Importing…</h1></div>
    <div class="group"><div class="field">
      <div class="bar-track"><div class="bar-fill" id="imp-bar" style="width:${I.total ? (I.done / I.total) * 100 : 0}%"></div></div>
      <div class="imp-count" id="imp-count">${I.done} of ${I.total} songs · ${I.matched} found</div>
      <div class="hint" id="imp-current">${esc(I.current)}</div>
      <div class="hint">Keep this app open and your home server running. Songs are saved as they're found.</div>
    </div><div class="btn-row"><button class="btn" data-action="importStop">Stop</button></div></div>`;
  if (I.stage === 'done' || I.stage === 'stopped') {
    const un = I.unmatched;
    return `${back}<div class="view-head"><h1>${I.stage === 'done' ? 'Import finished' : 'Import stopped'}</h1></div>
      <div class="group"><div class="field"><div class="imp-big">${I.matched} of ${I.total}</div><div class="muted">songs added to “${esc(I.name)}”${I.viaSc ? ` · ${I.viaSc} from SoundCloud` : ''}</div></div>
      <div class="btn-row"><button class="btn primary" data-action="importOpen">Open playlist</button><button class="btn" data-action="importAgain">Import another</button></div></div>
      ${un.length ? `<h2>Not found (${un.length})</h2><div class="group"><div class="field imp-list">${un.map((t) => `<div class="imp-un"><b>${esc(t.title)}</b><span>${esc((t.artist || '').split(';').join(', '))}</span></div>`).join('')}</div>
      <div class="field hint">These had no safe match (or only a remix or live version). Search for them by hand and add them with ⋯ → Add to playlist.</div></div>` : ''}`;
  }
  if (I.stage === 'ready') {
    const offline = health.yt === false && health.sc === false;
    return `${back}<div class="view-head"><h1>Ready to import</h1></div>
      <div class="group">
        <div class="field"><div class="imp-big">${I.tracks.length} songs</div><div class="muted small">${I.tracks.slice(0, 3).map((t) => esc(t.title)).join(' · ')}${I.tracks.length > 3 ? ' …' : ''}</div></div>
        <div class="field"><label for="imp-name">Playlist name</label><input id="imp-name" type="text" maxlength="80" value="${esc(I.name)}"></div>
        <div class="field hint">About ${Math.max(1, Math.round(I.tracks.length / 40))}–${Math.max(2, Math.round(I.tracks.length / 20))} minutes. ${health.yt === false ? 'The home server is off, so songs will be matched on SoundCloud only.' : 'Songs are matched on YouTube first, then SoundCloud.'}</div>
        ${offline ? '<div class="field" style="color:var(--bad)">Neither server answers right now. Check Settings first.</div>' : ''}
        <div class="btn-row"><button class="btn primary" data-action="importStart" ${offline ? 'disabled' : ''}>Start import</button><button class="btn" data-action="importAgain">Choose another</button></div>
      </div>`;
  }
  if (I.stage === 'choose') return `${back}<div class="view-head"><h1>Pick a playlist</h1></div>
    <p class="muted small" style="margin-top:-6px">That file holds ${I.lists.length} lists. Choose one to import.</p>
    ${I.lists.map((l, i) => `<button class="lib-row" data-action="importChoose" data-i="${i}"><div class="art liked-art" style="background:linear-gradient(135deg,var(--accent-2),var(--accent))">${icon('lib')}</div><div><div class="t">${esc(l.name)}</div><div class="a">${songs(l.tracks.length)}</div></div></button>`).join('')}`;
  // pick
  return `${back}<div class="view-head"><h1>Import from Spotify</h1></div>
    ${I.error ? `<div class="notice" style="border-color:rgba(248,113,113,.4)"><div><b>Couldn't read that</b><span class="muted small">${esc(I.error)}</span></div></div>` : ''}
    <div class="group-title">1 · Get your playlist out of Spotify</div>
    <div class="group"><div class="field imp-steps">
      <b>Exportify</b> (fastest): search for “Exportify”, log in to Spotify there, and export a playlist as CSV.<br>
      <b>Spotify data download:</b> Spotify account → Privacy → Download your data. Use the <i>Playlist1.json</i> file inside.<br>
      <b>Or just type/paste</b> one song per line, like <i>Daft Punk - Get Lucky</i>.
    </div></div>
    <div class="group-title">2 · Choose the file</div>
    <div class="group"><div class="btn-row"><button class="btn primary" data-action="importPickFile">Choose file…</button></div></div>
    <input type="file" id="imp-file" accept=".csv,.json,.txt,text/csv,application/json,text/plain" class="hidden">
    <div class="group-title">…or paste a list</div>
    <div class="group"><div class="field"><textarea id="imp-text" rows="6" placeholder="Daft Punk - Get Lucky&#10;The Weeknd - Blinding Lights&#10;Linkin Park - Numb" spellcheck="false" autocapitalize="off" autocorrect="off"></textarea></div>
    <div class="btn-row"><button class="btn" data-action="importReadText">Read list</button></div></div>`;
}
function bindImport() {
  const f = $('#imp-file'); if (!f) return;
  f.onchange = async () => {
    const file = f.files[0]; if (!file) return;
    try { useImportLists(parseImport(await file.text(), file.name)); }
    catch (e) { IMP.error = e.message; renderView(); }
  };
}
function useImportLists(lists) {
  const I = IMP; I.error = '';
  lists = lists.map((l) => ({ ...l, tracks: dedupeTracks(l.tracks).slice(0, 2000) }));
  if (lists.length > 1) { I.lists = lists; I.stage = 'choose'; }
  else chooseImportList(lists[0]);
  renderView();
}
function chooseImportList(l) { IMP.tracks = l.tracks; IMP.name = l.name; IMP.stage = 'ready'; }
function renderImportProgress() {
  if (route().name !== 'import' || IMP.stage !== 'running') return;
  const bar = $('#imp-bar'); if (!bar) return renderView();
  bar.style.width = (IMP.total ? (IMP.done / IMP.total) * 100 : 0) + '%';
  $('#imp-count').textContent = `${IMP.done} of ${IMP.total} songs · ${IMP.matched} found`;
  $('#imp-current').textContent = IMP.current;
}
Object.assign(actions, {
  importBack: () => { if (IMP.stage === 'running') return toast('Import is running. Tap Stop to cancel.'); if (IMP.stage !== 'pick') { Object.assign(IMP, { stage: 'pick', error: '' }); return renderView(); } back(); },
  importAgain: () => { Object.assign(IMP, { stage: 'pick', error: '', lists: [], tracks: [] }); renderView(); },
  importPickFile: () => $('#imp-file').click(),
  importReadText: () => { const v = $('#imp-text').value; try { useImportLists(parseImport(v)); } catch (e) { IMP.error = e.message; renderView(); } },
  importChoose: (b) => { chooseImportList(IMP.lists[+b.dataset.i]); renderView(); },
  importStart: () => { IMP.name = ($('#imp-name').value || '').trim() || IMP.name; runImport(); renderView(); },
  importStop: () => { IMP.cancel = true; toast('Stopping…'); },
  importOpen: () => { const id = IMP.playlistId; Object.assign(IMP, { stage: 'pick' }); stacks[tab] = [stacks[tab][0]]; switchTab('library'); go({ name: 'playlist', id }); },
});

// ------------------------------------------------------------------ listening stats + genres
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA');          // 2026-11-19
const firstArtist = (a) => String(a || '').split(/\s*(?:,|&|;|\bfeat\.?|\bft\.?)\s*/i)[0].trim();
function stats() {
  const st = S.stats;
  st.events ||= []; st.tracks ||= {}; st.days ||= {}; st.others ||= {};
  if (!st.me) st.me = 'd' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);   // names this device in the shared stats
  if (!Array.isArray(st.hours) || st.hours.length !== 24) st.hours = Array(24).fill(0);
  return st;
}
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m`;
  return `${sec}s`;
}
// Genres come from Deezer (home server) or SoundCloud tags in lots of spellings; fold them into a tidy set.
function normalizeGenre(raw) {
  const s = String(raw || '').trim(); if (!s) return '';
  const rules = [[/k-?pop|j-?pop/, 'Pop'], [/hip|rap|trap|drill/, 'Hip-Hop'], [/lo-?fi|chill|ambient|downtempo/, 'Chill'], [/r&b|rnb|soul|funk/, 'R&B & Soul'],
    [/electro|edm|house|techno|trance|dubstep|drum|bass|synth/, 'Electronic'], [/dance|disco/, 'Dance'], [/metal|hardcore/, 'Metal'], [/punk|rock|grunge/, 'Rock'],
    [/indie|alternative|\balt\b/, 'Alternative'], [/pop/, 'Pop'], [/jazz|blues/, 'Jazz & Blues'], [/classical|orchestra|piano/, 'Classical'], [/country|bluegrass/, 'Country'],
    [/folk|acoustic|singer/, 'Folk'], [/latin|reggaeton|salsa|bachata/, 'Latin'], [/reggae|dancehall|ska/, 'Reggae'], [/film|game|soundtrack|score/, 'Soundtrack']];
  const l = s.toLowerCase();
  for (const [re, name] of rules) if (re.test(l)) return name;
  return s.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 24);
}

// --- counting plays: a song counts once it has really been listened to (30 s, or half of a short one)
const LT = { key: null, sec: 0, logged: false, last: 0, flushed: 0 };
function listenReset(t) { LT.key = t ? keyOf(t) : null; LT.sec = 0; LT.logged = false; LT.last = 0; }
onAudio('timeupdate', () => {
  if (audio.paused || audio.seeking || !LT.key) return;
  const c = audio.currentTime, d = c - LT.last; LT.last = c;
  if (!(d > 0 && d < 1.5)) return;                      // a seek or a restart isn't listening
  LT.sec += d;
  const st = stats(), now = new Date(), dk = dayKey(now);
  st.days[dk] = (st.days[dk] || 0) + d; st.hours[now.getHours()] += d;
  const t = P.queue[P.index];
  if (!LT.logged && t && keyOf(t) === LT.key) {
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : t.duration || 0;
    if (LT.sec >= (dur ? Math.min(30, dur * 0.5) : 30)) { LT.logged = true; logPlay(t); }
  }
  if (Date.now() - LT.flushed > 15000) { LT.flushed = Date.now(); persist(); }
});
onAudio('ended', () => { LT.sec = 0; LT.logged = false; LT.last = 0; });   // a replay counts again
function logPlay(t) {
  const st = stats(), key = keyOf(t);
  st.events.push([Date.now(), key]);
  if (st.events.length > 6000) st.events.splice(0, st.events.length - 6000);
  const rec = (st.tracks[key] ||= {});
  rec.t = slim(t);
  if (t.genre && !rec.g) rec.g = normalizeGenre(t.genre);
  if (rec.g === undefined || (rec.g === '' && Date.now() - (rec.gt || 0) > 3 * 864e5)) lookupGenre(key);
  save(); markStatsDirty();
}

// --- genre lookups (one at a time, politely)
const genreQ = []; let genreBusy = false;
function lookupGenre(key) { if (!genreQ.includes(key)) genreQ.push(key); pumpGenres(); }
async function pumpGenres() {
  if (genreBusy) return; genreBusy = true;
  let changed = false;
  while (genreQ.length) {
    const key = genreQ.shift(), rec = stats().tracks[key];
    if (!rec || !rec.t || (rec.g && rec.g !== '')) continue;
    let g, reached = false;
    for (const src of ['yt', 'sc']) {
      try { const r = await api(src, '/api/genre', { artist: rec.t.artist, title: rec.t.title }, 12000); g = r.genre; reached = true; break; }
      catch (e) { if (!e.offline) { reached = true; break; } }
    }
    if (reached) { rec.g = g ? normalizeGenre(g) : ''; rec.gt = Date.now(); changed = true; persist(); }
    await sleep(350);
  }
  genreBusy = false;
  if (changed) markStatsDirty();
}
function backfillGenres() {
  const st = stats(); const counts = {};
  for (const [, k] of st.events) counts[k] = (counts[k] || 0) + 1;
  Object.keys(st.tracks).sort((a, b) => (counts[b] || 0) - (counts[a] || 0)).slice(0, 30).forEach((k) => {
    const r = st.tracks[k]; if (r.g === undefined || (r.g === '' && Date.now() - (r.gt || 0) > 3 * 864e5)) lookupGenre(k);
  });
}
function markStatsDirty() {
  dirty.add('home'); dirty.add('discover');
  if (document.activeElement?.tagName === 'INPUT' || document.querySelector('.row.pulling')) return;      // don't disturb typing or a swipe in progress
  if ((tab === 'home' || tab === 'discover') && !$('#sheet').classList.contains('open') && !$('#player').classList.contains('open')) {
    renderPane(tab); if (tab === 'discover') ensureDiscover();
  }
}

// --- the numbers
function allDays() {
  const st = stats(), out = { ...st.days };
  for (const o of Object.values(st.others)) for (const [k, v] of Object.entries(o.days || {})) out[k] = (out[k] || 0) + v;
  return out;
}
function allHours() {
  const st = stats(), out = [...st.hours];
  for (const o of Object.values(st.others)) (o.hours || []).forEach((v, i) => { out[i] += v || 0; });
  return out;
}
function computeStats(range) {
  const st = stats(), now = Date.now();
  const cutoff = range === 'all' ? 0 : now - (+range) * 864e5;
  const counts = new Map(), genres = new Map(), artistN = new Map();
  let plays = 0;
  for (const [at, key] of st.events) {
    if (at < cutoff) continue;
    const rec = st.tracks[key]; if (!rec?.t) continue;
    plays++; counts.set(key, (counts.get(key) || 0) + 1);
    const a = firstArtist(rec.t.artist); if (a) artistN.set(a, (artistN.get(a) || 0) + 1);
    if (rec.g) genres.set(rec.g, (genres.get(rec.g) || 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n, t: st.tracks[key].t }));
  const artArt = {};
  for (const r of ranked) { const a = firstArtist(r.t.artist); if (a && !artArt[a]) artArt[a] = r.t.artwork; }
  const topArtists = [...artistN].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n, art: artArt[name] }));
  const cutDay = range === 'all' ? '' : dayKey(new Date(cutoff));
  const days = allDays();
  let secs = 0; for (const [k, v] of Object.entries(days)) if (k >= cutDay) secs += v;
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 864e5);
    week.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), secs: days[dayKey(d)] || 0, today: i === 0 });
  }
  const h = allHours(), sum = (a, b) => { let x = 0; for (let i = a; i < b; i++) x += h[i]; return x; };
  const tod = [['Morning', sum(5, 12)], ['Afternoon', sum(12, 17)], ['Evening', sum(17, 22)], ['Night', sum(22, 24) + sum(0, 5)]];
  return { plays, songs: counts.size, artistsN: artistN.size, secs, ranked, topArtists, week, tod,
           genres: [...genres].sort((a, b) => b[1] - a[1]).slice(0, 5), genreTotal: [...genres.values()].reduce((a, b) => a + b, 0) };
}

function statsHtml() {
  const range = S.settings.statsRange || '30';
  const seg = [['7', '7 days'], ['30', '30 days'], ['all', 'All time']].map(([v, l]) => `<button class="${range === v ? 'on' : ''}" data-action="statsRange" data-v="${v}">${l}</button>`).join('');
  const head = `<div class="stats-head"><h2>Stats</h2><div class="seg">${seg}</div></div>`;
  if (!stats().events.length) return `<section class="stats">${head}<div class="stat-empty"><b>Your stats start here</b>Play a few songs and this fills in with what you listen to, your most replayed songs and when you listen.</div></section>`;
  const s = computeStats(range);
  const weekMax = Math.max(60, ...s.week.map((d) => d.secs));
  const week = `<div class="pc"><div class="pc-head"><span>Last 7 days</span><em>${fmtDur(s.week.reduce((a, d) => a + d.secs, 0))}</em></div>
    <div class="week">${s.week.map((d) => `<div class="wk${d.today ? ' today' : ''}"><small>${d.secs >= 60 ? Math.round(d.secs / 60) + 'm' : ''}</small><div class="wk-bar"><i style="height:${Math.max(3, (d.secs / weekMax) * 100)}%"></i></div><span>${esc(d.label)}</span></div>`).join('')}</div></div>`;
  const gmax = s.genres[0]?.[1] || 1;
  const genres = `<div class="pc"><div class="pc-head"><span>Top genres</span></div>${s.genres.length
    ? s.genres.map(([name, n]) => `<div class="gbar"><div class="gl"><span>${esc(name)}</span><em>${Math.round((n / s.genreTotal) * 100)}%</em></div><div class="gt"><i style="width:${Math.max(4, (n / gmax) * 100)}%"></i></div></div>`).join('')
    : `<div class="muted small">${s.plays ? 'Working out the genres of your songs…' : 'Nothing played in this time range.'}</div>`}</div>`;
  const replays = s.ranked.filter((r) => r.n >= 2).slice(0, 4);
  const top = replays.length ? replays : s.ranked.slice(0, 3);
  shown.statsTop = { tracks: top.map((r) => r.t), ctx: replays.length ? 'Most replayed' : 'Most played' };
  const rows = top.length ? `<div class="pc"><div class="pc-head"><span>${replays.length ? 'Most replayed' : 'Most played'}</span></div><div class="list">${top.map((r, i) => `
    <div class="row" data-list="statsTop" data-i="${i}">${art(absArt(r.t.artwork))}<div class="meta"><div class="t">${esc(r.t.title)}</div><div class="a">${esc(r.t.artist)}</div></div>
      <div class="plays"><b>×${r.n}</b><small>${r.n === 1 ? 'play' : 'plays'}</small></div></div>`).join('')}</div></div>` : '';
  const artists = s.topArtists.length ? `<div class="pc"><div class="pc-head"><span>Top artists</span></div><div class="rail artists">${s.topArtists.map((a) => `
    <div class="artist">${art(absArt(a.art))}<div class="t">${esc(a.name)}</div><div class="a">${a.n} ${a.n === 1 ? 'play' : 'plays'}</div></div>`).join('')}</div></div>` : '';
  const todTotal = s.tod.reduce((a, [, v]) => a + v, 0), todMax = Math.max(...s.tod.map(([, v]) => v), 1);
  const best = [...s.tod].sort((a, b) => b[1] - a[1])[0];
  const tod = todTotal > 60 ? `<div class="pc"><div class="pc-head"><span>When you listen</span><em>Mostly ${best[0].toLowerCase()}</em></div>
    <div class="tod">${s.tod.map(([n, v]) => `<div class="td${n === best[0] ? ' best' : ''}"><div class="td-bar"><i style="height:${Math.max(4, (v / todMax) * 100)}%"></i></div><span>${n}</span></div>`).join('')}</div></div>` : '';
  return `<section class="stats">${head}
    <div class="stat-grid">
      <div class="stat"><b>${fmtDur(s.secs)}</b><span>Listening time</span></div>
      <div class="stat"><b>${s.plays}</b><span>Plays</span></div>
      <div class="stat"><b>${s.songs}</b><span>Different songs</span></div>
      <div class="stat"><b>${s.artistsN}</b><span>Artists</span></div>
    </div>${week}${genres}${rows}${artists}${tod}</section>`;
}

// ------------------------------------------------------------------ discover
// Recommendations come from the "radio" / "related" lists of the songs you play most, grouped under
// the genres you listen to most. Songs you already know are left out.
let discoverBusy = false;
const nameKey = (t) => (String(t.title).replace(/\(.*?\)|\[.*?\]/g, '') + '|' + firstArtist(t.artist)).toLowerCase().replace(/[^a-z0-9|]+/g, '');
function knownKeys() {
  const keys = new Set(Object.keys(stats().tracks)), names = new Set(Object.values(stats().tracks).map((r) => r.t && nameKey(r.t)));
  const add = (t) => { keys.add(keyOf(t)); names.add(nameKey(t)); };
  S.liked.forEach(add); S.playlists.forEach((p) => p.tracks.forEach(add));
  return { keys, names };
}
function genreRank() {
  const st = stats(), c = new Map();
  for (const [, k] of st.events) { const g = st.tracks[k]?.g; if (g) c.set(g, (c.get(g) || 0) + 1); }
  return [...c].sort((a, b) => b[1] - a[1]);
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
async function recsFor(t) {
  try {
    if (t.source === 'yt' && health.yt !== false) return await api('yt', `/api/yt/radio/${t.id}`, {}, 25000);
    if (t.source === 'sc' && health.sc !== false) return await api('sc', `/api/sc/related/${t.id}`, {}, 25000);
  } catch {}
  return [];
}
async function ensureDiscover(force = false) {
  if (!force && (S.settings.discTab || 'find') !== 'rec') return;      // recommendations are only built when you look at them
  if (discoverBusy || stats().events.length < 3) return;
  const rank = genreRank();
  if (!rank.length) { backfillGenres(); return; }
  const sig = rank.slice(0, 4).map((x) => x[0]).join('|'), D = S.discover;
  if (!force && D && D.sig === sig && Date.now() - D.at < 6 * 3600e3) return;
  discoverBusy = true; if (tab === 'discover') renderPane('discover');
  try {
    const st = stats(), known = knownKeys(), used = new Set();
    const plays = {}; for (const [, k] of st.events) plays[k] = (plays[k] || 0) + 1;
    const jobs = [];
    for (const [genre] of rank.slice(0, 4)) {
      let seeds = Object.keys(st.tracks).filter((k) => st.tracks[k].g === genre && st.tracks[k].t).sort((a, b) => plays[b] - plays[a]);
      if (force) seeds = seeds.slice(0, 6).sort(() => Math.random() - 0.5);
      seeds = seeds.slice(0, 3).map((k) => st.tracks[k].t);
      seeds.forEach((t) => jobs.push({ genre, t }));
    }
    const results = await pool(jobs, 4, async (j) => ({ ...j, recs: await recsFor(j.t) }));
    const sections = [];
    for (const [genre] of rank.slice(0, 4)) {
      const mine = results.filter((r) => r.genre === genre); if (!mine.length) continue;
      const score = new Map();
      for (const r of mine) {
        const seedName = nameKey(r.t), skipVersion = /\b(slowed|sped up|nightcore|8d|karaoke|cover|reverb|mashup|bootleg)\b/i.test(r.t.title);
        r.recs.forEach((t, i) => {
          if (!t || known.keys.has(keyOf(t)) || known.names.has(nameKey(t)) || nameKey(t) === seedName) return;
          if (!skipVersion && /\b(slowed|sped up|nightcore|8d|karaoke|cover|reverb|mashup|bootleg)\b/i.test(t.title)) return;
          const k = nameKey(t), o = score.get(k) || { t, s: 0 };
          o.s += 1 + (1 - i / Math.max(1, r.recs.length)); score.set(k, o);
        });
      }
      const perArtist = {}, picked = [];
      for (const o of [...score.values()].sort((a, b) => b.s - a.s)) {
        const a = firstArtist(o.t.artist).toLowerCase(), k = nameKey(o.t);
        if (used.has(k) || (perArtist[a] || 0) >= 2) continue;
        perArtist[a] = (perArtist[a] || 0) + 1; used.add(k); picked.push(slim(o.t));
        if (picked.length >= 12) break;
      }
      if (picked.length >= 4) sections.push({ genre, because: [...new Set(mine.map((r) => firstArtist(r.t.artist)))].slice(0, 2).join(' & '), tracks: picked });
    }
    S.discover = { at: Date.now(), sig, sections }; persist();
  } finally {
    discoverBusy = false;
    if (tab === 'discover') renderPane('discover'); else dirty.add('discover');
  }
}
function recHtml() {
  const head = '';
  if (stats().events.length < 3) return `${head}<div class="empty"><b>Let's learn your taste</b>Play a few songs and Discover will suggest new music, grouped by genre.<div style="margin-top:16px"><button class="btn primary" data-action="toSearch">Find music</button></div></div>`;
  const D = S.discover;
  if (!D?.sections?.length) {
    if (discoverBusy || !genreRank().length) return `${head}<p class="muted small" style="margin:-6px 0 14px">${discoverBusy ? 'Finding music you will like…' : 'Working out the genres of your songs…'}</p>${skeletonRows()}`;
    return `${head}<div class="empty"><b>Nothing new to suggest yet</b>Tap refresh in a moment, or listen to a few more songs.</div>`;
  }
  const known = knownKeys();
  return `${head}<p class="muted small" style="margin:-6px 0 4px">Based on what you listen to${discoverBusy ? ' · refreshing…' : ''}</p>` + D.sections.map((sec, gi) => {
    const list = sec.tracks.filter((t) => !known.keys.has(keyOf(t)));
    shown['disc' + gi] = { tracks: list, ctx: `Discover · ${sec.genre}` };
    if (list.length < 3) return '';
    return `<section class="disc"><div class="disc-head"><div><h2>${esc(sec.genre)}</h2><div class="muted small">Because you like ${esc(sec.because)}</div></div>
      <button class="btn mini" data-action="playDiscAll" data-g="${gi}">Play</button></div>
      <div class="rail">${list.map((t, i) => `<button class="card" data-action="playDisc" data-g="${gi}" data-i="${i}">${art(absArt(t.artwork))}<div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></button>`).join('')}</div></section>`;
  }).join('');
}
const skeletonRows = () => `<div class="sk-rail">${Array.from({ length: 4 }, () => '<div class="sk"></div>').join('')}</div>`.repeat(2);

// ------------------------------------------------------------------ discover: Find, Recommend, Match
const CHART_GENRES = ['Hip-Hop', 'Pop', 'Rock', 'Electronic', 'Dance', 'R&B & Soul', 'Alternative', 'Metal', 'Jazz & Blues', 'Classical', 'Country', 'Folk', 'Latin', 'Reggae', 'Soundtrack'];
const akey = (a) => firstArtist(a).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function discApi(path, params, timeout = 30000) {     // charts/artists work from either server
  let last;
  for (const src of ['yt', 'sc']) {
    try { return await api(src, path, params, timeout); } catch (e) { last = e; if (!e.offline) throw e; }
  }
  throw last;
}
function viewDiscover() {
  const cur = S.settings.discTab || 'find';
  const tabs = [['find', 'Find'], ['rec', 'Recommend'], ['match', 'Match']];
  return `<div class="view-head"><h1>Discover</h1>${cur === 'rec' ? `<button class="icon-btn${discoverBusy ? ' spin' : ''}" data-action="refreshDiscover" aria-label="Refresh recommendations">${icon('refresh')}</button>` : ''}</div>
    <div class="subtabs">${tabs.map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-action="discTab" data-v="${k}">${l}</button>`).join('')}</div>
    ${cur === 'find' ? findHtml() : cur === 'rec' ? recHtml() : matchHtml()}`;
}

// --- rows with a preview and an add button (songs from charts and lookups can't be played directly yet)
function discRows(listId, tracks, o = {}) {
  shown[listId] = { tracks, ctx: o.ctx || '' };
  return `<div class="list disc-list">${tracks.map((t, i) => `
    <div class="row drow" data-action="${o.row || 'discPlay'}" data-l="${esc(listId)}" data-i="${i}">
      ${o.rank ? `<div class="rk">${i + 1}</div>` : ''}${art(absArt(t.artwork))}
      <div class="meta"><div class="t">${esc(t.title)}</div><div class="a">${t.source === 'dz' ? '' : `<span class="badge ${t.source}">${t.source === 'yt' ? 'YT' : 'SC'}</span>`}${esc(t.artist)}${t.duration ? ` · ${fmt(t.duration)}` : ''}${o.days && t.days ? ` · ${t.days}d charted` : ''}</div></div>
      <button class="pvbtn" data-action="pv" data-pv="${esc(keyOf(t))}" data-l="${esc(listId)}" data-i="${i}" aria-label="Preview">${icon('play')}${icon('pause')}</button>
      ${o.noAdd ? '' : `<button class="addbtn" data-action="discAdd" data-l="${esc(listId)}" data-i="${i}" aria-label="Add to library">${icon('plus')}</button>`}
    </div>`).join('')}</div>`;
}

// --- previews: 30 seconds on a second player, the main player pauses meanwhile and resumes after
const PV = { el: new Audio(), key: null, resume: false };
const pvUrl = (u) => (/^https?:/.test(u) ? u : new URL(baseFor('yt') + u, location.href).toString());
function setPvButtons() { $$('[data-pv]').forEach((b) => b.classList.toggle('on', !!PV.key && b.dataset.pv === PV.key)); }
function stopPreview(resume = true) {
  if (!PV.key) return;
  PV.el.pause(); PV.el.removeAttribute('src'); PV.el.load();
  const r = PV.resume; PV.key = null; PV.resume = false; setPvButtons();
  if (resume && r) audio.play().catch(() => {});
}
async function togglePreview(t) {
  const key = keyOf(t);
  if (PV.key === key) return stopPreview();
  const was = PV.key ? PV.resume : !audio.paused;
  PV.resume = was; PV.key = key; audio.pause(); setPvButtons();
  let url = t.preview ? pvUrl(t.preview) : t.source === 'dz' ? '' : streamUrl(t);
  if (!url) {                                           // saved chart songs: Deezer's links expire, so fetch a new one
    try { url = pvUrl((await discApi('/api/discover/preview', { id: t.id }, 15000)).preview); } catch {}
    if (PV.key !== key) return;                         // the user moved on while we asked
  }
  if (!url) { toast("No preview is available for this song"); return stopPreview(); }
  PV.el.src = url;
  PV.el.play().catch((e) => {
    if (e.name === 'AbortError' || PV.key !== key) return;      // switching to another preview interrupts the first one: that's fine
    toast("Couldn't play a preview"); stopPreview();
  });
}
PV.el.addEventListener('timeupdate', () => { if (PV.el.currentTime >= 30) stopPreview(); });
PV.el.addEventListener('ended', () => stopPreview());
onAudio('play', () => { if (PV.key) stopPreview(false); });     // pressing play on the main player ends a preview

// --- turning a chart/lookup song into something playable (YouTube Music, else SoundCloud)
const resolvedDz = new Map();
async function resolveDz(t) {
  if (t.source !== 'dz') return t;
  if (resolvedDz.has(t.id)) return resolvedDz.get(t.id);
  const params = { title: t.title.replace(/\s*[\(\[][^\)\]]*\b(?:feat|with|ft)\b[^\)\]]*[\)\]]/ig, '').trim(), artist: firstArtist(t.artist), duration: t.duration || '' };
  let m = null;
  if (health.yt !== false) { try { m = await api('yt', '/api/yt/match', params, 20000); } catch (e) { if (e.offline) health.yt = false; } }
  if (!m && health.sc !== false && S.settings.fallback) { try { m = await api('sc', '/api/sc/match', params, 20000); } catch (e) { if (e.offline) health.sc = false; } }
  if (m) { m = { ...m, artwork: m.artwork || t.artwork }; resolvedDz.set(t.id, m); }
  return m;
}
async function playDzList(list, i, ctx) {
  const t = list[i]; if (!t) return;
  stopPreview(false);
  if (t.source !== 'dz') { const playable = list.filter((x) => x.source !== 'dz'); return playList(playable, playable.indexOf(t), ctx); }
  toast('Finding a playable copy…');
  const first = await resolveDz(t);
  if (!first) return toast("Couldn't find this song on YouTube or SoundCloud");
  playList([first], 0, ctx);
  (async () => {                                       // line up the next few songs while the first one plays
    for (const n of list.slice(i + 1, i + 9)) {
      if (P.ctx !== ctx) return;
      const m = await resolveDz(n);
      if (m && P.ctx === ctx) { P.queue.push(slim(m)); if (P.original) P.original.push(slim(m)); renderQueue(); }
    }
  })();
}

// --- Find: genres from your library, most-saved first, then each genre's chart
const AG = { total: 0, done: 0, running: false };
function savedTracks() {
  const m = new Map(); S.liked.forEach((t) => m.set(keyOf(t), t));
  S.playlists.forEach((p) => p.tracks.forEach((t) => { if (!m.has(keyOf(t))) m.set(keyOf(t), t); }));
  return [...m.values()];
}
function genreOfSaved(t) {
  if (t.genre) return normalizeGenre(t.genre);
  const st = stats().tracks[keyOf(t)]; if (st?.g) return st.g;
  return S.agenre[akey(t.artist)];                      // undefined = not looked up yet, '' = unknown
}
async function scanLibraryGenres() {
  if (AG.running) return;
  const todo = new Map();
  for (const t of savedTracks()) { const k = akey(t.artist); if (k && genreOfSaved(t) === undefined && !todo.has(k)) todo.set(k, firstArtist(t.artist)); }
  if (!todo.size) return;
  AG.running = true; AG.total = todo.size; AG.done = 0;
  let last = 0;
  try {
    for (const [k, name] of todo) {
      let g, ok = false;
      try { const r = await discApi('/api/genre', { artist: name }, 15000); g = r.genre; ok = true; } catch (e) { if (e.offline) break; ok = true; }
      if (ok) S.agenre[k] = g ? normalizeGenre(g) : '';
      AG.done++;
      if (Date.now() - last > 2500) { last = Date.now(); persist(); refreshFind(); }
      await sleep(250);
    }
  } finally { AG.running = false; persist(); refreshFind(); }
}
function refreshFind() {
  if (tab === 'discover' && route().name === 'discover' && (S.settings.discTab || 'find') === 'find' && document.activeElement?.tagName !== 'INPUT' && !$('#sheet').classList.contains('open')) renderPane('discover');
}
function findHtml() {
  const counts = new Map(), saved = savedTracks();
  for (const t of saved) { const g = genreOfSaved(t); if (g) counts.set(g, (counts.get(g) || 0) + 1); }
  const rows = CHART_GENRES.map((g, i) => ({ g, n: counts.get(g) || 0, i })).sort((a, b) => b.n - a.n || a.i - b.i);
  const max = Math.max(1, ...rows.map((r) => r.n));
  const row = (r) => `<button class="genre-row" style="--h:${hueOf(r.g)}" data-go="genre:${esc(r.g)}"><div class="gr-main"><b>${esc(r.g)}</b><span>${r.n ? `${songs(r.n)} in your library` : 'Browse the chart'}</span></div>
    <div class="gr-bar"><i style="width:${r.n ? Math.max(6, (r.n / max) * 100) : 0}%"></i></div>${icon('back')}</button>`;
  const mine = rows.filter((r) => r.n), more = rows.filter((r) => !r.n);
  const note = !saved.length ? 'Like songs or build playlists and your most-saved genres rise to the top.'
    : AG.running ? `Sorting your library by genre… ${AG.done} of ${AG.total} artists` : 'Ordered by what you have saved the most.';
  return `<p class="muted small" style="margin:-4px 0 12px">${note}</p>
    ${mine.length ? `<div class="genre-list">${mine.map(row).join('')}</div>` : ''}
    ${mine.length && more.length ? '<h2 class="sec-h">More genres</h2>' : ''}
    <div class="genre-list">${more.map(row).join('')}</div>`;
}
const chartCache = {};
const CHART_PERIODS = [['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const chartPeriod = () => S.settings.chartPeriod || 'week';
async function loadChart(genre, period) {
  const key = genre + '|' + period, c = chartCache[key];
  if (c?.loading || (c?.data && Date.now() - c.at < 30 * 60e3)) return;
  chartCache[key] = { ...(c || {}), loading: true, error: '' };
  try {
    const data = await discApi('/api/discover/chart', { genre, period }, 60000);
    chartCache[key] = { data, at: Date.now() };
  } catch (e) { chartCache[key] = { error: e.status === 404 ? `No chart is available for ${genre}.` : (e.message || 'Could not load the chart') }; }
  if (route().name === 'genre' && route().id === genre && chartPeriod() === period) renderPane(tab);
}
function viewGenre(r) {
  const genre = r.id, period = chartPeriod(), key = genre + '|' + period, c = chartCache[key];
  if (!c || (!c.loading && !c.error && Date.now() - c.at > 30 * 60e3)) loadChart(genre, period);
  const head = `<div class="view-head"><button class="icon-btn" data-action="back" aria-label="Back">${icon('back')}</button><h1 style="flex:1;margin-left:4px">${esc(genre)}</h1></div>
    <div class="subtabs slim">${CHART_PERIODS.map(([k, l]) => `<button class="${period === k ? 'on' : ''}" data-action="chartPeriod" data-v="${k}">${l}</button>`).join('')}</div>`;
  if (c?.error) return `${head}<div class="empty"><b>Couldn't load this chart</b>${esc(c.error)}<div style="margin-top:14px"><button class="btn" data-action="chartRetry" data-g="${esc(genre)}">Try again</button></div></div>`;
  if (!c?.data) return `${head}<p class="muted small" style="margin:-4px 0 14px">Loading the top songs in ${esc(genre)}…</p>${skeletonRows()}`;
  const { tracks, days, window } = c.data, label = { today: 'today', week: 'this week', month: 'this month', year: 'this year' }[period];
  const note = period === 'today' ? `Deezer's chart for ${esc(genre)} today.`
    : days >= window ? `Built from ${days} days of saved charts.`
    : `Still collecting: ${days} of ${window} days saved so far. This list gets more accurate every day the server is on.`;
  return `${head}<div class="chart-note">${note} Songs earn points for each day on the chart, more for a higher spot.</div>
    <div class="btn-row" style="margin-bottom:6px"><button class="btn primary" data-action="playChart" data-l="chart:${esc(key)}">Play the chart</button></div>
    ${discRows('chart:' + key, tracks, { rank: true, days: period !== 'today', ctx: `${genre} · ${label}` })}`;
}

// --- Match: look up an artist, or a song that you want more of
const MT = { mode: 'artist', q: '', loading: false, error: '', profile: null, results: null, ref: null, similar: null };
function matchHtml() {
  const seg = [['artist', 'Artist'], ['song', 'Song']].map(([k, l]) => `<button class="${MT.mode === k ? 'on' : ''}" data-action="matchMode" data-v="${k}">${l}</button>`).join('');
  const form = `<form id="match-form" class="searchbox" style="margin-bottom:14px"><svg class="lead"><use href="#i-search"/></svg><input id="mq" type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${MT.mode === 'artist' ? 'Type an artist…' : 'Type a song you like…'}" value="${esc(MT.q)}"></form>`;
  let body = '';
  if (MT.loading) body = skeletonRows();
  else if (MT.error) body = `<div class="empty"><b>${esc(MT.error)}</b></div>`;
  else if (MT.mode === 'artist') body = MT.profile ? artistHtml(MT.profile) : `<div class="empty"><b>Look up an artist</b>See their top songs, the songs they're featured on, and artists you might like if you like them.</div>`;
  else if (MT.ref) body = similarHtml();
  else body = MT.results ? (MT.results.length
      ? `<p class="muted small" style="margin:0 0 8px">Tap the song you mean:</p>${discRows('mtFind', MT.results, { row: 'matchPick', noAdd: true })}` : `<div class="empty"><b>No songs found</b>Try the title and the artist together.</div>`)
    : `<div class="empty"><b>Find songs like one you love</b>Type a song, pick it, and get similar songs to preview and add.</div>`;
  return `<div class="subtabs small">${seg}</div>${form}${body}`;
}
function artistHtml(p) {
  const a = p.artist;
  return `<div class="artist-hero">${art(absArt(a.picture))}<div><h2>${esc(a.name)}</h2><div class="muted small">${Number(a.fans).toLocaleString()} fans</div>
      <button class="btn mini" data-action="playArtist" style="margin-top:8px">Play top songs</button></div></div>
    <h2 class="sec-h">Top songs</h2>${discRows('mtTop', p.top, { rank: true, ctx: `${a.name} · top songs` })}
    ${p.featured.length ? `<h2 class="sec-h">Featured on</h2>${discRows('mtFeat', p.featured, { ctx: `Featuring ${a.name}` })}` : ''}
    ${p.related.length ? `<h2 class="sec-h">If you like ${esc(a.name)}</h2><div class="rail artists">${p.related.map((r) => `
      <button class="artist" data-action="matchArtist" data-name="${esc(r.name)}">${art(absArt(r.picture))}<div class="t">${esc(r.name)}</div><div class="a">${Number(r.fans).toLocaleString()} fans</div></button>`).join('')}</div>` : ''}`;
}
function similarHtml() {
  const r = MT.ref, S2 = MT.similar;
  const head = `<div class="ref-card">${art(absArt(r.artwork))}<div class="meta"><div class="a">Songs like</div><div class="t">${esc(r.title)}</div><div class="a">${esc(r.artist)}</div></div><button class="btn mini ghost" data-action="matchClearRef">Change</button></div>`;
  if (!S2) return head + skeletonRows();
  const hasAny = S2.radio.length || S2.artists.length;
  return head + (hasAny ? `${S2.radio.length ? `<h2 class="sec-h">Sounds like this</h2>${discRows('mtRadio', S2.radio, { ctx: `Like ${r.title}` })}` : ''}
    ${S2.artists.length ? `<h2 class="sec-h">From similar artists</h2>${discRows('mtSim', S2.artists, { ctx: `Like ${r.title}` })}` : ''}`
    : '<div class="empty"><b>Nothing similar found</b>Try a different song.</div>');
}
function bindMatch() {
  const f = $('#match-form'); if (!f) return;
  f.addEventListener('submit', (e) => { e.preventDefault(); const q = $('#mq').value.trim(); $('#mq').blur(); if (q) runMatch(q); });
  $('#mq').addEventListener('input', (e) => { MT.q = e.target.value; });
}
const redrawDiscover = () => { if (tab === 'discover' && route().name === 'discover') renderPane('discover'); else dirty.add('discover'); };
async function runMatch(q) {
  MT.q = q; MT.loading = true; MT.error = '';
  if (MT.mode === 'artist') MT.profile = null; else { MT.results = null; MT.ref = null; MT.similar = null; }
  redrawDiscover();
  try {
    if (MT.mode === 'artist') MT.profile = await discApi('/api/discover/artist', { q }, 45000);
    else MT.results = await discApi('/api/discover/tracks', { q }, 30000);
  } catch (e) { MT.error = e.status === 404 ? 'No match found. Check the spelling.' : (e.message || 'Something went wrong'); }
  MT.loading = false; redrawDiscover();
}
async function pickReference(t) {
  MT.ref = t; MT.similar = null; MT.error = ''; redrawDiscover();
  try {
    MT.similar = await discApi('/api/similar', { artist: firstArtist(t.artist), title: t.title.replace(/\s*[\(\[][^\)\]]*\b(?:feat|with|ft)\b[^\)\]]*[\)\]]/ig, '').trim(), artist_id: t.artist_id || '', duration: t.duration || '' }, 90000);
  } catch (e) { MT.similar = { radio: [], artists: [] }; MT.error = e.message || ''; }
  redrawDiscover();
}

Object.assign(actions, {
  discTab: (b) => {
    S.settings.discTab = b.dataset.v; save(); renderPane('discover');
    if (b.dataset.v === 'rec') ensureDiscover(); if (b.dataset.v === 'find') scanLibraryGenres();
  },
  matchMode: (b) => { if (MT.mode === b.dataset.v) return; Object.assign(MT, { mode: b.dataset.v, q: '', error: '', loading: false, profile: null, results: null, ref: null, similar: null }); renderPane('discover'); },
  matchArtist: (b) => { MT.mode = 'artist'; MT.q = b.dataset.name; runMatch(b.dataset.name); pane().scrollTop = 0; },
  matchPick: (b) => { const t = shown[b.dataset.l]?.tracks[+b.dataset.i]; if (t) { stopPreview(false); pickReference(t); } },
  matchClearRef: () => { MT.ref = null; MT.similar = null; MT.error = ''; renderPane('discover'); },
  chartRetry: (b) => { delete chartCache[b.dataset.g + '|' + chartPeriod()]; renderPane(tab); },
  chartPeriod: (b) => { S.settings.chartPeriod = b.dataset.v; save(); renderPane(tab); pane().scrollTop = 0; },
  playChart: (b) => { const L = shown[b.dataset.l]; if (L?.tracks.length) { setShuffle(false); playDzList(L.tracks, 0, L.ctx); } },
  playArtist: () => { const L = shown.mtTop; if (L?.tracks.length) { setShuffle(false); playDzList(L.tracks, 0, L.ctx); } },
  discPlay: (b) => { const L = shown[b.dataset.l]; if (L) playDzList(L.tracks, +b.dataset.i, L.ctx); },
  pv: (b) => { const t = shown[b.dataset.l]?.tracks[+b.dataset.i]; if (t) togglePreview(t); },
  discAdd: async (b) => {
    const t = shown[b.dataset.l]?.tracks[+b.dataset.i]; if (!t) return;
    stopPreview(false);
    if (t.source === 'dz') toast('Finding a playable copy…');
    const m = await resolveDz(t);
    if (!m) return toast("Couldn't find this song on YouTube or SoundCloud");
    trackSheet(m);
  },
});

Object.assign(actions, {
  statsRange: (b) => { S.settings.statsRange = b.dataset.v; save(); renderView(); },
  refreshDiscover: () => { if (discoverBusy) return; toast('Finding new music…'); ensureDiscover(true); },
  playDisc: (b) => { const L = shown['disc' + b.dataset.g]; if (L) playList(L.tracks, +b.dataset.i, L.ctx); },
  playDiscAll: (b) => { const L = shown['disc' + b.dataset.g]; if (L?.tracks.length) { setShuffle(false); playList(L.tracks, 0, L.ctx); } },
});
setTimeout(backfillGenres, 4000);
setTimeout(scanLibraryGenres, 8000);

// ------------------------------------------------------------------ motion: parallax background and swipe effects
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const bgLayers = $$('#bg .bgl').map((el) => ({ el, depth: +el.dataset.depth }));
const tabPill = $('#tabbar .pill'), tabBtns = $$('#tabbar button');
const MO = { tx: 0, ty: 0, cx: 0, cy: 0, raf: 0, idle: 0 };
// the background layers ease towards where your swipes and scrolling say they should be (far layers move less)
function bgFrame() {
  MO.raf = 0;
  MO.cx += (MO.tx - MO.cx) * 0.1; MO.cy += (MO.ty - MO.cy) * 0.1;
  for (const l of bgLayers) l.el.style.transform = `translate3d(${(-MO.cx * 52 * l.depth).toFixed(1)}px, ${(-MO.cy * l.depth).toFixed(1)}px, 0)`;
  if (Math.abs(MO.tx - MO.cx) > 0.0005 || Math.abs(MO.ty - MO.cy) > 0.05) MO.raf = requestAnimationFrame(bgFrame);
}
const kickBg = () => { if (!MO.raf && !reduceMotion && styleOf('bg') !== 'plain') MO.raf = requestAnimationFrame(bgFrame); };
function sizePill() { if (tabBtns[0]) tabPill.style.width = tabBtns[0].offsetWidth + 'px'; }
// pages glide, shrink and fade as you swipe; the tab bar's highlight slides and stretches like a drop of liquid
function swipeFx() {
  const w = pager.clientWidth || 1, p = Math.max(0, Math.min(TABS.length - 1, pager.scrollLeft / w));
  if (!reduceMotion) TABS.forEach((t, i) => {
    const v = pane(t).firstElementChild; if (!v) return;
    const d = i - p, a = Math.abs(d);
    if (a >= 1 || a < 0.002) { if (v.dataset.fx) { v.style.transform = ''; v.style.opacity = ''; delete v.dataset.fx; } return; }
    v.dataset.fx = '1';
    v.style.transform = `translate3d(${(d * 46).toFixed(1)}px, 0, 0) scale(${(1 - a * 0.08).toFixed(3)})`;
    v.style.opacity = (1 - a * 0.7).toFixed(3);
  });
  const i = Math.min(TABS.length - 2, Math.floor(p)), f = p - i;
  const A = tabBtns[i], B = tabBtns[i + 1];
  if (A && B) {
    const stretch = reduceMotion ? 0 : Math.sin(f * Math.PI);
    tabPill.style.transform = `translate3d(${(A.offsetLeft + (B.offsetLeft - A.offsetLeft) * f).toFixed(1)}px, 0, 0) scale(${(1 + stretch * 0.3).toFixed(3)}, ${(1 - stretch * 0.07).toFixed(3)})`;
  }
}
pager.addEventListener('scroll', () => {
  MO.tx = pager.scrollLeft / (pager.clientWidth || 1); MO.ty = Math.min(pane().scrollTop, 1200) * 0.12;
  pager.classList.add('swiping'); clearTimeout(MO.idle); MO.idle = setTimeout(() => pager.classList.remove('swiping'), 260);
  kickBg(); swipeFx();
}, { passive: true });
TABS.forEach((t) => pane(t).addEventListener('scroll', () => { if (t === tab) { MO.ty = Math.min(pane(t).scrollTop, 1200) * 0.12; kickBg(); } }, { passive: true }));
window.addEventListener('resize', () => { sizePill(); swipeFx(); });
requestAnimationFrame(() => { sizePill(); swipeFx(); });

// ------------------------------------------------------------------ playlists: press-and-hold menu, downloads, temporary shuffle
// --- shuffle: a temporary new order, kept only while the app is open. The saved order is never changed,
//     so the app always starts with every playlist in its original order.
const SH = {};          // playlist id -> its songs in the shuffled order (as "song#occurrence" ids)
const songIds = (tracks) => { const seen = {}; return tracks.map((t) => { const k = keyOf(t); seen[k] = (seen[k] || 0) + 1; return k + '#' + seen[k]; }); };
function orderedTracks(p) {
  const order = SH[p.id]; if (!order) return p.tracks;
  const ids = songIds(p.tracks), byId = new Map(ids.map((id, i) => [id, p.tracks[i]]));
  const out = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const used = new Set(order); p.tracks.forEach((t, i) => { if (!used.has(ids[i])) out.push(t); });      // songs added since go at the end
  return out;
}
function shufflePlaylist(p) {                                // a brand new random order every time it's switched on
  const orig = songIds(p.tracks);
  let ids = orig.slice();
  for (let tries = 0; tries < 6; tries++) {
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    if (ids.length < 3 || ids.some((id, i) => id !== orig[i])) break;
  }
  SH[p.id] = ids;
}

// --- downloads: the audio is saved on this device and plays from there (no server, works offline)
const DL = { have: new Map(), fail: new Map(), cur: null, busy: false, current: '', full: false, wake: null };   // have: song key -> bytes
const isPhone = () => window.matchMedia('(pointer: coarse)').matches;
const dlOpen = new Promise((resolve) => {
  try {
    const r = indexedDB.open('tristakfy-dl', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('audio'); r.result.createObjectStore('meta'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null);
  } catch { resolve(null); }
});
async function dbTx(stores, mode, fn) {
  const db = await dlOpen; if (!db) throw new Error('no storage');
  return new Promise((res, rej) => {
    const tx = db.transaction(stores, mode); let out;
    try { out = fn(...stores.map((n) => tx.objectStore(n))); } catch (e) { rej(e); return; }
    tx.oncomplete = () => res(out && 'result' in out ? out.result : out); tx.onerror = tx.onabort = () => rej(tx.error);
  });
}
const dlGetRec = (k) => dbTx(['audio'], 'readonly', (a) => a.get(k));
// the song and its size are written in one transaction: a song is either fully saved or not saved at all
const dlPutRec = (k, rec) => dbTx(['audio', 'meta'], 'readwrite', (a, m) => { a.put(rec, k); m.put({ size: rec.size, at: Date.now() }, k); });
async function dlDelTrack(k) { DL.have.delete(k); markRows(k, false); try { await dbTx(['audio', 'meta'], 'readwrite', (a, m) => { a.delete(k); m.delete(k); }); } catch {} }
async function dlInit() {
  try { await dbTx(['meta'], 'readonly', (m) => { m.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { DL.have.set(c.key, c.value.size); c.continue(); } }; }); } catch {}
}
async function dlUrl(t) {
  const k = keyOf(t);
  let rec;
  try { rec = await dlGetRec(k); if (!rec?.blob) throw new Error('missing'); }
  catch { dlDelTrack(k); return null; }
  let blob = rec.blob;
  try { blob = await mp4FixBlob(blob); } catch {}              // songs saved before the length fix
  return URL.createObjectURL(blob);
}

// iPhones show YouTube's fragmented m4a songs at double length (the second half silent) because the
// header's length fields and the pieces after it get added together. Setting the header's lengths to 0
// (what streaming files normally say) fixes it. Same bytes count, so nothing else moves. The server does
// this for new songs; this covers songs downloaded before. Matches server/mp4fix.py.
async function mp4FixBlob(blob) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const dv = new DataView(head.buffer), typ = (i) => String.fromCharCode(head[i + 4], head[i + 5], head[i + 6], head[i + 7]);
  if (head.length < 16 || typ(0) !== 'ftyp') return blob;
  let i = 0, moov = -1, mend = 0;
  while (i + 8 <= head.length) {
    const size = dv.getUint32(i), t = typ(i);
    if (size < 8) return blob;
    if (t === 'moov') { moov = i; mend = i + size; break; }
    if (t === 'moof' || t === 'mdat') return blob;
    i += size;
  }
  if (moov < 0 || mend > head.length) return blob;
  let changed = false;
  const zero = (off, n) => { for (let j = 0; j < n; j++) if (head[off + j]) { head[off + j] = 0; changed = true; } };
  const walk = (start, end) => {
    for (let i = start; i + 8 <= end;) {
      const size = dv.getUint32(i), t = typ(i), b = i + 8, v = head[b];
      if (size < 8 || i + size > end) return;
      if (t === 'mvhd' || t === 'mdhd') v === 1 ? zero(b + 24, 8) : zero(b + 16, 4);
      else if (t === 'tkhd') v === 1 ? zero(b + 28, 8) : zero(b + 20, 4);
      else if (t === 'elst') {
        const count = Math.min(dv.getUint32(b + 4), 64), [n, step] = v === 1 ? [8, 20] : [4, 12];
        for (let k = 0; k < count; k++) if (b + 8 + k * step + n <= i + size) zero(b + 8 + k * step, n);
      } else if (['trak', 'mdia', 'minf', 'stbl', 'edts'].includes(t)) walk(b, i + size);
      i += size;
    }
  };
  walk(moov + 8, mend);
  return changed ? new Blob([head.slice(0, mend), blob.slice(mend)], { type: blob.type || 'audio/mp4' }) : blob;
}

// --- what this device should have: every playlist marked "download" (that flag syncs), plus Liked Songs if chosen here
function dlCollections() {
  const out = S.playlists.filter((p) => p.download).map((p) => ({ id: p.id, name: p.name, tracks: p.tracks }));
  if (S.settings.dlLiked) out.unshift({ id: 'liked', name: 'Liked Songs', tracks: S.liked });
  return out;
}
function dlNeed() { const need = new Map(); for (const c of dlCollections()) for (const t of c.tracks) if (!need.has(keyOf(t))) need.set(keyOf(t), t); return need; }
const collTracks = (id) => (id === 'liked' ? S.liked : getPlaylist(id)?.tracks || []);
const isMarked = (id) => (id === 'liked' ? !!S.settings.dlLiked : !!getPlaylist(id)?.download);
function collStatus(id) {
  const keys = [...new Set(collTracks(id).map(keyOf))];
  const have = keys.filter((k) => DL.have.has(k)).length, bytes = keys.reduce((n, k) => n + (DL.have.get(k) || 0), 0);
  const failed = keys.filter((k) => !DL.have.has(k) && DL.fail.has(k)).length;
  return { total: keys.length, have, bytes, failed, done: keys.length > 0 && have === keys.length };
}
const mb = (bytes) => { const m = bytes / 1048576; return m >= 1000 ? (m / 1024).toFixed(1) + ' GB' : (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' MB'; };
async function dlGc() {                                      // delete songs that nothing marked for download needs any more
  const need = dlNeed();
  for (const k of [...DL.have.keys()]) if (!need.has(k)) await dlDelTrack(k);
  dlUi();
}

// --- fetching one song: only a complete, plausible file is kept
async function dlFetch(t) {
  const get = async (x) => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 240000);
    try {
      const url = x.source === 'yt' ? apiUrl('yt', `/api/yt/stream/${encodeURIComponent(x.id)}`, { dl: 1 }) : apiUrl('sc', `/api/sc/file/${encodeURIComponent(x.id)}`);     // dl=1: audio only, never video
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('the server answered ' + res.status);
      if (!/^audio\//i.test(res.headers.get('content-type') || '')) throw new Error('that was not an audio file');     // downloads are audio only
      const len = +res.headers.get('content-length') || 0;
      const blob = await res.blob();
      const broken = (why) => Object.assign(new Error(why), { transient: true });    // a glitch: try the same song again later
      if (len && blob.size !== len) throw broken('the download was cut short');
      if (blob.size < 20000 || (x.duration && blob.size < x.duration * 2000)) throw broken('the file was too small to be the whole song');
      return blob;
    } finally { clearTimeout(timer); }
  };
  let blob, via = t.source;
  try { blob = await get(t); }
  catch (e) {                                                // YouTube refused or is off: save the SoundCloud copy instead
    if (e.transient || e.name === 'AbortError' || t.source !== 'yt' || !S.settings.fallback) throw e;     // a cut-short file is retried, not swapped
    const alt = await scMatch(t); if (!alt) throw e;
    blob = await get(alt); via = 'sc';
  }
  try { blob = await mp4FixBlob(blob); } catch {}              // belt and braces: the saved file has the fixed length header
  await dlPutRec(keyOf(t), { blob, size: blob.size, type: blob.type, via });
  DL.have.set(keyOf(t), blob.size);
}

// --- one queue for everything marked, two songs at a time, while the app is open (iOS pauses web apps in the background)
const retryAfter = (n) => Math.min(30 * 60e3, 60e3 * 2 ** (n - 1));         // 1, 2, 4 ... up to 30 minutes
async function dlWake(on) {
  try {
    if (on && !DL.wake && document.visibilityState === 'visible' && navigator.wakeLock) DL.wake = await navigator.wakeLock.request('screen');
    if (!on && DL.wake) { await DL.wake.release(); DL.wake = null; }
  } catch { DL.wake = null; }
}
async function dlPump() {
  if (DL.busy || !isPhone() || DL.full) return;
  DL.busy = true; dlWake(true);
  try {
    for (;;) {
      const now = Date.now();
      const todo = [...dlNeed()].filter(([k]) => { const f = DL.fail.get(k); return !DL.have.has(k) && !(f && now - f.at < retryAfter(f.n)); });
      if (!todo.length) break;
      await Promise.all(todo.slice(0, 2).map(async ([k, t]) => {
        DL.current = t.title; dlUi();
        try { await dlFetch(t); DL.fail.delete(k); markRows(k, true); }
        catch (e) {
          if (e?.name === 'QuotaExceededError') DL.full = true;
          const f = DL.fail.get(k) || { n: 0 }; DL.fail.set(k, { at: Date.now(), n: f.n + 1, why: e?.message || 'unknown error' });
        }
      }));
      dlUi();
      if (DL.full) { toast('No room left for downloads on this phone. See Settings → Downloads & storage.'); break; }
    }
  } finally { DL.busy = false; DL.current = ''; dlWake(false); dlUi(); }
}
function dlEnsure(id) { if (isMarked(id)) dlPump(); }
function markDownload(id, on) {
  if (id === 'liked') S.settings.dlLiked = on; else { const p = getPlaylist(id); if (!p) return; p.download = on; }
  save();
  if (on) {
    navigator.storage?.persist?.().then((ok) => { STG.persisted = ok; });
    DL.full = false; toast(isPhone() ? 'Downloading…' : 'It will download on your phone'); dlPump();
  } else { dlGc(); toast('Downloads removed'); }
  renderView();
}
function askRemoveDownload(id) {
  const st = collStatus(id), name = id === 'liked' ? 'Liked Songs' : getPlaylist(id)?.name || 'this playlist';
  openSheet(`<div class="sheet-title">Remove the download of “${esc(name)}”?</div><div class="sheet-pad muted small" style="padding-bottom:8px">Frees ${mb(st.bytes)}. The songs stay in the playlist and stream as usual.</div>
    <button class="act danger" data-act="yes">${icon('trash')}Remove download</button><button class="act" data-act="no">Cancel</button>`,
  (a) => { closeSheet(); if (a === 'yes') markDownload(id, false); });
}

// --- showing it
function markRows(k, on) { document.querySelectorAll('.row[data-k]').forEach((r) => { if (r.dataset.k === k) r.classList.toggle('dl', on); }); }
function dlButton(id) {
  const st = collStatus(id), on = isMarked(id), pct = st.total ? Math.round((st.have / st.total) * 100) : 0;
  const cls = !on ? '' : st.done ? ' done' : ' on';
  return `<button class="icon-btn dl-btn${cls}" id="dl-btn" data-action="dlToggle" data-id="${id}" style="--p:${pct}" aria-label="${on ? 'Remove download' : 'Download'}">${icon(on && st.done ? 'check' : 'download')}</button>`;
}
function dlChipInner(id) {
  const st = collStatus(id);
  if (!isPhone()) return `${icon('download')}Will download on your phone`;
  if (st.done) return `${icon('check')}Available offline · ${mb(st.bytes)}`;
  if (DL.full) return `${icon('download')}${st.have} of ${st.total} · no room left`;
  if (DL.busy) return `${icon('download')}Downloading ${st.have} of ${st.total}…`;
  if (st.failed) return `${icon('download')}${st.have} of ${st.total} · ${st.failed} failed, will retry`;
  return `${icon('download')}${st.have} of ${st.total} downloaded`;
}
let dlUiTimer = 0;
function dlUi() {
  const r = route();
  if (r.name === 'playlist' && isMarked(r.id) !== undefined) {
    const chip = $('#dl-chip'), btn = $('#dl-btn');
    if (chip) chip.innerHTML = dlChipInner(r.id);
    if (btn) btn.outerHTML = dlButton(r.id);
  }
  $$('#pane-library .lib-row[data-pl]').forEach((row) => { const p = getPlaylist(row.dataset.pl); const a = row.querySelector('.a'); if (p && a) a.innerHTML = libRowBits(p); });
  clearTimeout(dlUiTimer);
  dlUiTimer = setTimeout(() => {
    if (route().name === 'storage' && !$('#sheet').classList.contains('open')) renderPane(tab);
  }, 500);
}
function refreshPlaylistViews() {
  if (document.querySelector('.row.pulling') || document.activeElement?.tagName === 'INPUT') return;
  if (tab === 'library' && route().name === 'library') renderPane('library'); else dirty.add('library');
}
function plChips(L) {
  if (L.kind !== 'playlist' && L.kind !== 'liked') return '';
  const id = L.kind === 'liked' ? 'liked' : L.p.id, out = [];
  if (L.kind === 'playlist' && SH[id]) out.push(`<button class="chip-s on" data-action="unshuffle" data-id="${id}">${icon('shuffle')}Shuffled<b>✕</b></button>`);
  if (isMarked(id)) out.push(`<span class="chip-s" id="dl-chip">${dlChipInner(id)}</span>`);
  return out.length ? `<div class="pl-chips">${out.join('')}</div>` : '';
}
function libRowBits(p) {
  const bits = [`Playlist · ${songs(p.tracks.length)}`];
  if (p.download) { const st = collStatus(p.id); bits.push(`<span class="dl-mark${st.done ? ' done' : ''}">${icon(st.done ? 'check' : 'download')}${st.done ? 'Offline' : `${st.have}/${st.total}`}</span>`); }
  if (SH[p.id]) bits.push(`<span class="dl-mark">${icon('shuffle')}Shuffled</span>`);
  return bits.join(' · ');
}
function libRow(p) {
  return `<button class="lib-row" data-go="playlist:${p.id}" data-pl="${p.id}">${playlistArt(p.tracks, 'art')}<div><div class="t">${esc(p.name)}</div><div class="a">${libRowBits(p)}</div></div></button>`;
}

// --- Settings → Downloads & storage
const STG = { est: null, persisted: null, at: 0 };
async function refreshStorageInfo() {
  if (Date.now() - STG.at < 4000) return; STG.at = Date.now();
  try { STG.est = await navigator.storage?.estimate?.(); } catch { STG.est = null; }
  try { STG.persisted = await navigator.storage?.persisted?.(); } catch { STG.persisted = null; }
  if (route().name === 'storage') renderPane(tab);
}
function viewStorage() {
  refreshStorageInfo();
  const total = [...DL.have.values()].reduce((a, b) => a + b, 0), count = DL.have.size;
  const est = STG.est, quota = est?.quota || 0, used = est?.usage || 0;
  const failed = [...dlNeed().keys()].filter((k) => !DL.have.has(k) && DL.fail.has(k));
  const status = !isPhone() ? 'Downloads happen on your phone: mark playlists here and they download when the app is open there.'
    : DL.full ? 'Paused: the phone has no room left for this app. Remove a download or free up space on the phone.'
    : DL.busy ? `Downloading “${esc(DL.current)}”… keep the app open.`
    : failed.length ? `${songs(failed.length)} couldn't download yet and will be tried again.`
    : dlCollections().length ? 'Everything marked is downloaded.' : 'Nothing is marked for download yet.';
  const lists = [{ id: 'liked', name: 'Liked Songs' }, ...S.playlists.map((p) => ({ id: p.id, name: p.name }))];
  const row = (c) => { const st = collStatus(c.id), on = isMarked(c.id);
    return `<div class="stg-row"><div class="meta"><div class="t">${esc(c.name)}</div><div class="a">${on ? `${st.have} of ${st.total} · ${mb(st.bytes)}${st.failed ? ` · ${st.failed} failed` : ''}` : `${songs(st.total)} · not downloaded`}</div></div>${dlButton(c.id).replace('id="dl-btn" ', '')}</div>`; };
  return `<button class="icon-btn back" data-action="back" aria-label="Back">${icon('back')}</button>
    <div class="view-head"><h1>Downloads</h1></div>
    <div class="stg-hero"><b>${mb(total)}</b><span>${songs(count)} saved on this device</span>
      ${quota ? `<div class="gt" style="margin-top:12px"><i style="width:${Math.max(1, Math.min(100, (used / quota) * 100))}%"></i></div><div class="muted small" style="margin-top:6px">This app uses ${mb(used)} of the ${mb(quota)} the phone allows it</div>` : ''}</div>
    <div class="chart-note">${status}</div>
    <div class="group-title">Keeping downloads safe</div>
    <div class="group"><div class="field"><div class="hint" style="margin:0">${STG.persisted ? 'This device has agreed not to clear the downloads automatically.' : 'iOS can clear web app storage when the phone runs low on space. If that happens, the app downloads the songs again the next time it is open (with your PC on).'}</div></div>
      ${STG.persisted ? '' : '<div class="btn-row"><button class="btn" data-action="stgPersist">Ask to keep downloads</button></div>'}</div>
    <div class="btn-row" style="margin:4px 0 16px"><button class="btn primary" data-action="dlAll">Download all</button><button class="btn" data-action="dlNone">Remove all downloads</button><button class="btn" data-action="dlRedo">Redownload all</button>${failed.length ? '<button class="btn" data-action="dlRetry">Retry failed</button>' : ''}</div>
    <div class="group-title">Playlists</div>
    <div class="stg-list">${lists.map(row).join('')}</div>`;
}
Object.assign(actions, {
  dlToggle: (b) => { const id = b.dataset.id; if (isMarked(id)) askRemoveDownload(id); else markDownload(id, true); },
  dlAll: () => { S.settings.dlLiked = true; S.playlists.forEach((p) => { p.download = true; }); save(); navigator.storage?.persist?.(); DL.full = false; toast('Downloading everything…'); dlPump(); renderView(); },
  dlNone: () => openSheet(`<div class="sheet-title">Remove every download?</div><div class="sheet-pad muted small" style="padding-bottom:8px">Frees ${mb([...DL.have.values()].reduce((a, b) => a + b, 0))} on this device. Your playlists stay as they are.</div>
      <button class="act danger" data-act="yes">${icon('trash')}Remove all downloads</button><button class="act" data-act="no">Cancel</button>`,
    (a) => { closeSheet(); if (a !== 'yes') return; S.settings.dlLiked = false; S.playlists.forEach((p) => { p.download = false; }); save(); dlGc(); toast('All downloads removed'); renderView(); }),
  dlRedo: () => openSheet(`<div class="sheet-title">Redownload every song?</div><div class="sheet-pad muted small" style="padding-bottom:8px">Deletes the ${DL.have.size} downloaded songs on this device, then downloads them all again. Keep the app open and your PC on while it runs. Your playlists stay as they are.</div>
      <button class="act danger" data-act="yes">${icon('download')}Delete and redownload</button><button class="act" data-act="no">Cancel</button>`,
    async (a) => {
      closeSheet(); if (a !== 'yes') return;
      for (const k of [...DL.have.keys()]) await dlDelTrack(k);
      DL.fail.clear(); DL.full = false; dlUi(); toast('Redownloading everything…'); dlPump(); renderView();
    }),
  mixLen: (b) => { S.settings.mixLen = +b.dataset.v; save(); renderView(); },
  dlRetry: () => { DL.fail.clear(); DL.full = false; dlPump(); renderView(); },
  stgPersist: async () => { let ok = false; try { ok = await navigator.storage?.persist?.(); } catch {} STG.persisted = ok; STG.at = 0; toast(ok ? 'Downloads are protected' : "This device didn't agree (on iPhone, using the app from the Home Screen helps)"); renderView(); },
});
addEventListener('online', () => { DL.full = false; dlPump(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { dlPump(); if (DL.busy) dlWake(true); } });
setInterval(dlPump, 60e3);                                  // picks up retries whose wait is over

// --- the menu that opens when you press and hold a playlist
const POP = { id: null, timer: 0 };
function popChecks(p) {
  const chk = (on) => `<i class="chk${on ? ' on' : ''}">${on ? icon('check') : ''}</i>`;
  return `<div class="pop-title">${esc(p.name)}</div>
    <button data-pop="download">${icon('download')}<span>Download<small>${isPhone() ? 'Save it on this phone and play offline' : 'Saved to your phone when you open it there'}</small></span>${chk(p.download)}</button>
    <button data-pop="rename">${icon('edit')}<span>Rename playlist</span></button>
    <button data-pop="shuffle">${icon('shuffle')}<span>Shuffle playlist<small>A new random order until you uncheck it</small></span>${chk(!!SH[p.id])}</button>`;
}
function openPlMenu(id, row) {
  const p = getPlaylist(id); if (!p) return;
  clearTimeout(POP.timer); POP.id = id;
  const pop = $('#pop'), scrim = $('#pop-scrim');
  pop.innerHTML = popChecks(p); pop.classList.remove('hidden', 'up', 'open'); scrim.classList.remove('hidden');
  const r = row.getBoundingClientRect(), w = 288, h = pop.offsetHeight;
  const below = r.bottom + 10 + h < innerHeight - 90;
  pop.style.left = Math.max(12, Math.min(r.left + 14, innerWidth - w - 12)) + 'px';
  pop.style.top = (below ? r.bottom + 10 : Math.max(12, r.top - h - 10)) + 'px';
  pop.classList.toggle('up', !below);
  row.classList.add('lifted');
  requestAnimationFrame(() => requestAnimationFrame(() => { pop.classList.add('open'); scrim.classList.add('open'); }));
}
function closePlMenu() {
  const pop = $('#pop'), scrim = $('#pop-scrim');
  pop.classList.remove('open'); scrim.classList.remove('open'); $$('.lib-row.lifted').forEach((r) => r.classList.remove('lifted'));
  POP.timer = setTimeout(() => { pop.classList.add('hidden'); scrim.classList.add('hidden'); POP.id = null; }, 320);
}
$('#pop-scrim').addEventListener('click', closePlMenu);
$('#pop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pop]'), p = getPlaylist(POP.id); if (!b) return; if (!p) return closePlMenu();
  const what = b.dataset.pop;
  if (what === 'rename') { closePlMenu(); setTimeout(() => promptName('Rename playlist', p.name, (name) => { p.name = name; save(); renderView(); }), 300); return; }
  if (what === 'download') {
    markDownload(p.id, !p.download);
  } else if (what === 'shuffle') {
    if (SH[p.id]) { delete SH[p.id]; toast('Original order restored'); } else { shufflePlaylist(p); toast('Playlist shuffled'); }
  }
  $('#pop').innerHTML = popChecks(p);                       // show the new tick, then tuck the menu away
  renderView(); setTimeout(closePlMenu, 420);
});
// press and hold (or right-click) a playlist in Your Library
(() => {
  let timer = 0, row = null, sx = 0, sy = 0, fired = false, mute = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; row?.classList.remove('pressing'); };
  pager.addEventListener('click', (e) => { if (Date.now() < mute) { e.stopPropagation(); e.preventDefault(); } }, true);
  pager.addEventListener('touchstart', (e) => {
    const r = e.target.closest('.lib-row[data-pl]'); if (!r || e.touches.length > 1) return;
    row = r; sx = e.touches[0].clientX; sy = e.touches[0].clientY; fired = false; r.classList.add('pressing');
    timer = setTimeout(() => { timer = 0; fired = true; r.classList.remove('pressing'); navigator.vibrate?.(14); openPlMenu(r.dataset.pl, r); }, 460);
  }, { passive: true });
  pager.addEventListener('touchmove', (e) => { if (timer && (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10)) cancel(); }, { passive: true });
  const end = () => { cancel(); if (fired) { mute = Date.now() + 500; fired = false; } };       // lifting the finger must not open the playlist
  pager.addEventListener('touchend', end); pager.addEventListener('touchcancel', end);
  pager.addEventListener('contextmenu', (e) => { const r = e.target.closest('.lib-row[data-pl]'); if (r) { e.preventDefault(); mute = Date.now() + 500; openPlMenu(r.dataset.pl, r); } });
})();
Object.assign(actions, { unshuffle: (b) => { delete SH[b.dataset.id]; renderView(); toast('Original order restored'); } });

// ------------------------------------------------------------------ trending artists, "Find similar...", swipe right to go back
let trendingBusy = false;
function trendingHtml() {
  const list = S.trending?.artists || [];
  if (!list.length) return trendingBusy ? `<h2>Trending artists</h2><div class="sk-rail">${'<div class="sk"></div>'.repeat(4)}</div>` : '';
  return `<h2>Trending artists</h2><div class="rail">${list.map((a, i) => `
    <button class="card" data-action="openArtist" data-name="${esc(a.name)}">${art(absArt(a.picture))}<div class="t">${esc(a.name)}</div><div class="a">#${i + 1} this week</div></button>`).join('')}</div>`;
}
function redrawHome() {
  const idle = !$('#sheet').classList.contains('open') && !pager.classList.contains('swiping') && !document.querySelector('.row.pulling') && document.activeElement?.tagName !== 'INPUT';
  if (tab === 'home' && route().name === 'home' && idle) renderPane('home'); else dirty.add('home');
}
async function loadTrending(force = false) {
  const T = S.trending;
  if (trendingBusy || (!force && T && Date.now() - T.at < 3 * 3600e3)) return;
  trendingBusy = true; if (!T) redrawHome();
  try {
    const d = await discApi('/api/discover/trending', {}, 60000);
    if (d?.artists?.length) { S.trending = { at: Date.now(), artists: d.artists.slice(0, 15) }; persist(); }
  } catch {}
  trendingBusy = false; redrawHome();
}
setTimeout(loadTrending, 1500);
setInterval(() => loadTrending(), 30 * 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadTrending(); });

// open an artist (from the Home rail) in Discover -> Match
function openArtist(name) {
  S.settings.discTab = 'match'; save();
  Object.assign(MT, { mode: 'artist', q: name, error: '', loading: false, profile: null, results: null, ref: null, similar: null });
  stacks.discover = [stacks.discover[0]];
  if (tab !== 'discover') switchTab('discover'); else renderPane('discover');
  runMatch(name);
}
// "Find similar..." on any song: jump to Discover -> Match -> Song with that song as the reference
function findSimilar(t) {
  S.settings.discTab = 'match'; save();
  Object.assign(MT, { mode: 'song', q: t.title, error: '', loading: false, profile: null, results: null, ref: t, similar: null });
  stacks.discover = [stacks.discover[0]];
  if (tab !== 'discover') switchTab('discover'); else renderPane('discover');
  pickReference(t);
}
Object.assign(actions, { openArtist: (b) => openArtist(b.dataset.name) });

// inside a page (a playlist, a chart, Settings...) a right swipe goes back instead of changing tab; a left swipe still moves on to the next tab
(() => {
  let g = null;
  const blocked = () => $('#sheet').classList.contains('open') || document.body.classList.contains('player-open') || !$('#pop').classList.contains('hidden');
  pager.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || stacks[tab].length < 2 || blocked()) { g = null; return; }
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, mode: '', dx: 0, view: pane().firstElementChild, onRow: !!e.target.closest('.row[data-list]') };
  }, { passive: true });
  pager.addEventListener('touchmove', (e) => {
    if (!g || !g.view) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.mode) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }          // it's a scroll
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      g.mode = dx > 0 ? 'back' : 'next';
      if (g.mode === 'back') { g.view.style.transition = 'none'; g.view.style.willChange = 'transform, opacity'; }
    }
    g.dx = dx;
    if (g.mode === 'back') {
      g.view.style.transform = `translate3d(${(Math.max(0, dx) * 0.92).toFixed(1)}px, 0, 0)`;
      g.view.style.opacity = (1 - Math.min(Math.max(0, dx), 300) / 420).toFixed(2);
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const end = (cancel) => {
    if (!g) return;
    const { mode, dx, view, onRow } = g; g = null;
    if (mode === 'next') {                              // left swipe: next tab (a left swipe that starts on a song row queues it instead)
      if (!cancel && !onRow && dx < -90) { const n = TABS[TABS.indexOf(tab) + 1]; if (n) switchTab(n); }
      return;
    }
    if (mode !== 'back') return;
    view.style.transition = 'transform .24s cubic-bezier(.2, .8, .2, 1), opacity .2s ease';
    if (!cancel && dx > 90) {
      view.style.transform = `translate3d(${pager.clientWidth}px, 0, 0)`; view.style.opacity = '0';
      setTimeout(() => { view.style.transition = ''; view.style.transform = ''; view.style.opacity = ''; view.style.willChange = ''; back(); }, 200);
    } else {
      view.style.transform = ''; view.style.opacity = '';
      setTimeout(() => { view.style.transition = ''; view.style.willChange = ''; }, 280);
    }
  };
  pager.addEventListener('touchend', () => end(false));
  pager.addEventListener('touchcancel', () => end(true));
})();

// ------------------------------------------------------------------ Play video (YouTube songs)
// The video plays in YouTube's own embedded player (YouTube no longer gives out one file with picture and
// sound, so the server can't pass it through like audio). Your music pauses meanwhile and resumes after.
const VID = { player: null, resume: false, api: null, open: false };
function loadYtApi() {
  if (VID.api) return VID.api;
  VID.api = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api';
    sc.onerror = () => { VID.api = null; reject(new Error('offline')); };
    document.head.appendChild(sc);
    setTimeout(() => { if (!window.YT?.Player) { VID.api = null; reject(new Error('timeout')); } }, 12000);
  });
  return VID.api;
}
function setVidMsg(msg, bad) { const m = $('#vid-msg'); m.textContent = msg; m.classList.toggle('bad', !!bad); }
async function playVideo(t) {
  if (t.source !== 'yt') return;
  stopPreview(false);
  VID.resume = !audio.paused; audio.pause();
  const el = $('#vid'); el.classList.remove('hidden'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open'))); VID.open = true;
  $('#vid-title').textContent = t.title; $('#vid-artist').textContent = t.artist; $('#vid-stage').innerHTML = '';
  $('#vid-open').href = `https://www.youtube.com/watch?v=${t.id}`; setVidMsg('Loading the video…');
  let id = t.id;
  try { const r = await api('yt', `/api/yt/videoid/${encodeURIComponent(t.id)}`, { title: t.title.replace(/\s*[\(\[][^\)\]]*(?:feat|with|ft)[^\)\]]*[\)\]]/ig, '').trim(), artist: firstArtist(t.artist), duration: t.duration || '' }, 15000); if (r?.id) id = r.id; } catch {}     // the official video, when there is one
  if (!VID.open) return;
  $('#vid-open').href = `https://www.youtube.com/watch?v=${id}`;
  try {
    const YT = await loadYtApi(); if (!VID.open) return;
    $('#vid-stage').innerHTML = '<div id="vid-player"></div>';
    VID.player = new YT.Player('vid-player', {
      videoId: id, width: '100%', height: '100%',
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
      events: {
        onReady: (e) => { setVidMsg(''); try { e.target.playVideo(); } catch {} },
        onError: (e) => {
          if ([101, 150].includes(e.data) && id !== t.id) {          // the official video can't be embedded: use the song's own video instead
            id = t.id; $('#vid-open').href = `https://www.youtube.com/watch?v=${t.id}`; setVidMsg("The official video can't play outside YouTube's own app, so this is YouTube's version of the song.");
            try { VID.player.loadVideoById(t.id); } catch {} return;
          }
          setVidMsg([101, 150].includes(e.data) ? "YouTube doesn't allow this video to play outside its own app. Use “Open in YouTube” below." : "This video can't be played right now.", true);
        },
        onStateChange: (e) => { if (e.data === 1 && !audio.paused) audio.pause(); },
      },
    });
  } catch { setVidMsg("Couldn't reach YouTube. Check the internet connection, or use “Open in YouTube” below.", true); }
}
function closeVideo() {
  if (!VID.open) return; VID.open = false;
  try { VID.player?.destroy(); } catch {} VID.player = null; $('#vid-stage').innerHTML = '';
  const el = $('#vid'); el.classList.remove('open'); setTimeout(() => { if (!VID.open) el.classList.add('hidden'); }, 320);
  if (VID.resume) { VID.resume = false; audio.play().catch(() => {}); }
}
$('#vid-close').onclick = closeVideo;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVideo(); });

// ------------------------------------------------------------------ A-B loop
// Tap A-B once to mark where the loop starts, again to mark where it ends (the song jumps back to A and
// keeps looping), a third time to clear it. The loop belongs to the song that's playing.
const AB = { a: null, b: null, timer: 0 };
const abDur = () => (audio.duration && isFinite(audio.duration) ? audio.duration : P.queue[P.index]?.duration || 0);
const r1 = (x) => Math.round(x * 10) / 10;
const fmtT = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;      // 1:05.5, so half-second nudges are visible
function abUi() {
  const d = abDur(), pct = (x) => (d ? Math.min(100, Math.max(0, (x / d) * 100)) : 0);
  const state = AB.b != null ? 'on' : AB.a != null ? 'a' : '', btn = $('#p-ab');
  btn.dataset.state = state; btn.classList.toggle('on', state !== '');
  btn.querySelector('.ab-t').textContent = state === 'a' ? 'A →' : 'A–B';
  const ma = $('#p-seek .abm.a'), mb = $('#p-seek .abm.b'), seg = $('#p-seek .abseg');
  ma.style.display = AB.a != null ? 'block' : 'none'; mb.style.display = AB.b != null ? 'block' : 'none'; seg.style.display = AB.b != null ? 'block' : 'none';
  if (AB.a != null) ma.style.left = pct(AB.a) + '%';
  if (AB.b != null) mb.style.left = pct(AB.b) + '%';
  if (AB.a != null && AB.b != null) { seg.style.left = pct(AB.a) + '%'; seg.style.width = Math.max(0, pct(AB.b) - pct(AB.a)) + '%'; }
  $('#ab-bar').classList.toggle('hidden', AB.a == null);
  $('#ab-a').textContent = AB.a != null ? fmtT(AB.a) : '–';
  $('#ab-b').textContent = AB.b != null ? fmtT(AB.b) : 'tap A–B';
}
function abClear() { AB.a = AB.b = null; clearInterval(AB.timer); AB.timer = 0; abUi(); }
function abWatch() {                                         // checked every 50 ms while a loop is set, so it turns around on the beat
  clearInterval(AB.timer); AB.timer = 0;
  if (AB.a != null && AB.b != null) AB.timer = setInterval(abCheck, 50);
}
function abCheck() {
  if (AB.a == null || AB.b == null || audio.paused || audio.seeking) return;
  const t = audio.currentTime;
  if (t >= AB.b - 0.03 && t < AB.b + 1.5) audio.currentTime = AB.a;      // seeking well past B means you left the loop on purpose
}
function abTap() {
  if (P.index < 0) return toast('Play a song first');
  const t = audio.currentTime || 0;
  if (AB.a == null) { AB.a = r1(t); toast(`Loop starts at ${fmtT(t)}. Tap A–B again where it should end.`); }
  else if (AB.b == null) {
    if (t < AB.a + 0.8) return toast('Pick a point a little later in the song');
    AB.b = r1(t); audio.currentTime = AB.a; toast(`Looping ${fmtT(AB.a)} to ${fmtT(AB.b)}`);
  } else { abClear(); toast('Loop cleared'); return; }
  abUi(); abWatch();
}
function abNudge(what) {                                     // fine-tune by half a second, and jump there so you hear it
  const d = abDur(), step = 0.5, minGap = 0.8;
  if (what === 'clear') { abClear(); return toast('Loop cleared'); }
  if (what === 'a-') AB.a = r1(Math.max(0, AB.a - step));
  if (what === 'a+') AB.a = r1(Math.min((AB.b ?? d) - minGap, AB.a + step));
  if (what === 'b-' && AB.b != null) AB.b = r1(Math.max(AB.a + minGap, AB.b - step));
  if (what === 'b+' && AB.b != null) AB.b = r1(Math.min(d || AB.b + step, AB.b + step));
  if (what.startsWith('a')) audio.currentTime = AB.a; else if (AB.b != null) audio.currentTime = Math.max(AB.a, AB.b - 1.5);
  abUi();
}
$('#p-ab').onclick = abTap;
$('#ab-bar').addEventListener('click', (e) => { const b = e.target.closest('[data-ab]'); if (b) abNudge(b.dataset.ab); });
onAudio('timeupdate', abCheck);               // a coarse backup if the phone slows the timer
onAudio('durationchange', abUi);

// ------------------------------------------------------------------ seamless transitions (downloaded songs)
// When the song playing and the next one are both downloaded, the next song starts before this one ends:
// one fades out while the other fades in (equal-power curves, so the loudness stays even). Each downloaded
// song is scanned once to find where its sound really starts and stops and whether its ending fades out,
// so the blend skips silence and spans a fading outro instead of cutting into the loud part.
//
// iPhones ignore an <audio> element's volume, so fading needs Web Audio, and while Web Audio plays, the
// iPhone lock screen loses its seek bar. So songs always play on the page's own <audio> (lock screen
// works), and Web Audio is used only for the seconds of a blend:
//   'pre'   a few seconds before: the outgoing song also starts on deck X, silent, steered into step
//           with the main player (by nudging its speed), then takes over as the blend starts;
//   'blend' X fades out while the next song rises on deck Y;
//   'back'  the new song starts again on the main player, muted, steered into step with Y, then the
//           main player is unmuted and Y stops. Web Audio is then paused, so iOS shows the normal lock screen.
const MIX_LENS = [[4, 'Short'], [8, 'Medium'], [12, 'Long']];
const mixLen = () => S.settings.mixLen || 8;
const deckOf = (el) => MX.decks.find((d) => d.el === el);
const onDeck = () => !!deckOf(audio);
MX.phase = ''; MX.x = null;
try { MX.info = JSON.parse(localStorage.getItem('tristakfy.mix') || '{}') || {}; } catch { MX.info = {}; }
const mxSaveInfo = () => { try { localStorage.setItem('tristakfy.mix', JSON.stringify(MX.info)); } catch {} };

function mxCtx() {
  if (!MX.ctx) {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}     // iOS 17+: not muted by the silent switch
    try {
      MX.ctx = new C();
      for (const d of MX.decks) { d.gain = MX.ctx.createGain(); MX.ctx.createMediaElementSource(d.el).connect(d.gain); d.gain.connect(MX.ctx.destination); }
    } catch { MX.ctx = null; return null; }
    MX.ctx.onstatechange = mxWatchCtx;
  }
  clearTimeout(MX.sleepTimer); MX.sleepTimer = 0;
  if (MX.ctx.state !== 'running') MX.ctx.resume().catch(() => {});
  return MX.ctx;
}
function mxUnlock() {                                         // runs on a tap: start the mixer once, let the decks play later on their own
  const first = !MX.ctx; mxCtx();
  for (const d of MX.decks) if (!d.unlocked && !d.el.src) { d.unlocked = true; d.el.src = SILENT; d.el.play().then(() => d.el.pause()).catch(() => { d.unlocked = false; }); }
  if (first) mxSleep();
}
const decksBusy = () => MX.phase || MX.fading || MX.prep || MX.x || onDeck();
function mxSleep() {                                          // Web Audio off between blends, so the lock screen is the normal one
  if (MX.sleepTimer || !MX.ctx || MX.ctx.state !== 'running') return;
  MX.sleepTimer = setTimeout(() => { MX.sleepTimer = 0; if (MX.ctx.state === 'running' && !decksBusy()) MX.ctx.suspend().catch(() => {}); }, 1500);
}
function setGain(el, v) {
  const d = deckOf(el); if (!d?.gain || !MX.ctx) return;
  const g = d.gain.gain; g.cancelScheduledValues(0); g.setValueAtTime(v, MX.ctx.currentTime);
}
function clearEl(el) { el.pause(); el.playbackRate = 1; el.removeAttribute('src'); el.load(); }

// make `el` (in practice the main player) play the current song; any blend or hand-over stops
function useEl(el) {
  mxEndFade(); mxDropPrep(); mxDropX(); MX.phase = '';
  mainEl.muted = false; mainEl.playbackRate = 1; mainEl.loop = false;
  const old = audio; audio = el;
  if (old !== el) clearEl(old);
  for (const d of MX.decks) if (d.el !== el && d.el.getAttribute('src') && !d.el.src.startsWith('data:')) clearEl(d.el);
  setGain(el, 1); mxSleep();
}

// the phone stopped Web Audio while a song is on a deck (e.g. a phone call): carry on with the main player
function mxWatchCtx() {
  if (!MX.ctx || MX.ctx.state === 'running' || !onDeck() || audio.paused) return;
  MX.ctx.resume().catch(() => {});
  setTimeout(() => { if (MX.ctx.state !== 'running' && onDeck() && !audio.paused) mxRescue(); }, 600);
}
function mxRescue() {
  const pos = audio.currentTime, url = audio.src, old = audio;
  mxEndFade(); mxDropPrep(); mxDropX(); MX.phase = '';
  audio = mainEl; mainEl.muted = false; mainEl.playbackRate = 1; mainEl.src = url;
  mainEl.addEventListener('loadedmetadata', () => { mainEl.currentTime = pos; }, { once: true });
  mainEl.play().catch(() => {});
  clearEl(old);
}

// which song plays after this one (-1: none, or it repeats this one)
function mxNextIndex() {
  if (P.repeat === 'one') return -1;
  if (P.index < P.queue.length - 1) return P.index + 1;
  return P.repeat === 'all' && P.queue.length > 1 ? 0 : -1;
}
// where the blend starts in song a, how long it lasts, and where song b starts
function mxPlan(a, b, dur) {
  const L = mixLen(), ia = MX.info[keyOf(a)], ib = MX.info[keyOf(b)];
  const end = ia ? Math.min(ia.end, dur) : dur;                 // the last moment with sound
  const tail = ia ? Math.max(0, end - ia.fade) : 0;             // how long the ending fades out on its own
  const len = Math.max(1, Math.min(Math.max(L, Math.min(tail, L * 1.6)), end * 0.4));
  return { start: end - len, end, len, bAt: ib ? Math.max(0, ib.start - 0.05) : 0, bIn: len * (ib?.qi ? 0.45 : 0.75) };
}
// load the next song on deck Y, silent and waiting at its first sound
async function mxPrep(idx, t, plan) {
  const prep = { key: keyOf(t), idx, deck: null, url: null, ready: false }; MX.prep = prep;
  const url = await dlUrl(t);
  if (MX.prep !== prep || !url) { if (url) URL.revokeObjectURL(url); if (MX.prep === prep) MX.prep = null; return; }
  const d = MX.decks.find((x) => x.el !== audio && x.el !== MX.x?.el && x.el !== MX.fading?.el); if (!d) { URL.revokeObjectURL(url); MX.prep = null; return; }
  prep.deck = d.el; prep.url = url;
  setGain(d.el, 0);
  d.el.addEventListener('loadedmetadata', () => {
    if (MX.prep !== prep) return;
    if (plan.bAt > 0.05) { d.el.addEventListener('seeked', () => { if (MX.prep === prep) prep.ready = true; }, { once: true }); d.el.currentTime = plan.bAt; }
    else prep.ready = true;
  }, { once: true });
  d.el.src = url; d.el.load();
}
function mxDropPrep() {
  const p = MX.prep; if (!p) return; MX.prep = null;
  if (p.deck && p.deck !== audio) clearEl(p.deck);
  if (p.url) URL.revokeObjectURL(p.url);
}
// 'pre': the outgoing song on deck X, silent, started a little ahead and steered into step
function mxPreroll() {
  const d = MX.decks.find((x) => x.el !== MX.prep.deck); if (!d) return;
  const el = d.el, x = { el, since: Date.now() }; MX.x = x; MX.phase = 'pre';
  setGain(el, 0); el.playbackRate = 1;
  el.addEventListener('loadedmetadata', () => { if (MX.x !== x) return; el.currentTime = mainEl.currentTime + 0.12; el.play().catch(() => { if (MX.x === x) mxDropX(); }); }, { once: true });
  el.src = mainEl.src; el.load();
}
function mxDropX() {
  const x = MX.x; if (!x) return; MX.x = null; if (MX.phase === 'pre') MX.phase = '';
  if (x.el !== audio && x.el !== MX.fading?.el) clearEl(x.el);
}
// keep `f` at the same spot as `lead` by playing it slightly faster or slower; true once they're in step
function mxSteer(f, lead) {
  if (f.paused || f.readyState < 3 || f.seeking) return false;
  const d = f.currentTime - lead.currentTime;                   // > 0: the follower is ahead
  if (Math.abs(d) > 1) { f.playbackRate = 1; f.currentTime = lead.currentTime + 0.12; return false; }
  if (Math.abs(d) < 0.02) { f.playbackRate = 1; return true; }
  const k = Math.abs(d) > 0.1 ? 0.1 : 0.03;
  f.playbackRate = d > 0 ? 1 - k : 1 + k;
  return false;
}
const mxCurve = (rising) => { const n = 128, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = rising ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2); } return c; };
function mxStart(plan) {
  const prep = MX.prep, X = MX.x.el, B = prep.deck, now = MX.ctx.currentTime;
  const len = Math.max(1, Math.min(plan.len, plan.end - mainEl.currentTime)), inLen = Math.max(0.5, Math.min(plan.bIn, len));
  X.playbackRate = 1;
  const gx = deckOf(X).gain.gain, gb = deckOf(B).gain.gain;
  gx.cancelScheduledValues(0); gx.setValueCurveAtTime(mxCurve(false), now, len);      // X takes over at full volume, then fades;
  gb.cancelScheduledValues(0); gb.setValueCurveAtTime(mxCurve(true), now, inLen);     // on the audio clock, so slow timers don't matter
  B.play().catch(() => {});
  MX.fading = { el: X, url: DL.cur }; MX.prep = null; MX.x = null; MX.phase = 'blend';
  P.index = prep.idx;
  loadCurrent(true, 0, { deck: B, url: prep.url });             // `audio` is now B
  mainEl.pause();                                               // (its events no longer count: it isn't `audio`)
  MX.fadeTimer = setTimeout(mxEndFade, len * 1000 + 200);
}
// the song fading out is done (or you skipped, paused or seeked mid-blend): stop it, current song at full volume
function mxEndFade() {
  clearTimeout(MX.fadeTimer);
  const f = MX.fading; if (!f) return; MX.fading = null;
  if (MX.phase === 'blend') MX.phase = '';
  if (f.el !== audio) clearEl(f.el);
  setGain(f.el, 1);
  if (f.url && f.url !== DL.cur) URL.revokeObjectURL(f.url);
  setGain(audio, 1);
}
// 'back': the new song plays on deck Y; start it on the main player too, muted, steer it into step, swap
function mxBack() {
  const Y = audio;
  if (MX.phase !== 'back') {
    if (MX.fading || Y.paused || Y.seeking) return;
    MX.phase = 'back'; MX.backSince = Date.now();
    mainEl.muted = true; mainEl.playbackRate = 1; mainEl.loop = false;
    mainEl.addEventListener('loadedmetadata', () => { if (MX.phase !== 'back') return; mainEl.currentTime = Y.currentTime + 0.12; mainEl.play().catch(mxBackStop); }, { once: true });
    mainEl.src = Y.src;
    return;
  }
  if (Y.paused || !onDeck()) return mxBackStop();              // paused or something else took over: try again later
  const inStep = mxSteer(mainEl, Y);
  if (inStep || (Date.now() - MX.backSince > 8000 && !mainEl.paused)) {
    mainEl.playbackRate = 1;
    audio = mainEl; mainEl.muted = false; setGain(Y, 0); Y.pause();
    MX.phase = '';
    setTimeout(() => { if (Y !== audio) { clearEl(Y); setGain(Y, 1); } mxSleep(); }, 150);
  }
}
function mxBackStop() { if (MX.phase !== 'back') return; MX.phase = ''; mainEl.pause(); mainEl.muted = false; mainEl.playbackRate = 1; }

function mxTick() {
  if (!MX.ctx) return;
  if (!decksBusy()) mxSleep();                                  // nothing blending: keep Web Audio off
  if (!S.settings.seamless) return;
  if (onDeck()) { if (!MX.fading) mxBack(); return; }             // a blend just ended: hand the song back to the main player
  const A = audio;
  if (A !== mainEl || A.paused || A.seeking || AB.b != null || !DL.cur || A.src !== DL.cur) { mxDropX(); return; }
  const dur = A.duration; if (!dur || !isFinite(dur)) return;
  const idx = mxNextIndex(), a = P.queue[P.index], b = P.queue[idx];
  if (!a || !b || !DL.have.has(keyOf(b)) || keyOf(b) === keyOf(a)) { mxDropX(); mxDropPrep(); return; }   // next song not downloaded: a normal change
  if (MX.prep && (MX.prep.key !== keyOf(b) || MX.prep.idx !== idx)) { mxDropX(); mxDropPrep(); }        // the queue changed
  const plan = mxPlan(a, b, dur), t = A.currentTime;
  if (!MX.prep) { if (t >= plan.start - 30) { mxCtx(); mxAnalyze(b); mxPrep(idx, b, plan); } return; }
  if (t < plan.start - 6) return;
  if (MX.ctx.state !== 'running') { mxCtx(); return; }
  if (!MX.x) { if (MX.prep.ready && plan.end - t > 2) mxPreroll(); return; }
  mxSteer(MX.x.el, A);
  if (t >= plan.start && plan.end - t > 1.2 && !MX.x.el.paused && MX.x.el.readyState >= 3) mxStart(plan);
}
setInterval(mxTick, 200);
onAudio('timeupdate', mxTick);
onAudio('pause', () => { if (MX.fading) mxEndFade(); mxDropX(); });
onAudio('seeking', () => { if (MX.fading) mxEndFade(); mxDropX(); });

// ------------------------------------------------------------------ Smart mix
// Shuffle's third state. Each time a song starts, the remaining song that matches it best is moved to
// "next": close tempo (half / double time counts), a compatible key (Camelot wheel), similar energy,
// the same genre, and a related artist (but not the same artist twice in a row). Tempo, key and energy
// are measured on this device from downloaded songs (the blend scan, see above); songs that aren't
// downloaded are matched on genre and artist only, with the rest counted as average. Among picks that
// score almost the same, one is chosen at random, so the order isn't identical every time.
const NEXT_MODE = { off: 'shuffle', shuffle: 'smart', smart: 'off' };
const shuffleMode = () => (P.smart ? 'smart' : P.shuffle ? 'shuffle' : 'off');
const modeLabel = () => ({ off: 'Shuffle', shuffle: 'Shuffle is on (tap for Smart mix)', smart: 'Smart mix is on (tap to turn off)' })[shuffleMode()];
function syncShuffleUi() {
  const b = $('#p-shuffle'); b.classList.toggle('on', P.shuffle); b.querySelector('.smt').classList.toggle('hidden', !P.smart); b.setAttribute('aria-label', modeLabel());
  const pb = document.querySelector('[data-action="shufflePlay"]');
  if (pb) { pb.classList.toggle('on', P.shuffle); pb.style.color = P.shuffle ? 'var(--accent)' : ''; pb.setAttribute('aria-label', modeLabel()); pb.querySelector('.smt')?.remove(); if (P.smart) pb.insertAdjacentHTML('beforeend', '<span class="smt">✦</span>'); }
}
function toastMode() {
  if (!P.smart) return toast(P.shuffle ? 'Shuffle on' : 'Shuffle off');
  const n = P.queue.filter((t) => DL.have.has(keyOf(t)) && !((MX.info[keyOf(t)]?.v || 1) >= 2)).length;
  toast(`Smart mix on: next songs follow tempo, key, energy and style${n ? ` · measuring ${songs(n)} in the background` : ''}`);
}
function setMode(mode) {
  if (mode === 'off') { setShuffle(false); smartFacts(); return; }
  if (!P.shuffle) setShuffle(true);
  else if (mode === 'shuffle') { P.smart = false; shuffleRest(); }      // Smart mix -> Shuffle: a fresh random order
  P.smart = mode === 'smart';
  syncShuffleUi();
  if (P.smart) { smartScan(); smartPick(); }
  smartFacts(); renderQueue(); saveSession();
}

// --- how alike two songs are, 0..1
function bpmSim(a, b) {
  const d = Math.min(Math.abs(Math.log(b / a)), Math.abs(Math.log((2 * b) / a)) + 0.02, Math.abs(Math.log(b / (2 * a))) + 0.02);   // half/double time almost as good
  return Math.exp(-((d / 0.06) ** 2));                          // 3% apart: 0.78, 6%: 0.37, 10%: 0.06
}
function keySim(a, b) {
  const pa = /^(\d+)([AB])$/.exec(a), pb = /^(\d+)([AB])$/.exec(b); if (!pa || !pb) return 0.5;
  const d = Math.abs(+pa[1] - +pb[1]), dn = Math.min(d, 12 - d);
  if (pa[2] === pb[2]) return [1, 0.8, 0.4][dn] ?? 0.1;          // same key, next door on the wheel, two steps
  return dn === 0 ? 0.8 : dn === 1 ? 0.3 : 0.1;                  // relative major/minor
}
const related = (x, y) => !!(S.arel[x]?.includes(y) || S.arel[y]?.includes(x));
function smartScore(a, b) {
  const ia = MX.info[keyOf(a)], ib = MX.info[keyOf(b)], both = (ia?.v || 0) >= 2 && (ib?.v || 0) >= 2;
  const ga = genreOfSaved(a), gb = genreOfSaved(b), xa = akey(a.artist), xb = akey(b.artist);
  const parts = [                                               // [weight, similarity]; unknown counts as average (0.5)
    [0.35, both && ia.bpm && ib.bpm ? bpmSim(ia.bpm, ib.bpm) : 0.5],
    [0.2, both && ia.key && ib.key ? keySim(ia.key, ib.key) : 0.5],
    [0.15, both && ia.en != null && ib.en != null ? 1 - Math.min(1, Math.abs(ia.en - ib.en) / 0.4) : 0.5],
    [0.2, ga && gb ? (ga === gb ? 1 : 0) : 0.5],
    [0.1, xa && xb ? (xa === xb ? 0.2 : related(xa, xb) ? 1 : 0.3) : 0.5],
  ];
  return parts.reduce((s, [w, v]) => s + w * v, 0);
}
function smartPick() {
  if (!P.smart || P.index < 0) return;
  let at = P.index + 1; while (P.queue[at]?.q) at++;           // songs you queued by hand still play first
  const pool = P.queue.slice(at); if (pool.length < 2) { if (pool[0]) pool[0].sm = true; return; }
  const ref = P.queue[at - 1], prevArtist = akey(P.queue[at - 2]?.artist || '');
  const scored = pool.map((t, i) => ({ i, s: keyOf(t) === keyOf(ref) ? -1 : smartScore(ref, t) - (prevArtist && akey(t.artist) === prevArtist ? 0.05 : 0) }));   // (never the same song twice in a row)
  const best = Math.max(...scored.map((x) => x.s)), close = scored.filter((x) => x.s >= best - 0.03);
  const pick = close[Math.floor(Math.random() * close.length)];
  const [t] = P.queue.splice(at + pick.i, 1); t.sm = true;
  P.queue.splice(at, 0, t);
  SM.lastPick = { key: keyOf(t), score: Math.round(pick.s * 100) / 100 };
  renderQueue(); saveSession();
}
// new measurements or artist data arrived: pick again, if the picked song hasn't started and there's time
const SM = { repickTimer: 0, relRunning: false, lastPick: null };
function smartRepick() {
  clearTimeout(SM.repickTimer);
  SM.repickTimer = setTimeout(() => {
    if (!P.smart || P.index < 0) return;
    let at = P.index + 1; while (P.queue[at]?.q) at++;
    if (!P.queue[at]?.sm) return;
    const d = audio.duration, left = d && isFinite(d) ? d - audio.currentTime : 999;
    if (left > 40 && !MX.prep && !MX.phase) smartPick();          // (not while a blend is being prepared)
  }, 800);
}
function smartScanned(k) {
  if (!P.smart) return;
  if (P.queue[P.index] && keyOf(P.queue[P.index]) === k) smartFacts();
  smartRepick();
}
function smartScan() {                                          // measure the downloaded songs in the queue, current song first
  const cur = P.queue[P.index]; if (cur) mxAnalyze(cur, 2);
  for (const t of P.queue) mxAnalyze(t, 2);
  scanLibraryGenres().then(smartRepick).catch(() => {});
  smartRelations();
}
async function smartRelations() {                               // related artists for everyone in the queue (Deezer, cached)
  if (SM.relRunning) return; SM.relRunning = true;
  try {
    const todo = [...new Map(P.queue.map((t) => [akey(t.artist), firstArtist(t.artist)])).entries()].filter(([k]) => k && !S.arel[k]);
    for (const [k, name] of todo) {
      if (!P.smart) break;
      try { const r = await discApi('/api/discover/related', { artist: name }, 15000); S.arel[k] = (r.related || []).map(akey).filter(Boolean); }
      catch (e) { if (e.offline) break; S.arel[k] = []; }
      smartRepick(); await sleep(300);
    }
  } finally { SM.relRunning = false; persist(); }
}
function smartFacts() {                                         // "128 BPM · 8A" under the song while Smart mix is on
  const t = P.queue[P.index]; if (!t) return;
  const i = MX.info[keyOf(t)], facts = P.smart && (i?.v || 0) >= 2 && i.bpm ? ` · ${Math.round(i.bpm)} BPM · ${i.key}` : '';
  setVia((P.via || '') + facts);
}

// --- scanning a downloaded song (once; results kept in localStorage 'tristakfy.mix'):
// for blends, where the sound starts and ends and whether the ending fades out; for Smart mix, its tempo
// (BPM), musical key and energy. v2 = has the Smart mix measurements too.
function mxAnalyze(t, need = 1) {
  const k = keyOf(t);
  const have = MX.info[k] ? MX.info[k].v || 1 : 0;                // 0 = never scanned, 1 = blend data only, 2 = everything
  if (have >= need || MX.busy.has(k) || MX.failed.has(k) || !DL.have.has(k)) return;
  MX.busy.add(k);
  MX.work = MX.work.then(async () => {                        // one song at a time, to keep memory low on the phone
    try {
      const rec = await dlGetRec(k); if (!rec?.blob) return;
      let blob = rec.blob; try { blob = await mp4FixBlob(blob); } catch {}
      const data = await blob.arrayBuffer();
      const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      let oc; try { oc = new C(1, 1, 8000); } catch { oc = new C(1, 1, 22050); }    // a low rate is plenty, and small
      const buf = await new Promise((res, rej) => { const pr = oc.decodeAudioData(data, res, rej); if (pr?.catch) pr.catch(rej); });
      MX.info[k] = mxMeasure(buf); mxSaveInfo();
      if (typeof smartScanned === 'function') smartScanned(k);
    } catch { MX.failed.add(k); }                             // can't read it: blend with plain timings, mix by style only
    finally { MX.busy.delete(k); }
  });
}
// >>> scan (pure functions: no app state, so they can be tested on their own)
const MX_V = 2;
function mxMeasure(buf) {
  const sr = buf.sampleRate, win = Math.max(1, Math.round(sr * 0.1)), chs = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  const n = Math.floor(buf.length / win), db = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0; const o = w * win;
    for (const ch of chs) for (let i = o; i < o + win; i++) sum += ch[i] * ch[i];
    db[w] = 10 * Math.log10(sum / (win * chs.length) + 1e-12);           // loudness of each 0.1 s, in dB
  }
  const pct = (arr, q) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : -20; };
  const thr = Math.max(-60, pct(db, 0.95) - 35);                         // "sound" = within 35 dB of the loud parts
  let first = 0; while (first < n - 1 && db[first] < thr) first++;
  let last = n - 1; while (last > first && db[last] < thr) last--;
  const body = pct(db.subarray(first, last + 1), 0.5);                   // typical loudness of the song
  const sm = 20; let fade = last;                                        // the last moment the 2-second average is still near that
  for (let w = last; w >= first + sm; w--) { let sum = 0; for (let j = w - sm; j < w; j++) sum += db[j]; if (sum / sm >= body - 3) { fade = w; break; } }
  const m = Math.max(1, Math.min(30, last - first)); let intro = 0; for (let j = first; j < first + m; j++) intro += db[j]; intro /= m;
  const r1 = (x) => Math.round(x * 10) / 10;
  // one mono signal for the musical measurements
  const x = new Float32Array(buf.length);
  for (const ch of chs) for (let i = 0; i < x.length; i++) x[i] += ch[i] / chs.length;
  const from = Math.floor(first * win), to = Math.floor((last + 1) * win);
  const tempo = mxTempo(x, sr, from, to), key = mxKey(x, sr, from, to);
  // energy 0..1: half loudness (-18 dB quiet .. -8 dB loud), half beat strength (2 soft .. 8 hard); calibrated on real songs
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const en = 0.5 * clamp01((body + 18) / 10) + 0.5 * clamp01((tempo.punch - 2) / 6);
  return { start: r1(first * 0.1), end: r1((last + 1) * 0.1), fade: r1(fade * 0.1), qi: intro < body - 6 ? 1 : 0,
    bpm: tempo.bpm, key: key.camelot, kc: key.conf, en: Math.round(en * 100) / 100, db: r1(body), pu: Math.round(tempo.punch * 100) / 100, v: MX_V };
}
function mxFft(re, im) {        // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
// tempo: how strongly the sound "hits" over time (spectral flux), then which beat spacing repeats best
function mxTempo(x, sr, from, to) {
  const N = 256, hop = Math.max(1, Math.round(sr / 125)), fps = sr / hop;    // ~8 ms steps
  const start = Math.min(to, from + Math.floor((to - from) * 0.1)), end = Math.min(to, start + sr * 150);
  const frames = Math.max(0, Math.floor((end - start - N) / hop));
  if (frames < fps * 10) return { bpm: 0, punch: 0 };
  const w = new Float32Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(N / 2), flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = start + f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    mxFft(re, im);
    let sum = 0;
    for (let k = 1; k < N / 2; k++) { const m = Math.log(1 + 1000 * Math.hypot(re[k], im[k])); const d = m - prev[k]; if (d > 0) sum += d; prev[k] = m; }
    flux[f] = sum;
  }
  // keep only the hits: subtract a moving average (~0.4 s) and drop what's below it
  const avgW = Math.round(fps * 0.4), on = new Float32Array(frames); let run = 0, mean = 0;
  for (let f = 0; f < frames; f++) { run += flux[f]; if (f >= avgW) run -= flux[f - avgW]; const v = flux[f] - run / Math.min(f + 1, avgW); on[f] = v > 0 ? v : 0; mean += on[f]; }
  mean /= frames;
  // autocorrelation for 60..200 BPM, counting the next two beats too, gently preferring 90..140
  const ac = (lag) => { const L = Math.floor(lag), t = lag - L; let s = 0; for (let f = 0; f + L + 1 < frames; f++) s += on[f] * (on[f + L] * (1 - t) + on[f + L + 1] * t); return s / (frames - L); };
  let best = 0, bestBpm = 0;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = fps * 60 / bpm;
    const score = (ac(lag) + 0.5 * ac(2 * lag) + 0.25 * ac(4 * lag)) * Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.75) ** 2);
    if (score > best) { best = score; bestBpm = bpm; }
  }
  for (let bpm = bestBpm - 0.5; bpm <= bestBpm + 0.5; bpm += 0.1) {     // fine-tune
    const lag = fps * 60 / bpm, score = ac(lag) + 0.5 * ac(2 * lag) + 0.25 * ac(4 * lag);
    if (score > best) { best = score; bestBpm = bpm; }
  }
  return { bpm: Math.round(bestBpm * 10) / 10, punch: mean };
}
// key: how much of each of the 12 notes the song uses, compared with the major / minor key profiles
const KEY_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KEY_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function mxKey(x, sr, from, to) {
  // each note from C2 to C6 gets the strength at its own pitch plus its overtones (2x, 3x, ... the pitch),
  // so a note's 3rd overtone isn't mistaken for the note a fifth above (the classic key-finding error)
  const N = 4096, re = new Float32Array(N), im = new Float32Array(N), w = new Float32Array(N), mag = new Float32Array(N / 2), chroma = new Float64Array(12);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const notes = []; for (let midi = 36; midi <= 84; midi++) notes.push([midi % 12, 440 * 2 ** ((midi - 69) / 12)]);
  const at = (f) => { const k = f * N / sr; if (k >= N / 2 - 2) return 0; const i = Math.round(k); return Math.max(mag[i - 1] || 0, mag[i], mag[i + 1]); };
  const step = Math.max(N, Math.floor((to - from) / 400));               // at most ~400 slices per song
  for (let o = from; o + N <= to; o += step) {
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    mxFft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.sqrt(Math.hypot(re[k], im[k]));
    const frame = new Float64Array(12); let tot = 0;
    for (const [pc, f0] of notes) { let sal = 0, wt = 1; for (let h = 1; h <= 5; h++, wt *= 0.75) sal += wt * at(f0 * h); frame[pc] += sal; tot += sal; }
    if (tot > 0) for (let c = 0; c < 12; c++) chroma[c] += frame[c] / tot;
  }
  const corr = (prof, root) => {
    let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += chroma[(i + root) % 12]; my += prof[i]; } mx /= 12; my /= 12;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < 12; i++) { const a = chroma[(i + root) % 12] - mx, b = prof[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  let best = -2, second = -2, root = 0, minor = false;
  for (let r = 0; r < 12; r++) for (const [prof, mi] of [[KEY_MAJ, false], [KEY_MIN, true]]) {
    const c = corr(prof, r);
    if (c > best) { second = best; best = c; root = r; minor = mi; } else if (c > second) second = c;
  }
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const num = (((minor ? (root + 3) % 12 : root) * 7) % 12 + 7) % 12 + 1;   // Camelot wheel: C major = 8B, A minor = 8A
  return { camelot: `${num}${minor ? 'A' : 'B'}`, name: NAMES[root] + (minor ? 'm' : ''), conf: Math.round((best - second) * 1000) / 1000 };
}
// <<< scan


// ------------------------------------------------------------------ covers that always load
// Covers come through your own server (/api/art: fetched once, shrunk to size, cached forever). The app
// only shows a cover once it has fully loaded and decoded (so nothing is ever half-drawn), retries if a
// download fails, and shows a coloured placeholder until then (or if there truly is none).
const ART_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|sndcdn\.com|dzcdn\.net|deezer\.com)$/i;
const artReady = new Set();                              // addresses that have fully loaded before: shown instantly next time
function artCandidates(abs, size) {
  const out = [];
  try {
    const u = new URL(abs, location.href);
    if (/^https?:$/.test(u.protocol) && ART_HOST.test(u.hostname)) {
      for (const src of ['yt', 'sc']) { const p = apiUrl(src, '/api/art', { u: u.toString(), s: size }); if (!out.includes(p)) out.push(p); }
    }
  } catch {}
  out.push(abs);                                         // last resort: straight from the music service
  return out;
}
function paintArt(el, src, fade) {
  el.style.backgroundImage = `url("${src}")`; el.classList.remove('ph', 'art-failed');
  if (fade) { el.classList.remove('art-in'); void el.offsetWidth; el.classList.add('art-in'); }
}
function loadArt(el, want, tries, i, attempt) {
  const src = tries[i], img = new Image();
  img.onload = async () => {
    try { await img.decode(); } catch {}
    artReady.add(src);
    if (el.dataset.art === want) paintArt(el, src, true);
  };
  img.onerror = () => {
    if (el.dataset.art !== want) return;
    if (attempt < 2) setTimeout(() => loadArt(el, want, tries, i, attempt + 1), 500 * (attempt + 1));
    else if (i + 1 < tries.length) loadArt(el, want, tries, i + 1, 0);
    else { el.dataset.arted = ''; el._failAt = Date.now(); el.classList.add('art-failed'); }   // placeholder stays; tried again later
  };
  img.src = src;
}
function hydrateArt(el) {
  const abs = el.dataset.art; if (!abs || el.dataset.arted) return;
  el.dataset.arted = '1';
  const w = el.offsetWidth || 120, size = w <= 72 ? 128 : w <= 190 ? 320 : 720;
  const tries = artCandidates(abs, size), known = tries.find((s) => artReady.has(s));
  if (known) return paintArt(el, known, false);
  loadArt(el, abs, tries, 0, 0);
}
function setArt(el, abs) {                               // for the song bar and the big player cover
  el.dataset.art = abs || ''; delete el.dataset.arted;
  el.style.backgroundImage = ''; el.classList.add('ph'); el.classList.remove('art-in', 'art-failed');
  if (abs) hydrateArt(el);
}
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.dataset?.art) hydrateArt(n);
    n.querySelectorAll?.('[data-art]').forEach(hydrateArt);
  }
}).observe(document.body, { childList: true, subtree: true });
function sweepArt() { $$('[data-art]').forEach((el) => { if (!el.dataset.arted && el.dataset.art && Date.now() - (el._failAt || 0) > 12000) hydrateArt(el); }); }
setInterval(sweepArt, 15000);
addEventListener('online', sweepArt);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sweepArt(); });
$$('[data-art]').forEach(hydrateArt);

// ------------------------------------------------------------------ start
applyTheme(S.settings.theme);
applyStyle();
applyMini();
dlInit().then(dlGc).then(() => setTimeout(dlPump, 2500));
restoreSession();
TABS.forEach(renderPane);
checkHealth();
setInterval(checkHealth, 60000);
scheduleSync(800);
setInterval(syncNow, 120000);
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
