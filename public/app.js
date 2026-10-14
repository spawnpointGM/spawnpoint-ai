// SpawnpointAI front end: a small single-page app with no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
let META = { genres: [], builders: [], maxGameMb: 50, siteName: 'SpawnpointAI' };

// ---------- small utilities ----------

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};

function voterId() {
  let id = store.get('sp:voter', null);
  if (!id) { id = crypto.randomUUID(); store.set('sp:voter', id); }
  return id;
}

const myGames = {
  all() { return store.get('sp:mine', []); },
  find(slug) { return this.all().find((g) => g.slug === slug); },
  save(entry) { const list = this.all().filter((g) => g.slug !== entry.slug); list.unshift(entry); store.set('sp:mine', list); },
  remove(slug) { store.set('sp:mine', this.all().filter((g) => g.slug !== slug)); },
};

function keyHeaders(slug) {
  const h = {};
  const mine = myGames.find(slug);
  if (mine) h['x-edit-key'] = mine.editKey;
  const admin = store.get('sp:admin', null);
  if (admin) h['x-admin-key'] = admin;
  return h;
}

const STATUS_LABEL = { live: 'Live', pending: 'Waiting for review', rejected: 'Not approved', hidden: 'Hidden', draft: 'Upload not finished' };

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
}
const raw = (s) => ({ __raw: s });

async function api(path, { method = 'GET', body, headers = {}, raw: rawBody } = {}) {
  const opts = { method, headers: { ...headers } };
  if (rawBody !== undefined) opts.body = rawBody;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch('/api' + path, opts); }
  catch { throw new Error('Could not reach the server. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.gate) { showGate(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------- private testing password screen ----------

let gateShown = false;
function showGate(message = '') {
  if (gateShown && !message) return;
  gateShown = true;
  document.body.classList.add('gated');
  document.title = `${META.siteName} — private testing`;
  main.innerHTML = html`
    <div class="wrap gate">
      <form class="gate-card" id="gate">
        <h1>Private testing</h1>
        <p>SpawnpointAI isn't open to the public yet. Enter the password to look around.</p>
        <div class="field"><label for="gate-pw">Password</label><input id="gate-pw" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" type="submit">Enter</button>
        ${raw(message ? `<p class="error">${esc(message)}</p>` : '')}
      </form>
    </div>`;
  $('#gate').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await tryGate($('#gate-pw').value)) location.reload();
  });
  $('#gate-pw').focus();
}

async function tryGate(password) {
  try {
    const res = await fetch('/api/gate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (res.ok) return true;
    const data = await res.json().catch(() => ({}));
    showGate(data.error || 'That password is wrong.');
  } catch { showGate('Could not reach the server. Check your connection and try again.'); }
  return false;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function fmtCount(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }
function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function fmtDate(s) { const d = new Date(s.replace(' ', 'T') + 'Z'); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function likedText(up, down) { const t = up + down; return t ? `${Math.round((up / t) * 100)}% of ${t} ${t === 1 ? 'player' : 'players'} liked it` : 'No ratings yet. Play it and be the first.'; }
function rating(g) { const t = g.up + g.down; return t ? Math.round((g.up / t) * 100) : null; }

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3h4v11zM17 14l-4 8a3 3 0 0 1-3-3v-4H4a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.4 3H17"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 21V4h11l-1.5 4L16 12H5"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  thumb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21H7"/></svg>',
};

// Generated cover art for games without an image: two colours picked from the title.
const ART = [['#2B44E8', '#7A3CF0'], ['#0F8A7E', '#2B44E8'], ['#E8562B', '#F0AC00'], ['#C2307A', '#5B2BE8'], ['#14213D', '#2B44E8'], ['#1F9D63', '#0F5F8A'], ['#7A3CF0', '#E8562B'], ['#0E1124', '#C2307A']];
function genArt(title) {
  let h = 0; for (const ch of title) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const [a, b] = ART[h % ART.length];
  const initials = title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
  return `<div class="gen-art" style="background:linear-gradient(${135 + (h % 90)}deg, ${a}, ${b})" aria-hidden="true">${esc(initials)}</div>`;
}
function art(g) { return g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy">` : genArt(g.title); }

// ---------- router ----------

const routes = [
  [/^\/$/, viewHome],
  [/^\/game\/([^/]+)\/?$/, (m) => viewGame(decodeURIComponent(m[1]))],
  [/^\/publish\/?$/, viewPublish],
  [/^\/manage\/([^/]+)\/?$/, (m) => viewManage(decodeURIComponent(m[1]))],
  [/^\/mine\/?$/, viewMine],
  [/^\/admin\/?$/, viewAdmin],
];

let cleanup = null;
async function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  if (gateShown) return;
  const path = location.pathname;
  document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
  const nav = path === '/' ? 'home' : path.split('/')[1];
  document.querySelector(`[data-nav="${nav}"]`)?.setAttribute('aria-current', 'page');
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (m) { await view(m); return; }
  }
  document.title = `Page not found | ${META.siteName}`;
  main.innerHTML = html`<div class="wrap"><div class="empty" style="margin-top:40px"><h2>This page doesn't exist</h2><p>The link may be old or mistyped.</p><a class="btn btn-primary" href="/" data-link>Browse games</a></div></div>`;
}

function go(path, replace = false) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  window.scrollTo(0, 0);
  render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

// ---------- home ----------

async function viewHome() {
  document.title = `${META.siteName} — play and publish games made with AI`;
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', sort: params.get('sort') || 'trending', genre: params.get('genre') || '', mobile: params.get('mobile') === '1', offset: 0 };
  const sorts = [['trending', 'Trending'], ['new', 'New'], ['top', 'Top rated'], ['played', 'Most played']];

  main.innerHTML = html`
    <section class="hero wrap">
      <h1>Games made with AI, ready to play.</h1>
      <p>Find something new in seconds, or publish your own game and get real players trying it.</p>
      <form class="search" role="search">
        ${raw(ICON.search)}
        <label class="sr" for="q">Search games</label>
        <input id="q" type="search" placeholder="Search games, creators or tags" value="${state.q}" autocomplete="off">
      </form>
    </section>
    <section class="wrap" aria-label="Games">
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Sort games">
          ${raw(sorts.map(([k, l]) => `<button type="button" data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join(''))}
        </div>
        <label class="check" style="font-weight:600"><input type="checkbox" id="mobile" ${raw(state.mobile ? 'checked' : '')}> Works on phones</label>
      </div>
      <div class="chips" role="group" aria-label="Filter by genre">
        <button type="button" class="chip" data-genre="" aria-pressed="${!state.genre}">All</button>
        ${raw(META.genres.map((g) => `<button type="button" class="chip" data-genre="${esc(g)}" aria-pressed="${state.genre === g}">${esc(g)}</button>`).join(''))}
      </div>
      <div id="results" style="margin-top:18px"><p class="loading">Loading games…</p></div>
      <div class="more" id="more" hidden><button class="btn" type="button">Show more games</button></div>
    </section>`;

  const results = $('#results');
  const moreBox = $('#more');

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'trending') p.set('sort', state.sort);
    if (state.genre) p.set('genre', state.genre);
    if (state.mobile) p.set('mobile', '1');
    history.replaceState({}, '', '/' + (p.toString() ? '?' + p : ''));
  }

  async function load(append = false) {
    if (!append) state.offset = 0;
    const p = new URLSearchParams({ sort: state.sort, limit: '24', offset: String(state.offset) });
    if (state.q) p.set('q', state.q);
    if (state.genre) p.set('genre', state.genre);
    if (state.mobile) p.set('mobile', '1');
    try {
      const { games, more } = await api('/games?' + p);
      if (!append && !games.length) {
        const filtered = state.q || state.genre || state.mobile;
        results.innerHTML = filtered
          ? html`<div class="empty"><h2>No games match that</h2><p>Try a different search or clear the filters.</p><button class="btn" type="button" id="clear">Clear filters</button></div>`
          : html`<div class="empty"><h2>No games here yet</h2><p>Be the first to publish one. It takes a few minutes.</p><a class="btn btn-primary" href="/publish" data-link>Publish a game</a></div>`;
        $('#clear')?.addEventListener('click', () => { state.q = ''; state.genre = ''; state.mobile = false; viewHome.reset = true; history.replaceState({}, '', '/'); render(); });
      } else {
        const cards = games.map(card).join('');
        if (append) results.querySelector('.grid').insertAdjacentHTML('beforeend', cards);
        else results.innerHTML = `<div class="grid">${cards}</div>`;
      }
      state.offset += games.length;
      moreBox.hidden = !more;
    } catch (err) {
      results.innerHTML = html`<div class="empty"><h2>Games didn't load</h2><p>${err.message}</p><button class="btn" type="button" id="retry">Try again</button></div>`;
      $('#retry').addEventListener('click', () => load());
    }
  }

  let t;
  $('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); syncUrl(); load(); }, 250); });
  $('.search').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(t); state.q = $('#q').value.trim(); syncUrl(); load(); });
  main.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    main.querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    syncUrl(); load();
  }));
  main.querySelectorAll('[data-genre]').forEach((b) => b.addEventListener('click', () => {
    state.genre = b.dataset.genre;
    main.querySelectorAll('[data-genre]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    syncUrl(); load();
  }));
  $('#mobile').addEventListener('change', (e) => { state.mobile = e.target.checked; syncUrl(); load(); });
  moreBox.querySelector('button').addEventListener('click', () => load(true));
  await load();
}

function card(g) {
  const r = rating(g);
  return `<a class="cart" href="/game/${encodeURIComponent(g.slug)}" data-link>
    <div class="cart-in">
      <div class="cart-art">${art(g)}</div>
      <div class="cart-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="cart-body">
        <div class="cart-title">${esc(g.title)}</div>
        <div class="cart-by">by ${esc(g.creator)}</div>
        ${g.tagline ? `<p class="cart-pitch">${esc(g.tagline)}</p>` : ''}
        <div class="cart-meta">
          <span class="genre">${esc(g.genre)}</span>
          ${r !== null ? `<span title="${g.up} of ${g.up + g.down} players liked it">${ICON.thumb}${r}%</span>` : ''}
          <span title="${g.plays} plays">${ICON.people}${fmtCount(g.plays)}</span>
        </div>
      </div>
    </div>
  </a>`;
}

// ---------- game page ----------

async function viewGame(slug) {
  main.innerHTML = '<p class="loading">Loading game…</p>';
  let data;
  try { data = await api('/games/' + encodeURIComponent(slug), { headers: keyHeaders(slug) }); }
  catch (err) {
    main.innerHTML = html`<div class="wrap"><div class="empty" style="margin-top:40px"><h2>Game not found</h2><p>${err.message}</p><a class="btn btn-primary" href="/" data-link>Browse games</a></div></div>`;
    return;
  }
  const g = data.game;
  document.title = `${g.title} by ${g.creator} | ${META.siteName}`;
  const mine = myGames.find(g.slug);
  const myVote = store.get('sp:votes', {})[g.id] || 0;
  const aiParts = [g.ai.code && 'code', g.ai.art && 'art', g.ai.audio && 'audio', g.ai.text && 'writing'].filter(Boolean);
  const isLink = g.kind === 'link';
  const r = rating(g);
  const live = g.status === 'live';
  const adminView = g.review?.role === 'admin';
  let playUrl = g.playUrl || g.review?.previewUrl || null;

  main.innerHTML = html`
    ${raw(g.review ? `<div class="wrap">${reviewBanner(g, adminView)}</div>` : '')}
    <div class="wrap game-layout">
        <div class="stage-wrap">
          <div class="stage" id="stage">
            <div class="poster" id="poster">
              ${raw(art(g))}
              ${raw(playUrl ? `<button class="btn btn-play" id="play" type="button">${ICON.play} Play</button>` : '<p style="color:#fff;position:relative">This game has no playable build yet.</p>')}
              ${raw(g.controls ? `<p class="poster-note">${esc(g.controls)}</p>` : '')}
            </div>
          </div>
          <div class="stage-bar">
            <div class="left">
              <button class="btn btn-ghost" type="button" id="fs">${raw(ICON.full)} Fullscreen</button>
              <button class="btn btn-ghost" type="button" id="restart">${raw(ICON.restart)} Restart</button>
              ${raw(isLink ? `<a class="btn btn-ghost" href="${esc(g.externalUrl)}" target="_blank" rel="noopener">${ICON.ext} Open on its site</a>` : '')}
            </div>
            <div class="right">
              ${raw(live ? `<button class="btn btn-ghost" type="button" id="report">${ICON.flag} Report</button>` : '')}
            </div>
          </div>
        </div>
      <div class="about-col">
        ${raw(g.description ? html`<section class="about"><h2>About this game</h2><div class="text">${g.description}</div></section>` : '')}
        ${raw(data.versions.length > 1 || (data.versions[0] && data.versions[0].notes !== 'First release') ? `<section class="about"><h2>Updates</h2><ul class="updates">${data.versions.map((v) => `<li><span class="v">Version ${v.version}</span><span class="d">${fmtDate(v.created_at)}</span>${v.notes ? `<p>${esc(v.notes)}</p>` : ''}</li>`).join('')}</ul></section>` : '')}
      </div>
      <aside class="side">
        <h1>${g.title}</h1>
        <p class="by">by ${g.creator}</p>
        ${raw(g.tagline ? html`<p class="pitch">${g.tagline}</p>` : '')}
        ${raw(live ? html`<div class="votes">
          <button class="vote up" type="button" data-v="1" aria-pressed="${myVote === 1}" aria-label="I liked it">${raw(ICON.up)} <span>${g.up}</span></button>
          <button class="vote down" type="button" data-v="-1" aria-pressed="${myVote === -1}" aria-label="Not for me">${raw(ICON.down)} <span>${g.down}</span></button>
        </div>
        <p class="score" id="score">${likedText(g.up, g.down)}</p>` : '')}
        <dl class="facts">
          <dt>Genre</dt><dd>${g.genre}</dd>
          <dt>Plays</dt><dd>${fmtCount(g.plays)}</dd>
          <dt>Phones</dt><dd>${g.mobile ? 'Works on phones' : 'Best on a computer'}</dd>
          <dt>Built with</dt><dd>${g.builder}</dd>
          ${raw(isLink ? '<dt>Hosted</dt><dd>On the creator\'s site</dd>' : `<dt>Version</dt><dd>${g.version}</dd>`)}
          <dt>Published</dt><dd>${fmtDate(g.createdAt)}</dd>
        </dl>
        <div class="ai-box">
          <strong>AI disclosure</strong>
          ${aiParts.length ? `Made with AI-generated ${aiParts.join(', ')}.` : 'The creator says no AI-generated content is in this game.'}
          ${g.ai.live ? ' Uses AI while you play.' : ''}
        </div>
        ${raw(g.tags.length ? `<div class="tags">${g.tags.map((t) => `<a class="tag" href="/?q=${encodeURIComponent(t)}" data-link>${esc(t)}</a>`).join('')}</div>` : '')}
        ${raw(mine ? `<a class="btn manage" href="/manage/${encodeURIComponent(g.slug)}" data-link>Manage this game</a>` : '')}
      </aside>
    </div>
    <dialog id="report-dlg">
      <form method="dialog" id="report-form">
        <h2>Report this game</h2>
        <div class="checks">
          ${raw([['broken', "It doesn't work"], ['malicious', 'It tries to do something harmful'], ['inappropriate', 'Inappropriate content'], ['copyright', 'It copies someone else\'s work'], ['spam', 'Spam or a duplicate'], ['other', 'Something else']].map(([v, l], i) => `<label class="check"><input type="radio" name="reason" value="${v}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join(''))}
        </div>
        <div class="field"><label for="report-details">Details <span class="hint">(optional)</span></label><textarea id="report-details" maxlength="1000" style="min-height:80px"></textarea></div>
        <div class="actions" style="margin-top:8px">
          <button class="btn btn-primary" value="send">Send report</button>
          <button class="btn" value="cancel" formnovalidate>Cancel</button>
        </div>
      </form>
    </dialog>`;

  // --- player ---
  const stage = $('#stage');
  const saveKey = 'sp:save:' + g.id;
  let frame = null;

  function start() {
    if (!playUrl) return;
    frame?.remove();
    frame = document.createElement('iframe');
    frame.title = g.title;
    frame.allow = 'fullscreen; autoplay; gamepad; accelerometer; gyroscope';
    if (isLink) {
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-popups allow-downloads allow-orientation-lock');
    } else {
      frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-downloads allow-orientation-lock');
      // Saved data travels in via the frame's name; the game sends updates back with postMessage.
      frame.name = '__sp:' + JSON.stringify(store.get(saveKey, {}));
    }
    frame.src = playUrl;
    $('#poster')?.remove();
    stage.appendChild(frame);
    frame.focus();
    frame.addEventListener('load', () => frame.focus());
    const counted = sessionStorage.getItem('sp:played:' + g.id) || !live;
    if (!counted) { sessionStorage.setItem('sp:played:' + g.id, '1'); api(`/games/${encodeURIComponent(g.slug)}/play`, { method: 'POST' }).catch(() => {}); }
  }

  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (d && d.__sp === 'save' && d.game === g.id && d.data && typeof d.data === 'object') {
      const text = JSON.stringify(d.data);
      if (text.length < 1_000_000) { try { localStorage.setItem(saveKey, text); } catch {} }
    }
  }
  window.addEventListener('message', onMessage);
  cleanup = () => window.removeEventListener('message', onMessage);

  $('#play')?.addEventListener('click', start);
  $('#preview-pending')?.addEventListener('click', () => { playUrl = g.review.previewUrl; start(); toast('Playing the version waiting for review'); });
  main.querySelector('[data-approve]')?.addEventListener('click', async () => { if (await reviewAction(g.slug, 'approve')) render(); });
  main.querySelector('[data-reject]')?.addEventListener('click', async () => { if (await reviewAction(g.slug, 'reject')) render(); });
  $('#restart').addEventListener('click', () => { if (frame) start(); });
  $('#fs').addEventListener('click', async () => {
    if (!frame) start();
    try { await (stage.requestFullscreen?.() || stage.webkitRequestFullscreen?.()); frame?.focus(); }
    catch { toast('Fullscreen is not available on this device.'); }
  });

  // --- votes ---
  main.querySelectorAll('.vote').forEach((btn) => btn.addEventListener('click', async () => {
    const votes = store.get('sp:votes', {});
    const current = votes[g.id] || 0;
    const value = Number(btn.dataset.v) === current ? 0 : Number(btn.dataset.v);
    try {
      const res = await api(`/games/${encodeURIComponent(g.slug)}/vote`, { method: 'POST', body: { voter: voterId(), value } });
      votes[g.id] = value; store.set('sp:votes', votes);
      main.querySelector('.vote.up span').textContent = res.up;
      main.querySelector('.vote.down span').textContent = res.down;
      main.querySelector('.vote.up').setAttribute('aria-pressed', String(value === 1));
      main.querySelector('.vote.down').setAttribute('aria-pressed', String(value === -1));
      $('#score').textContent = likedText(res.up, res.down);
    } catch (err) { toast(err.message); }
  }));

  // --- report ---
  const dlg = $('#report-dlg');
  $('#report')?.addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'send') return;
    const reason = $('#report-form').reason.value;
    try {
      await api(`/games/${encodeURIComponent(g.slug)}/report`, { method: 'POST', body: { reason, details: $('#report-details').value } });
      toast('Report sent. Thanks for flagging it.');
    } catch (err) { toast(err.message); }
  });
}

// ---------- review status ----------

function reviewBanner(g, adminView) {
  const r = g.review;
  if (!r) return '';
  const waiting = [r.pendingVersion && (g.version ? `version ${r.pendingVersion}` : 'the game'), r.coverPending && 'a new cover', r.pendingUrl && 'a new link'].filter(Boolean);
  let title, text = '', tone = 'info';
  if (g.status === 'pending') {
    title = adminView ? 'New game waiting for your review' : 'Waiting for review';
    if (!adminView) text = "Only you can see this page until it's approved. Check its status anytime under My games.";
  } else if (g.status === 'rejected') {
    tone = 'bad'; title = 'Not approved';
    text = `${r.note} ${g.kind === 'link' ? 'Edit the game to send it for review again.' : 'Upload a new version from Manage to send it for review again.'}`;
  } else if (g.status === 'hidden') {
    tone = 'bad'; title = 'Hidden by the site owner'; text = "Players can't see this game right now.";
  } else if (waiting.length) {
    title = adminView ? `Update waiting for your review: ${waiting.join(', ')}` : 'Your update is waiting for review';
    if (!adminView) text = `Players see the approved version until ${waiting.join(' and ')} is approved.`;
  } else if (r.note && !adminView) {
    tone = 'bad'; title = 'Your last update was not approved'; text = r.note;
  } else return '';
  const flags = adminView ? (r.flags.length ? `<ul class="flags">${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p>Automatic checks found nothing.</p>') : '';
  const preview = g.status === 'live' && r.pendingVersion ? '<button class="btn btn-sm" type="button" id="preview-pending">Play the waiting version</button>' : '';
  const actions = adminView && (g.status === 'pending' || waiting.length)
    ? '<button class="btn btn-primary btn-sm" type="button" data-approve>Approve</button><button class="btn btn-sm btn-danger" type="button" data-reject>Reject</button>' : '';
  return `<div class="banner banner-${tone}"><div class="grow"><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}${flags}</div>${preview || actions ? `<div class="banner-actions">${preview}${actions}</div>` : ''}</div>`;
}

function askRejectReason() {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const reasons = ['Adult or sexual content', "It doesn't load or work", "It copies someone else's work", 'Spam or a duplicate', 'Other'];
    dlg.innerHTML = `<form method="dialog"><h2>Reject this submission</h2><p class="hint" style="margin-bottom:12px">The creator sees the reason on their game page.</p>
      <div class="checks">${reasons.map((r, i) => `<label class="check"><input type="radio" name="r" value="${esc(r)}" ${i === 0 ? 'checked' : ''}> ${esc(r)}</label>`).join('')}</div>
      <div class="field"><label for="rj-more">Note to the creator <span class="hint">(optional)</span></label><textarea id="rj-more" maxlength="400" style="min-height:70px"></textarea></div>
      <div class="actions" style="margin-top:8px"><button class="btn btn-danger" value="ok">Reject</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const reason = dlg.querySelector('input[name=r]:checked').value;
      const more = dlg.querySelector('#rj-more').value.trim();
      dlg.remove();
      resolve(ok ? `Not approved: ${reason}.${more ? ' ' + more : ''}` : null);
    });
    dlg.showModal();
  });
}

async function reviewAction(slug, action) {
  let body = {};
  if (action === 'reject') {
    const reason = await askRejectReason();
    if (reason === null) return false;
    body = { reason };
  }
  try {
    await api(`/admin/games/${encodeURIComponent(slug)}/${action}`, { method: 'POST', body, headers: { 'x-admin-key': store.get('sp:admin', '') } });
    toast(action === 'approve' ? 'Approved. Players can see it now.' : 'Rejected. The creator will see your reason.');
    return true;
  } catch (err) { toast(err.message); return false; }
}

// ---------- reading game files ----------

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.git)(\/|$)/i;

async function readGameFiles(fileList) {
  const files = [...fileList];
  if (!files.length) throw new Error('Choose a file first.');
  let out = {};
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    if (!window.fflate) throw new Error('The zip reader is still loading. Try again in a second.');
    let unzipped;
    try { unzipped = window.fflate.unzipSync(new Uint8Array(await files[0].arrayBuffer())); }
    catch { throw new Error("That zip file couldn't be opened. Re-create the zip and try again."); }
    for (const [path, data] of Object.entries(unzipped)) {
      if (path.endsWith('/') || JUNK.test(path)) continue;
      out[path] = data;
    }
  } else if (files.length === 1 && /\.html?$/i.test(files[0].name)) {
    out['index.html'] = new Uint8Array(await files[0].arrayBuffer());
  } else {
    // A folder or several files chosen at once.
    for (const f of files) {
      const path = (f.webkitRelativePath || f.name);
      if (JUNK.test(path)) continue;
      out[path] = new Uint8Array(await f.arrayBuffer());
    }
  }
  let paths = Object.keys(out);
  if (!paths.length) throw new Error('No files were found in that upload.');
  // If everything sits inside one folder, drop that folder from the paths.
  const first = paths[0].split('/')[0];
  if (paths.every((p) => p.includes('/') && p.split('/')[0] === first)) {
    const stripped = {};
    for (const p of paths) stripped[p.slice(first.length + 1)] = out[p];
    out = stripped; paths = Object.keys(out);
  }
  const htmlFiles = paths.filter((p) => /\.html?$/i.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  if (!htmlFiles.length) throw new Error('No .html file was found. Your game needs a start file such as index.html.');
  const entry = htmlFiles.find((p) => /^index\.html?$/i.test(p)) || htmlFiles[0];
  const size = paths.reduce((n, p) => n + out[p].byteLength, 0);
  if (size > META.maxGameMb * 1048576) throw new Error(`This game is ${fmtBytes(size)}. The limit is ${META.maxGameMb} MB.`);
  return { files: out, entry, htmlFiles, size, count: paths.length };
}

function fileSummary(info) {
  const options = info.htmlFiles.map((p) => `<option ${p === info.entry ? 'selected' : ''}>${esc(p)}</option>`).join('');
  return `<div class="file-sum"><span class="ok">Ready.</span> ${info.count} file${info.count === 1 ? '' : 's'}, ${fmtBytes(info.size)}.
    ${info.htmlFiles.length > 1 ? `<div class="field" style="margin-top:10px"><label for="entry">Start file</label><select id="entry">${options}</select></div>` : `Start file: <strong>${esc(info.entry)}</strong>`}</div>`;
}

async function uploadBuild(slug, editKey, version, info, entry, onProgress, onStage = () => {}) {
  const paths = Object.keys(info.files);
  let done = 0, i = 0;
  const total = paths.reduce((n, p) => n + info.files[p].byteLength, 0) || 1;
  let sent = 0;
  async function worker() {
    while (i < paths.length) {
      const path = paths[i++];
      const data = info.files[path];
      let attempt = 0;
      for (;;) {
        try {
          await api(`/games/${encodeURIComponent(slug)}/versions/${version}/files?path=${encodeURIComponent(path)}`, { method: 'PUT', raw: data, headers: { 'x-edit-key': editKey, 'content-type': 'application/octet-stream' } });
          break;
        } catch (err) {
          if (++attempt >= 3 || /limit|larger|over the|more than|can't be used|paused/i.test(err.message)) throw err;
          await new Promise((r) => setTimeout(r, 600 * attempt));
        }
      }
      sent += data.byteLength; done++;
      onProgress(sent / total, done, paths.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, paths.length) }, worker));
  // Automatic content check on the game's main images (the largest ones the checker can read).
  const images = paths.filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p) && info.files[p].byteLength <= 600 * 1024)
    .sort((a, b) => info.files[b].byteLength - info.files[a].byteLength).slice(0, 4);
  for (const [n, p] of images.entries()) {
    onStage(`Checking images: ${n + 1} of ${images.length}`);
    try {
      await api(`/games/${encodeURIComponent(slug)}/versions/${version}/scan?path=${encodeURIComponent(p)}`, { method: 'POST', headers: { 'x-edit-key': editKey } });
    } catch (err) { if (/adult content/i.test(err.message)) throw err; }
  }
  onStage('Submitting for review…');
  return api(`/games/${encodeURIComponent(slug)}/versions/${version}/publish`, { method: 'POST', body: { entry }, headers: { 'x-edit-key': editKey } });
}

function setupDrop(drop, input, onFiles) {
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); });
  input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); });
}

// ---------- shared form pieces ----------

function detailsFields(g = {}) {
  const ai = g.ai || {};
  return html`
    <div class="field"><label for="title">Game title</label><input id="title" type="text" maxlength="60" required value="${g.title || ''}"></div>
    <div class="row2">
      <div class="field"><label for="creator">Your name or studio</label><input id="creator" type="text" maxlength="40" required value="${g.creator || store.get('sp:creator', '')}"></div>
      <div class="field"><label for="genre">Genre</label><select id="genre">${raw(META.genres.map((x) => `<option ${x === (g.genre || 'Arcade') ? 'selected' : ''}>${esc(x)}</option>`).join(''))}</select></div>
    </div>
    <div class="field"><label for="tagline">One-line pitch <span class="hint">(shown on the game's card)</span></label><input id="tagline" type="text" maxlength="100" placeholder="A cozy puzzle game about rerouting rivers" value="${g.tagline || ''}"></div>
    <div class="field"><label for="description">Description</label><textarea id="description" maxlength="4000" placeholder="What is the game about, and what should players try first?">${g.description || ''}</textarea></div>
    <div class="row2">
      <div class="field"><label for="controls">Controls</label><input id="controls" type="text" maxlength="300" placeholder="Arrow keys to move, space to jump" value="${g.controls || ''}"></div>
      <div class="field"><label for="tags">Tags <span class="hint">(comma separated)</span></label><input id="tags" type="text" placeholder="cozy, short, pixel art" value="${(g.tags || []).join(', ')}"></div>
    </div>
    <label class="check"><input type="checkbox" id="mobile" ${raw(g.mobile ? 'checked' : '')}> It works on phones with touch controls</label>
    <div class="field" style="margin-top:18px"><label for="cover">Cover image <span class="hint">(optional, 16:9 looks best, under 3 MB)</span></label><input id="cover" type="file" accept="image/png,image/jpeg,image/webp,image/gif"><img id="cover-prev" class="cover-prev" alt="" hidden></div>
    <h3 style="font-size:1.1rem;margin:26px 0 6px">AI disclosure</h3>
    <p class="hint" style="margin-bottom:14px">Players can filter by this, so be accurate. It's shown on your game's page.</p>
    <div class="field"><label for="builder">Main AI tool used</label><select id="builder">${raw(META.builders.map((x) => `<option ${x === (g.builder || 'Claude') ? 'selected' : ''}>${esc(x)}</option>`).join(''))}</select></div>
    <p style="font-weight:600;margin-bottom:8px">Which parts did AI generate?</p>
    <div class="checks">
      <label class="check"><input type="checkbox" id="ai-code" ${raw(g.title ? (ai.code ? 'checked' : '') : 'checked')}> Code</label>
      <label class="check"><input type="checkbox" id="ai-art" ${raw(ai.art ? 'checked' : '')}> Art and graphics</label>
      <label class="check"><input type="checkbox" id="ai-audio" ${raw(ai.audio ? 'checked' : '')}> Music and sound</label>
      <label class="check"><input type="checkbox" id="ai-text" ${raw(ai.text ? 'checked' : '')}> Story, dialogue or text</label>
      <label class="check"><input type="checkbox" id="ai-live" ${raw(ai.live ? 'checked' : '')}> The game calls an AI model while people play</label>
    </div>`;
}

function readDetails() {
  return {
    title: $('#title').value, creator: $('#creator').value, genre: $('#genre').value, tagline: $('#tagline').value,
    description: $('#description').value, controls: $('#controls').value, tags: $('#tags').value, mobile: $('#mobile').checked,
    builder: $('#builder').value,
    ai: { code: $('#ai-code').checked, art: $('#ai-art').checked, audio: $('#ai-audio').checked, text: $('#ai-text').checked, live: $('#ai-live').checked },
  };
}

function setupCover() {
  const input = $('#cover');
  input.addEventListener('change', () => {
    const f = input.files[0];
    const prev = $('#cover-prev');
    if (!f) { prev.hidden = true; return; }
    if (f.size > 3 * 1048576) { toast('Keep the cover image under 3 MB.'); input.value = ''; prev.hidden = true; return; }
    prev.src = URL.createObjectURL(f); prev.hidden = false;
  });
  return () => input.files[0] || null;
}

// Shrinks the cover before upload: faster pages, and small enough for the automatic content check.
async function prepareCover(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

async function uploadCover(slug, editKey, file) {
  const img = await prepareCover(file);
  return api(`/games/${encodeURIComponent(slug)}/cover`, { method: 'PUT', raw: img, headers: { 'x-edit-key': editKey, 'content-type': img.type } });
}

// ---------- publish ----------

function viewPublish() {
  document.title = `Publish a game | ${META.siteName}`;
  main.innerHTML = html`
    <div class="wrap">
      <div class="page-head">
        <h1>Publish a game</h1>
        <p>Upload your game's files or link to where it's already hosted. Every game is reviewed before it appears on the site, usually within a day.</p>
      </div>
      <form class="form" id="pub" novalidate>
        <section class="step">
          <div class="step-head"><span class="step-num">1</span><div><h2>Your game</h2><p>Most AI tools can export a zip or a single HTML file.</p></div></div>
          <div class="choice" role="radiogroup" aria-label="How to add your game">
            <label><input type="radio" name="kind" value="hosted" checked><span><strong>Upload files</strong><span class="hint">We host it. Fastest for players.</span></span></label>
            <label><input type="radio" name="kind" value="link"><span><strong>Link to it</strong><span class="hint">It stays on Rosebud, itch, your site, etc.</span></span></label>
          </div>
          <div id="kind-hosted">
            <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose your game files">
              <strong>Drop a .zip or .html file here</strong>
              <span>or tap to choose one. Up to ${META.maxGameMb} MB.</span>
            </div>
            <input type="file" id="files" accept=".zip,.html,.htm" hidden>
            <div id="file-info"></div>
          </div>
          <div id="kind-link" hidden>
            <div class="field"><label for="ext-url">Game link</label><input id="ext-url" type="url" placeholder="https://" inputmode="url"></div>
            <p class="hint">Some sites block being shown inside other pages. If yours does, players get an "Open on its site" button instead.</p>
          </div>
        </section>
        <section class="step">
          <div class="step-head"><span class="step-num">2</span><div><h2>Details</h2><p>This is what players see before they press Play.</p></div></div>
          ${raw(detailsFields())}
        </section>
        <div class="actions">
          <button class="btn btn-primary" type="submit" id="submit">Submit for review</button>
          <span class="hint">By submitting you confirm you have the right to share this game. Adult content isn't allowed.</span>
        </div>
        <div id="status"></div>
      </form>
    </div>`;

  let info = null;
  const getCover = setupCover();
  const kindInputs = main.querySelectorAll('input[name=kind]');
  kindInputs.forEach((r) => r.addEventListener('change', () => {
    const link = $('input[name=kind]:checked').value === 'link';
    $('#kind-hosted').hidden = link; $('#kind-link').hidden = !link;
  }));
  setupDrop($('#drop'), $('#files'), async (fl) => {
    $('#file-info').innerHTML = '<p class="hint" style="margin-top:10px">Reading files…</p>';
    try {
      info = await readGameFiles(fl);
      $('#file-info').innerHTML = fileSummary(info);
      if (!$('#title').value) {
        const name = fl[0].name.replace(/\.(zip|html?)$/i, '').replace(/[-_]+/g, ' ').trim();
        if (name && name.toLowerCase() !== 'index') $('#title').value = name.replace(/\b\w/g, (c) => c.toUpperCase());
      }
    } catch (err) { info = null; $('#file-info').innerHTML = html`<p class="error">${err.message}</p>`; }
  });

  let created = null; // keeps the draft if an upload fails partway, so pressing Publish again resumes
  $('#pub').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#status');
    const btn = $('#submit');
    const kind = $('input[name=kind]:checked').value;
    const details = readDetails();
    const fail = (msg) => { status.innerHTML = html`<p class="error">${msg}</p>`; btn.disabled = false; };
    if (!details.title.trim()) return fail('Add a game title.');
    if (!details.creator.trim()) return fail('Add your name or studio.');
    if (kind === 'hosted' && !info) return fail('Choose your game files first.');
    if (kind === 'link' && !/^https:\/\/.+/.test($('#ext-url').value.trim())) return fail('Enter a full game link that starts with https://');
    btn.disabled = true;
    store.set('sp:creator', details.creator.trim());
    status.innerHTML = '<div class="progress"><div></div></div><p class="progress-label">Creating your game page…</p>';
    const bar = status.querySelector('.progress div');
    const label = status.querySelector('.progress-label');
    try {
      if (!created || created.kind !== kind) {
        const res = await api('/games', { method: 'POST', body: { ...details, kind, externalUrl: $('#ext-url').value.trim() } });
        created = { ...res, kind };
        myGames.save({ slug: res.slug, title: details.title.trim(), editKey: res.editKey, id: res.id });
      } else {
        await api('/games/' + encodeURIComponent(created.slug), { method: 'PATCH', body: details, headers: { 'x-edit-key': created.editKey } });
      }
      const cover = getCover();
      if (cover) { label.textContent = 'Uploading cover…'; await uploadCover(created.slug, created.editKey, cover); }
      let status = created.status;
      if (kind === 'hosted') {
        const entry = $('#entry')?.value || info.entry;
        const res = await uploadBuild(created.slug, created.editKey, created.version, info, entry, (frac, done, total) => {
          bar.style.width = Math.round(frac * 100) + '%';
          label.textContent = `Uploading files: ${done} of ${total}`;
        }, (text) => { label.textContent = text; });
        status = res.game.status;
      }
      bar.style.width = '100%';
      showPublished(created, details.title.trim(), status);
    } catch (err) {
      const adult = /adult content/i.test(err.message);
      fail(err.message + (created && !adult ? ' Your details are saved. Press Submit again to retry.' : ''));
    }
  });
}

function showPublished(created, title, status) {
  const url = `${location.origin}/game/${encodeURIComponent(created.slug)}`;
  const live = status === 'live';
  main.innerHTML = html`
    <div class="wrap">
      <div class="done">
        <h2>${live ? `${title} is live` : `${title} is submitted`}</h2>
        <p>${live ? 'Share this link to get people playing:' : "It's waiting for review, usually within a day. This link starts working for everyone once it's approved, and you can open it now to test your game:"}</p>
        <div class="keybox"><code id="game-url">${url}</code><button class="btn" type="button" data-copy="game-url">Copy</button></div>
        <h3 style="font-size:1.1rem;margin-top:22px">Your edit key</h3>
        <p class="hint">You need this to update or delete the game. It's saved on this device under My games, but copy it somewhere safe too. It can't be recovered.</p>
        <div class="keybox"><code id="edit-key">${created.editKey}</code><button class="btn" type="button" data-copy="edit-key">Copy</button></div>
        <div class="actions">
          <a class="btn btn-primary" href="/game/${encodeURIComponent(created.slug)}" data-link>${live ? 'Play your game' : 'Open your game page'}</a>
          <a class="btn" href="/manage/${encodeURIComponent(created.slug)}" data-link>Manage it</a>
        </div>
      </div>
    </div>`;
  bindCopy();
  window.scrollTo(0, 0);
}

function bindCopy() {
  main.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const text = document.getElementById(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Copy failed. Press and hold the text to copy it.'); }
  }));
}

// ---------- manage ----------

async function viewManage(slug) {
  document.title = `Manage game | ${META.siteName}`;
  main.innerHTML = '<p class="loading">Loading…</p>';
  const saved = myGames.find(slug);
  if (!saved) {
    main.innerHTML = html`
      <div class="wrap"><div class="page-head"><h1>Manage your game</h1><p>Enter the edit key you got when you published this game.</p></div>
      <form class="form step" id="keyform"><div class="field"><label for="key">Edit key</label><input id="key" type="text" autocomplete="off" required></div>
      <div class="actions" style="margin-top:0"><button class="btn btn-primary">Continue</button></div><div id="kerr"></div></form></div>`;
    $('#keyform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('#key').value.trim();
      try {
        const { game } = await api('/games/' + encodeURIComponent(slug), { method: 'PATCH', body: {}, headers: { 'x-edit-key': key } });
        myGames.save({ slug, title: game.title, editKey: key, id: game.id });
        render();
      } catch (err) { $('#kerr').innerHTML = html`<p class="error">${err.message}</p>`; }
    });
    return;
  }
  let g;
  try { g = (await api('/games/' + encodeURIComponent(slug), { headers: keyHeaders(slug) })).game; }
  catch (err) { main.innerHTML = html`<div class="wrap"><div class="empty" style="margin-top:40px"><h2>Game not found</h2><p>${err.message}</p></div></div>`; return; }
  const key = saved.editKey;
  const isLink = g.kind === 'link';
  main.innerHTML = html`
    <div class="wrap">
      <div class="page-head"><h1>Manage ${g.title}</h1><p class="head-meta"><span class="badge badge-${g.status}">${STATUS_LABEL[g.status] || g.status}</span><a href="/game/${encodeURIComponent(g.slug)}" data-link>View the game page</a></p></div>
      <div class="form">
        ${raw(reviewBanner(g, false))}
        <section class="step">
          <div class="step-head"><div><h2>${isLink ? 'Game link' : 'Upload a new version'}</h2><p>${isLink ? 'Change where the game is hosted. A new link is reviewed before players see it.' : `Each new version is reviewed before players see it. ${g.version ? `Players currently have version ${g.version}.` : ''}`}</p></div></div>
          ${raw(isLink
            ? html`<div class="field"><label for="ext-url">Game link</label><input id="ext-url" type="url" value="${g.externalUrl}"></div><button class="btn btn-primary" type="button" id="save-link">Save link</button>`
            : `<div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose new game files"><strong>Drop a .zip or .html file here</strong><span>or tap to choose one</span></div>
               <input type="file" id="files" accept=".zip,.html,.htm" hidden><div id="file-info"></div>
               <div class="field" style="margin-top:16px"><label for="notes">What changed? <span class="hint">(shown to players)</span></label><input id="notes" type="text" maxlength="500" placeholder="Fixed the jump, added level 3"></div>
               <button class="btn btn-primary" type="button" id="ship">Submit new version</button><div id="ship-status"></div>`)}
        </section>
        <section class="step">
          <div class="step-head"><div><h2>Details</h2></div></div>
          ${raw(detailsFields(g))}
          <div class="actions"><button class="btn btn-primary" type="button" id="save">Save details</button><span id="save-status"></span></div>
        </section>
        <section class="step">
          <div class="step-head"><div><h2>Edit key</h2><p>Keep a copy somewhere safe. Anyone with it can change this game.</p></div></div>
          <div class="keybox"><code id="edit-key">${key}</code><button class="btn" type="button" data-copy="edit-key">Copy</button></div>
        </section>
        <section class="step">
          <div class="step-head"><div><h2>Delete game</h2><p>Removes the game and its files for everyone. This can't be undone.</p></div></div>
          <button class="btn btn-danger" type="button" id="del">Delete ${g.title}</button>
        </section>
      </div>
    </div>`;
  bindCopy();
  $('#preview-pending')?.addEventListener('click', () => go('/game/' + encodeURIComponent(slug)));
  const getCover = setupCover();
  const headers = { 'x-edit-key': key };

  $('#save').addEventListener('click', async () => {
    const s = $('#save-status');
    s.className = 'hint'; s.textContent = 'Saving…';
    try {
      await api('/games/' + encodeURIComponent(slug), { method: 'PATCH', body: readDetails(), headers });
      const cover = getCover();
      const coverRes = cover ? await uploadCover(slug, key, cover) : null;
      myGames.save({ ...saved, title: $('#title').value.trim() });
      s.textContent = ''; toast(coverRes?.pending ? 'Saved. The new cover appears after review.' : 'Details saved');
    } catch (err) { s.className = 'error'; s.textContent = err.message; }
  });

  $('#save-link')?.addEventListener('click', async () => {
    try {
      const res = await api('/games/' + encodeURIComponent(slug), { method: 'PATCH', body: { externalUrl: $('#ext-url').value.trim() }, headers });
      toast(res.game.review?.pendingUrl || res.game.status === 'pending' ? 'Link sent for review' : 'Link saved');
      render();
    }
    catch (err) { toast(err.message); }
  });

  if (!isLink) {
    let info = null;
    setupDrop($('#drop'), $('#files'), async (fl) => {
      try { info = await readGameFiles(fl); $('#file-info').innerHTML = fileSummary(info); }
      catch (err) { info = null; $('#file-info').innerHTML = html`<p class="error">${err.message}</p>`; }
    });
    let pending = null;
    $('#ship').addEventListener('click', async () => {
      const st = $('#ship-status');
      if (!info) { st.innerHTML = '<p class="error">Choose the new game files first.</p>'; return; }
      const btn = $('#ship'); btn.disabled = true;
      st.innerHTML = '<div class="progress"><div></div></div><p class="progress-label">Starting upload…</p>';
      const bar = st.querySelector('.progress div'); const label = st.querySelector('.progress-label');
      try {
        if (!pending) pending = (await api(`/games/${encodeURIComponent(slug)}/versions`, { method: 'POST', body: { notes: $('#notes').value }, headers })).version;
        const entry = $('#entry')?.value || info.entry;
        const res = await uploadBuild(slug, key, pending, info, entry, (frac, done, total) => { bar.style.width = Math.round(frac * 100) + '%'; label.textContent = `Uploading files: ${done} of ${total}`; }, (text) => { label.textContent = text; });
        toast(res.approved ? `Version ${res.game.version} is live` : `Version ${pending} sent for review`);
        render();
      } catch (err) {
        const adult = /adult content/i.test(err.message);
        if (adult) pending = null;
        st.innerHTML = html`<p class="error">${err.message}${adult ? '' : ' Press Submit new version to retry.'}</p>`; btn.disabled = false;
      }
    });
  }

  $('#del').addEventListener('click', async () => {
    if (!confirm(`Delete ${g.title} for everyone? This can't be undone.`)) return;
    try {
      await api('/games/' + encodeURIComponent(slug), { method: 'DELETE', headers });
      myGames.remove(slug); toast('Game deleted'); go('/mine');
    } catch (err) { toast(err.message); }
  });
}

// ---------- my games ----------

function viewMine() {
  document.title = `My games | ${META.siteName}`;
  const list = myGames.all();
  main.innerHTML = html`
    <div class="wrap">
      <div class="page-head"><h1>My games</h1><p>Games you've published from this device. To manage a game from another device, open its manage page and enter its edit key.</p></div>
      ${raw(list.length
        ? `<div class="list">${list.map((g) => `<div class="list-item"><div class="thumb">${genArt(g.title)}</div><div class="grow"><h3>${esc(g.title)}</h3><p class="mine-status" data-slug="${esc(g.slug)}">Checking status…</p></div><a class="btn btn-sm" href="/game/${encodeURIComponent(g.slug)}" data-link>Open</a><a class="btn btn-sm" href="/manage/${encodeURIComponent(g.slug)}" data-link>Manage</a></div>`).join('')}</div>`
        : `<div class="empty" style="max-width:760px;margin-top:20px"><h2>You haven't published anything yet</h2><p>Upload a zip or an HTML file and your game gets its own page.</p><a class="btn btn-primary" href="/publish" data-link>Publish a game</a></div>`)}
    </div>`;
  main.querySelectorAll('.mine-status').forEach(async (el) => {
    const slug = el.dataset.slug;
    try {
      const { game } = await api('/games/' + encodeURIComponent(slug), { headers: keyHeaders(slug) });
      const waiting = game.review && (game.review.pendingVersion || game.review.coverPending || game.review.pendingUrl);
      el.innerHTML = `<span class="badge badge-${game.status}">${STATUS_LABEL[game.status] || game.status}</span>${game.status === 'live' && waiting ? ' <span class="badge badge-pending">Update waiting for review</span>' : ''}`;
    } catch { el.textContent = 'This game was removed.'; }
  });
}

// ---------- admin ----------

async function viewAdmin() {
  document.title = `Admin | ${META.siteName}`;
  const key = store.get('sp:admin', null);
  if (!key) {
    main.innerHTML = html`
      <div class="wrap"><div class="page-head"><h1>Admin</h1><p>Enter the ADMIN_KEY you set when you deployed the site. It's saved on this device only.</p></div>
      <form class="form step" id="adminform"><div class="field"><label for="akey">Admin key</label><input id="akey" type="password" autocomplete="current-password" required></div>
      <div class="actions" style="margin-top:0"><button class="btn btn-primary">Sign in</button></div><div id="aerr"></div></form></div>`;
    $('#adminform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const k = $('#akey').value.trim();
      try { await api('/admin/queue', { headers: { 'x-admin-key': k } }); store.set('sp:admin', k); render(); }
      catch (err) { $('#aerr').innerHTML = html`<p class="error">${err.message}</p>`; }
    });
    return;
  }
  main.innerHTML = '<p class="loading">Loading review queue…</p>';
  const headers = { 'x-admin-key': key };
  let queue, reports, usage;
  try {
    [queue, reports, usage] = await Promise.all([api('/admin/queue', { headers }), api('/admin/reports', { headers }), api('/admin/usage', { headers })]);
  } catch (err) {
    if (/admin key/i.test(err.message)) { store.set('sp:admin', null); return render(); }
    main.innerHTML = html`<div class="wrap"><div class="empty" style="margin-top:40px"><h2>Admin tools didn't load</h2><p>${err.message}</p></div></div>`;
    return;
  }
  const kindOf = (g) => {
    if (g.status === 'pending') return 'New game';
    const r = g.review;
    return [r.pendingVersion && `Update to version ${r.pendingVersion}`, r.coverPending && 'New cover', r.pendingUrl && 'New link'].filter(Boolean).join(', ');
  };
  const aiText = (g) => {
    const parts = [g.ai.code && 'code', g.ai.art && 'art', g.ai.audio && 'audio', g.ai.text && 'writing'].filter(Boolean);
    return (parts.length ? `AI-generated ${parts.join(', ')}.` : 'No AI content declared.') + (g.ai.live ? ' Uses AI while playing.' : '');
  };
  const reasonLabel = { broken: "Doesn't work", malicious: 'Harmful', inappropriate: 'Inappropriate', copyright: 'Copies someone else', spam: 'Spam or duplicate', other: 'Other' };
  main.innerHTML = html`
    <div class="wrap admin">
      <div class="page-head"><h1>Admin</h1><p>Approve games and updates before players see them, and handle reports.</p></div>
      <section class="admin-section">
        <h2>Review queue <span class="count">${queue.games.length}</span></h2>
        ${raw(queue.games.length ? queue.games.map((g) => `
          <article class="review-card" data-slug="${esc(g.slug)}">
            <div class="thumb">${g.review.pendingCover ? `<img src="${esc(g.review.pendingCover)}" alt="">` : art(g)}</div>
            <div class="grow">
              <span class="badge badge-pending">${esc(kindOf(g))}</span>
              <h3>${esc(g.title)}</h3>
              <p class="hint">by ${esc(g.creator)}, ${esc(g.genre)}${g.kind === 'link' ? ', linked game' : ''}</p>
              ${g.tagline ? `<p>${esc(g.tagline)}</p>` : ''}
              ${g.review.pendingUrl || (g.kind === 'link' && g.status === 'pending') ? `<p class="hint">Link: ${esc(g.review.pendingUrl || g.externalUrl)}</p>` : ''}
              <details><summary>Description and AI disclosure</summary>${g.description ? `<p class="desc">${esc(g.description)}</p>` : ''}<p>${esc(aiText(g))}</p></details>
              ${g.review.flags.length ? `<ul class="flags">${g.review.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="hint">Automatic checks found nothing.</p>'}
              <div class="actions">
                <a class="btn btn-sm" href="/game/${encodeURIComponent(g.slug)}" data-link>Preview</a>
                <button class="btn btn-primary btn-sm" type="button" data-act="approve">Approve</button>
                <button class="btn btn-sm btn-danger" type="button" data-act="reject">Reject</button>
              </div>
            </div>
          </article>`).join('') : '<div class="empty"><h2>Nothing to review</h2><p>New games and updates show up here.</p></div>')}
      </section>
      <section class="admin-section">
        <h2>Player reports <span class="count">${reports.reports.length}</span></h2>
        ${raw(reports.reports.length ? `<div class="list">${reports.reports.map((r) => `
          <div class="list-item" data-report="${r.id}" data-slug="${esc(r.slug)}">
            <div class="grow"><h3><a href="/game/${encodeURIComponent(r.slug)}" data-link>${esc(r.title)}</a></h3>
            <p>${esc(reasonLabel[r.reason] || r.reason)}${r.details ? `: ${esc(r.details)}` : ''}</p><p class="hint">${fmtDate(r.created_at)}${r.status === 'hidden' ? ', game is hidden' : ''}</p></div>
            ${r.status === 'live' ? '<button class="btn btn-sm btn-danger" type="button" data-hide>Hide game</button>' : ''}
            <button class="btn btn-sm" type="button" data-dismiss>Dismiss</button>
          </div>`).join('')}</div>` : '<p class="hint">No reports.</p>')}
      </section>
      <section class="admin-section">
        <h2>Storage</h2>
        <p>${usage.storageMB} MB of ${Math.round(usage.storageCapMB)} MB used. ${usage.writesThisMonth.toLocaleString()} of ${usage.writesCapPerMonth.toLocaleString()} uploads this month. Uploads pause at these limits so the site stays on the free tier.</p>
      </section>
      <p style="margin-top:28px"><button class="btn btn-sm" type="button" id="signout">Sign out of admin on this device</button></p>
    </div>`;
  main.querySelectorAll('.review-card [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const slug = b.closest('.review-card').dataset.slug;
    if (await reviewAction(slug, b.dataset.act)) render();
  }));
  main.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', async () => {
    const slug = b.closest('[data-slug]').dataset.slug;
    try { await api('/games/' + encodeURIComponent(slug), { method: 'PATCH', body: { status: 'hidden' }, headers }); toast('Game hidden'); render(); }
    catch (err) { toast(err.message); }
  }));
  main.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('[data-report]').dataset.report;
    try { await api('/admin/reports/' + id, { method: 'DELETE', headers }); render(); }
    catch (err) { toast(err.message); }
  }));
  $('#signout').addEventListener('click', () => { store.set('sp:admin', null); go('/'); });
}

// ---------- start ----------

(async function boot() {
  // Invite links (?invite=PASSWORD) sign testers in with one tap.
  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  if (invite) {
    params.delete('invite');
    history.replaceState({}, '', location.pathname + (params.toString() ? '?' + params : ''));
    await tryGate(invite);
    if (gateShown) return;
  }
  try { META = { ...META, ...(await api('/meta')) }; } catch {}
  render();
})();
