// SpawnpointAI: a store for AI-made browser games.
// One Cloudflare Worker serves the API, the game files (from R2) and the site (static assets).
// Every new game and update waits for the site owner's approval before players see it.

import { ADULT_MESSAGE, MAX_SCAN_BYTES, aiImageCheck, checkListing, keywordCheck, visibleText } from './moderation.js';

const GENRES = ['Action', 'Arcade', 'Puzzle', 'Platformer', 'Strategy', 'Simulation', 'Story', 'Racing', 'Sports', 'Shooter', 'Idle', 'Educational', 'Experimental'];
const BUILDERS = ['Claude', 'ChatGPT', 'Gemini / Google Playground', 'Rosebud AI', 'Cursor', 'GitHub Copilot', 'Replit', 'Bolt', 'Lovable', 'Websim', 'Other', 'None'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_COVER_BYTES = 3 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/play/')) return await servePlayFile(request, env, url);
      if (url.pathname.startsWith('/cover/')) return await serveCover(env, url);
      // Private testing mode: with SITE_PASSWORD set, the API and game pages need the password.
      // Game files (/play) and covers stay open because their URLs use random IDs that only the API reveals.
      if (url.pathname === '/api/gate' && request.method === 'POST') return await enterGate(request, env);
      if (!(await passedGate(request, env))) {
        if (url.pathname.startsWith('/api/')) return json({ error: 'This site is in private testing. Enter the password to continue.', gate: true }, 401);
        if (url.pathname.startsWith('/game/')) return env.ASSETS.fetch(new Request(new URL('/', url), { headers: { accept: 'text/html' } }));
      }
      await ensureSchema(env);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url, ctx);
      if (url.pathname.startsWith('/game/')) return await serveGamePage(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server. Try again in a moment.' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

// ---------- database ----------

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      creator TEXT NOT NULL,
      tagline TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT 'Arcade',
      tags TEXT NOT NULL DEFAULT '',
      controls TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'hosted',
      external_url TEXT,
      entry TEXT NOT NULL DEFAULT 'index.html',
      current_version INTEGER NOT NULL DEFAULT 0,
      ai_code INTEGER NOT NULL DEFAULT 0,
      ai_art INTEGER NOT NULL DEFAULT 0,
      ai_audio INTEGER NOT NULL DEFAULT 0,
      ai_text INTEGER NOT NULL DEFAULT 0,
      ai_live INTEGER NOT NULL DEFAULT 0,
      builder TEXT NOT NULL DEFAULT 'Other',
      mobile INTEGER NOT NULL DEFAULT 0,
      has_cover INTEGER NOT NULL DEFAULT 0,
      plays INTEGER NOT NULL DEFAULT 0,
      up INTEGER NOT NULL DEFAULT 0,
      down INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      edit_key_hash TEXT NOT NULL,
      ip_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS games_status_created ON games(status, created_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS versions (
      game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (game_id, version)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS votes (
      game_id TEXT NOT NULL,
      voter TEXT NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (game_id, voter)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`),
  ]);
  await addMissingColumns(env, 'games', {
    pending_version: 'INTEGER', pending_entry: 'TEXT', pending_url: 'TEXT', cover_pending: 'INTEGER NOT NULL DEFAULT 0',
    review_note: "TEXT NOT NULL DEFAULT ''", flags: "TEXT NOT NULL DEFAULT ''",
  });
  await addMissingColumns(env, 'versions', { review: "TEXT NOT NULL DEFAULT 'none'", flags: "TEXT NOT NULL DEFAULT ''", scans: 'INTEGER NOT NULL DEFAULT 0' });
  schemaReady = true;
}

async function addMissingColumns(env, table, columns) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const have = new Set(results.map((r) => r.name));
  const missing = Object.entries(columns).filter(([name]) => !have.has(name));
  if (missing.length) await env.DB.batch(missing.map(([name, type]) => env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)));
}

// ---------- private testing mode ----------

async function gateToken(env) { return sha256('gate:' + env.SITE_PASSWORD); }

async function passedGate(request, env) {
  if (!env.SITE_PASSWORD) return true;
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sp_gate=([a-f0-9]{64})/);
  return !!m && m[1] === (await gateToken(env));
}

async function enterGate(request, env) {
  if (!env.SITE_PASSWORD) return json({ ok: true });
  const body = await readJson(request);
  if (String(body.password || '') !== env.SITE_PASSWORD) {
    await new Promise((r) => setTimeout(r, 600)); // slows down guessing
    fail(401, 'That password is wrong.');
  }
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return json({ ok: true }, 200, { 'set-cookie': `sp_gate=${await gateToken(env)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}` });
}

// ---------- R2 free-tier guard ----------
// Cloudflare has no hard spending cap for R2, so the site keeps its own count of
// stored bytes and write operations and refuses uploads before the free tier runs out.
// Reads need no guard while on the Workers Free plan: every read goes through this
// Worker, which is capped at 100,000 requests a day (about 3M a month, under R2's 10M).

function monthKey() { return 'writes:' + new Date().toISOString().slice(0, 7); }

async function bumpUsage(env, key, delta) {
  const row = await env.DB.prepare(`INSERT INTO usage (key, value) VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = MAX(0, value + ?2) RETURNING value`).bind(key, delta).first();
  return row.value;
}

// Reserve room for one write of `bytes` to R2. Throws (and rolls back) if it would pass a cap.
async function reserveR2(env, bytes) {
  const maxBytes = Number(env.R2_MAX_GB || 9) * 1024 ** 3;
  const maxWrites = Number(env.R2_MAX_WRITES_PER_MONTH || 900000);
  const stored = await bumpUsage(env, 'storage_bytes', bytes);
  const writes = await bumpUsage(env, monthKey(), 1);
  if (stored > maxBytes || writes > maxWrites) {
    await bumpUsage(env, 'storage_bytes', -bytes);
    await bumpUsage(env, monthKey(), -1);
    fail(507, 'Uploads are paused because this site has reached its free storage limit. Try again later.');
  }
}

async function releaseR2(env, bytes) { if (bytes > 0) await bumpUsage(env, 'storage_bytes', -bytes); }

// ---------- helpers ----------

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 18) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function slugify(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'game';
}

function cleanText(value, max, field, required = false) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (required && !text) fail(400, `Add a ${field}.`);
  if (text.length > max) fail(400, `Keep the ${field} under ${max} characters.`);
  return text;
}

function cleanTags(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9 \-]/g, '').trim().slice(0, 24))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 8).join(',');
}

function bool(v) { return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0; }

function cleanPath(raw) {
  let path;
  try { path = decodeURIComponent(raw); } catch { fail(400, 'That file path is not valid.'); }
  path = path.replace(/^\/+/, '');
  if (!path || path.length > 300 || path.includes('\\') || path.includes('\0') || path.split('/').some((p) => p === '..' || p === '.')) {
    fail(400, `This file path can't be used: ${path || '(empty)'}`);
  }
  return path;
}

async function clientHash(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return sha256('ip:' + ip);
}

async function readJson(request) {
  try { return await request.json(); } catch { fail(400, 'The request body must be JSON.'); }
}

async function loadGame(env, slug) {
  const game = await env.DB.prepare(`SELECT * FROM games WHERE slug = ? AND status != 'deleted'`).bind(slug).first();
  if (!game) fail(404, 'No game with that link exists. It may have been removed.');
  return game;
}

function isAdmin(request, env) {
  const key = request.headers.get('x-admin-key');
  return !!(key && env.ADMIN_KEY && key === env.ADMIN_KEY);
}
function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) fail(403, 'Set an ADMIN_KEY for this site in Cloudflare to use the admin tools.');
  if (!isAdmin(request, env)) fail(403, 'That admin key is wrong.');
}
// 'admin', 'owner' or null for the person making this request.
async function viewerRole(request, env, game) {
  if (isAdmin(request, env)) return 'admin';
  const key = request.headers.get('x-edit-key');
  if (key && (await sha256(key)) === game.edit_key_hash) return 'owner';
  return null;
}
function splitFlags(text) { return text ? text.split('\n').filter(Boolean) : []; }
function joinFlags(...lists) { return [...new Set(lists.flat().filter(Boolean))].join('\n').slice(0, 2000); }

async function requireEditor(request, env, game) {
  const admin = request.headers.get('x-admin-key');
  if (admin && env.ADMIN_KEY && admin === env.ADMIN_KEY) return true;
  const key = request.headers.get('x-edit-key');
  if (!key || (await sha256(key)) !== game.edit_key_hash) fail(403, 'The edit key is missing or wrong. Use the key you saved when you published.');
  return true;
}

function publicGame(g) {
  return {
    slug: g.slug,
    id: g.id,
    title: g.title,
    creator: g.creator,
    tagline: g.tagline,
    description: g.description,
    genre: g.genre,
    tags: g.tags ? g.tags.split(',') : [],
    controls: g.controls,
    kind: g.kind,
    externalUrl: g.kind === 'link' ? g.external_url : null,
    playUrl: g.kind === 'link' ? g.external_url : (g.current_version ? `/play/${g.id}/${g.current_version}/${encodePath(g.entry)}` : null),
    version: g.current_version,
    ai: { code: !!g.ai_code, art: !!g.ai_art, audio: !!g.ai_audio, text: !!g.ai_text, live: !!g.ai_live },
    builder: g.builder,
    mobile: !!g.mobile,
    cover: g.has_cover ? `/cover/${g.id}?v=${encodeURIComponent(g.updated_at)}` : null,
    plays: g.plays,
    up: g.up,
    down: g.down,
    status: g.status,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

// Extra review details shown only to the game's creator and the site owner.
function reviewInfo(g, role) {
  const pendingVersion = g.pending_version || null;
  return {
    role,
    note: g.review_note || '',
    pendingVersion,
    previewUrl: pendingVersion ? `/play/${g.id}/${pendingVersion}/${encodePath(g.pending_entry || 'index.html')}` : (g.kind === 'link' ? (g.pending_url || g.external_url) : null),
    coverPending: !!g.cover_pending,
    pendingCover: g.cover_pending ? `/cover/${g.id}?pending=1&v=${encodeURIComponent(g.updated_at)}` : null,
    pendingUrl: g.pending_url || null,
    flags: role === 'admin' ? splitFlags(g.flags) : [],
  };
}
function gameFor(g, role) {
  const out = publicGame(g);
  if (role) out.review = reviewInfo(g, role);
  return out;
}

function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }

// ---------- API ----------

async function handleApi(request, env, url, ctx) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const method = request.method;

  if (parts[0] === 'meta' && method === 'GET') {
    return json({ genres: GENRES, builders: BUILDERS, maxGameMb: Number(env.MAX_GAME_MB || 50), siteName: env.SITE_NAME || 'SpawnpointAI' });
  }

  if (parts[0] === 'games' && parts.length === 1) {
    if (method === 'GET') return listGames(env, url);
    if (method === 'POST') return createGame(request, env);
  }

  if (parts[0] === 'games' && parts[1]) {
    const slug = parts[1];
    const sub = parts[2];
    if (!sub) {
      if (method === 'GET') return getGame(request, env, slug);
      if (method === 'PATCH') return updateGame(request, env, slug);
      if (method === 'DELETE') return deleteGame(request, env, slug, ctx);
    }
    if (sub === 'versions' && method === 'POST' && !parts[3]) return createVersion(request, env, slug);
    if (sub === 'versions' && parts[3] && parts[4] === 'files' && method === 'PUT') return uploadFile(request, env, slug, parts[3], url);
    if (sub === 'versions' && parts[3] && parts[4] === 'publish' && method === 'POST') return publishVersion(request, env, slug, parts[3], ctx);
    if (sub === 'versions' && parts[3] && parts[4] === 'scan' && method === 'POST') return scanImage(request, env, slug, parts[3], url);
    if (sub === 'cover' && method === 'PUT') return uploadCover(request, env, slug);
    if (sub === 'play' && method === 'POST') return recordPlay(env, slug);
    if (sub === 'vote' && method === 'POST') return vote(request, env, slug);
    if (sub === 'report' && method === 'POST') return report(request, env, slug);
  }

  if (parts[0] === 'admin') {
    requireAdmin(request, env);
    if (parts[1] === 'queue' && method === 'GET') return reviewQueue(env);
    if (parts[1] === 'games' && parts[2] && parts[3] === 'approve' && method === 'POST') return approveGame(env, parts[2], ctx);
    if (parts[1] === 'games' && parts[2] && parts[3] === 'reject' && method === 'POST') return rejectGame(request, env, parts[2], ctx);
    if (parts[1] === 'reports' && parts[2] && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(parseInt(parts[2], 10)).run();
      return json({ ok: true });
    }
  }

  if (parts[0] === 'admin' && parts[1] === 'usage' && method === 'GET') {
    const stored = await env.DB.prepare(`SELECT value FROM usage WHERE key = 'storage_bytes'`).first();
    const writes = await env.DB.prepare(`SELECT value FROM usage WHERE key = ?`).bind(monthKey()).first();
    return json({
      storageMB: +((stored?.value || 0) / 1024 ** 2).toFixed(2), storageCapMB: Number(env.R2_MAX_GB || 9) * 1024,
      writesThisMonth: writes?.value || 0, writesCapPerMonth: Number(env.R2_MAX_WRITES_PER_MONTH || 900000),
    });
  }

  if (parts[0] === 'admin' && parts[1] === 'reports' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT r.*, g.slug, g.title, g.status FROM reports r JOIN games g ON g.id = r.game_id WHERE g.status != 'deleted' ORDER BY r.id DESC LIMIT 200`).all();
    return json({ reports: results });
  }

  fail(404, 'Unknown API route.');
}

async function listGames(env, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const genre = url.searchParams.get('genre') || '';
  const sort = url.searchParams.get('sort') || 'trending';
  const mobile = url.searchParams.get('mobile') === '1';
  const noAiArt = url.searchParams.get('noaiart') === '1';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '24', 10) || 24, 1), 60);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

  const where = [`status = 'live'`];
  const binds = [];
  if (q) {
    where.push(`(title LIKE ?1 OR tagline LIKE ?1 OR description LIKE ?1 OR tags LIKE ?1 OR creator LIKE ?1)`);
    binds.push(`%${q.replace(/[%_]/g, '')}%`);
  }
  if (genre && GENRES.includes(genre)) { where.push(`genre = ?${binds.length + 1}`); binds.push(genre); }
  if (mobile) where.push('mobile = 1');
  if (noAiArt) where.push('ai_art = 0');

  const order = {
    new: 'created_at DESC',
    top: '(up + 1.0) / (up + down + 2.0) DESC, up DESC',
    played: 'plays DESC',
    // Recent activity counts more than old totals.
    trending: `((up * 3.0) - (down * 2.0) + plays + 5) / ((julianday('now') - julianday(created_at)) * 24.0 + 12.0) DESC`,
  }[sort] || 'created_at DESC';

  const sql = `SELECT * FROM games WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const more = results.length > limit;
  return json({ games: results.slice(0, limit).map(publicGame), more }, 200, { 'cache-control': 'public, max-age=15' });
}

async function getGame(request, env, slug) {
  const game = await loadGame(env, slug);
  const role = await viewerRole(request, env, game);
  if (game.status !== 'live' && !role) fail(404, 'No game with that link exists. It may have been removed or still be waiting for review.');
  const { results: versions } = await env.DB.prepare(`SELECT version, notes, size_bytes, file_count, created_at FROM versions
      WHERE game_id = ? AND published = 1 AND review IN ('approved', 'none') ORDER BY version DESC LIMIT 20`).bind(game.id).all();
  return json({ game: gameFor(game, role), versions });
}

function readMeta(body, partial = false) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('title')) out.title = cleanText(body.title, 60, 'title', true);
  if (has('creator')) out.creator = cleanText(body.creator, 40, 'creator name', true);
  if (has('tagline')) out.tagline = cleanText(body.tagline, 100, 'one-line pitch');
  if (has('description')) out.description = cleanText(body.description, 4000, 'description');
  if (has('controls')) out.controls = cleanText(body.controls, 300, 'controls note');
  if (has('genre')) { out.genre = GENRES.includes(body.genre) ? body.genre : fail(400, 'Pick a genre from the list.'); }
  if (has('tags')) out.tags = cleanTags(body.tags);
  if (has('builder')) out.builder = BUILDERS.includes(body.builder) ? body.builder : 'Other';
  if (has('mobile')) out.mobile = bool(body.mobile);
  const ai = body.ai || {};
  if (!partial || body.ai) {
    out.ai_code = bool(ai.code); out.ai_art = bool(ai.art); out.ai_audio = bool(ai.audio);
    out.ai_text = bool(ai.text); out.ai_live = bool(ai.live);
  }
  return out;
}

async function createGame(request, env) {
  const body = await readJson(request);
  const meta = readMeta(body);
  const kind = body.kind === 'link' ? 'link' : 'hosted';
  let externalUrl = null;
  if (kind === 'link') {
    try {
      const u = new URL(String(body.externalUrl || ''));
      if (u.protocol !== 'https:') throw new Error();
      externalUrl = u.toString();
    } catch { fail(400, 'Enter a full game link that starts with https://'); }
  }

  const notes = await checkListing(env, listingFields(meta), fail);

  const ipHash = await clientHash(request);
  const perDay = Number(env.NEW_GAMES_PER_DAY || 10);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM games WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')`).bind(ipHash).first();
  if (recent.n >= perDay) fail(429, `You can publish up to ${perDay} new games a day. Try again tomorrow, or upload a new version of an existing game.`);

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const editKey = randomToken();
  let slug = slugify(meta.title);
  const taken = await env.DB.prepare('SELECT 1 FROM games WHERE slug = ?').bind(slug).first();
  if (taken) slug = `${slug}-${id.slice(0, 5)}`;

  // Linked games go straight to review; uploaded games wait until their files are in.
  const status = kind === 'link' ? (isAdmin(request, env) ? 'live' : 'pending') : 'draft';
  await env.DB.prepare(`INSERT INTO games (id, slug, title, creator, tagline, description, genre, tags, controls, kind, external_url,
      ai_code, ai_art, ai_audio, ai_text, ai_live, builder, mobile, status, edit_key_hash, ip_hash, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, slug, meta.title, meta.creator, meta.tagline, meta.description, meta.genre, meta.tags, meta.controls, kind, externalUrl,
      meta.ai_code, meta.ai_art, meta.ai_audio, meta.ai_text, meta.ai_live, meta.builder, meta.mobile,
      status, await sha256(editKey), ipHash, joinFlags(notes))
    .run();

  let version = null;
  if (kind === 'hosted') {
    version = 1;
    await env.DB.prepare('INSERT INTO versions (game_id, version, notes) VALUES (?, 1, ?)').bind(id, 'First release').run();
  }
  return json({ slug, id, editKey, version, status }, 201);
}

function listingFields(m) {
  return { title: m.title, creator: m.creator, pitch: m.tagline, description: m.description, tags: m.tags, controls: m.controls };
}

async function updateGame(request, env, slug) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const body = await readJson(request);
  const meta = readMeta(body, true);
  const admin = isAdmin(request, env);
  const textChanged = ['title', 'creator', 'tagline', 'description', 'tags', 'controls'].some((k) => meta[k] !== undefined && meta[k] !== game[k]);
  if (textChanged && !admin) {
    const notes = await checkListing(env, listingFields({ ...game, ...meta }), fail);
    meta.flags = joinFlags(splitFlags(game.flags), notes);
  }
  if (body.externalUrl !== undefined && game.kind === 'link') {
    let next;
    try {
      const u = new URL(String(body.externalUrl));
      if (u.protocol !== 'https:') throw new Error();
      next = u.toString();
    } catch { fail(400, 'Enter a full game link that starts with https://'); }
    if (next !== game.external_url) {
      if (admin || game.status !== 'live') { meta.external_url = next; if (!admin && game.status === 'rejected') meta.status = 'pending'; }
      else meta.pending_url = next; // a live game keeps its approved link until the new one is reviewed
    }
  }
  // Editing a rejected link game sends it back for review.
  if (!admin && game.kind === 'link' && game.status === 'rejected' && Object.keys(meta).length) { meta.status = 'pending'; meta.review_note = ''; }
  if (admin && ['live', 'hidden'].includes(body.status)) meta.status = body.status;
  const keys = Object.keys(meta);
  if (!keys.length) return json({ game: gameFor(game, admin ? 'admin' : 'owner') });
  await env.DB.prepare(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map((k) => meta[k]), game.id).run();
  return json({ game: gameFor(await loadGame(env, slug), admin ? 'admin' : 'owner') });
}

async function createVersion(request, env, slug) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  if (game.kind !== 'hosted') fail(400, 'Linked games are updated by changing the link.');
  const body = await readJson(request).catch(() => ({}));
  const row = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE game_id = ?').bind(game.id).first();
  const version = row.v + 1;
  await env.DB.prepare('INSERT INTO versions (game_id, version, notes) VALUES (?, ?, ?)')
    .bind(game.id, version, cleanText(body.notes, 500, 'update notes')).run();
  return json({ version }, 201);
}

async function uploadFile(request, env, slug, versionRaw, url) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const version = parseInt(versionRaw, 10);
  const ver = await env.DB.prepare('SELECT * FROM versions WHERE game_id = ? AND version = ?').bind(game.id, version).first();
  if (!ver) fail(404, 'That version does not exist.');
  if (ver.published) fail(409, 'This version is already published. Start a new version to change files.');
  const path = cleanPath(url.searchParams.get('path') || '');
  const data = await request.arrayBuffer();
  if (data.byteLength > MAX_FILE_BYTES) fail(413, `${path} is larger than 25 MB.`);

  const maxBytes = Number(env.MAX_GAME_MB || 50) * 1024 * 1024;
  const maxFiles = Number(env.MAX_FILES || 1000);
  const totals = await env.DB.prepare(`UPDATE versions SET size_bytes = size_bytes + ?, file_count = file_count + 1
      WHERE game_id = ? AND version = ? RETURNING size_bytes, file_count`).bind(data.byteLength, game.id, version).first();
  if (totals.size_bytes > maxBytes) fail(413, `This game is over the ${env.MAX_GAME_MB || 50} MB limit. Compress images or audio and try again.`);
  if (totals.file_count > maxFiles) fail(413, `This game has more than ${maxFiles} files. Remove files the game doesn't use.`);

  await reserveR2(env, data.byteLength);
  await env.FILES.put(`games/${game.id}/v${version}/${path}`, data, { httpMetadata: { contentType: contentTypeFor(path) } });
  return json({ ok: true, path });
}

async function publishVersion(request, env, slug, versionRaw, ctx) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const admin = isAdmin(request, env);
  const version = parseInt(versionRaw, 10);
  const ver = await env.DB.prepare('SELECT * FROM versions WHERE game_id = ? AND version = ?').bind(game.id, version).first();
  if (!ver) fail(404, 'That version does not exist.');
  if (ver.published) fail(409, 'This version was already submitted.');
  const body = await readJson(request).catch(() => ({}));
  const entry = cleanPath(body.entry || 'index.html');
  if (!/\.html?$/i.test(entry)) fail(400, 'The start file must be an .html file.');
  const head = await env.FILES.head(`games/${game.id}/v${version}/${entry}`);
  if (!head) fail(400, `The start file ${entry} wasn't uploaded. Make sure your game includes it.`);

  // Automatic checks: words in the game's pages, plus any images the uploader scanned.
  const notes = splitFlags(ver.flags);
  let explicit = notes.some((n) => n.startsWith('EXPLICIT'));
  if (!explicit) {
    await bumpUsage(env, monthKey(), 1);
    const list = await env.FILES.list({ prefix: `games/${game.id}/v${version}/`, limit: 1000 });
    const pages = list.objects.filter((o) => /\.html?$/i.test(o.key) && o.size < 1024 * 1024).slice(0, 10);
    for (const o of pages) {
      const obj = await env.FILES.get(o.key);
      const { hard, soft } = keywordCheck(visibleText(await obj.text()));
      if (hard) { explicit = true; break; }
      if (soft) notes.push(`Game page mentions "${soft}"`);
    }
    const images = list.objects.filter((o) => /\.(png|jpe?g|webp|gif)$/i.test(o.key));
    if (images.length && ver.scans === 0) notes.push('Game images were not auto-checked');
  }
  if (explicit) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE versions SET published = 1, review = 'rejected' WHERE game_id = ? AND version = ?`).bind(game.id, version),
      env.DB.prepare(`UPDATE games SET review_note = ?, status = CASE WHEN current_version = 0 THEN 'rejected' ELSE status END, updated_at = datetime('now') WHERE id = ?`)
        .bind('Automatically rejected: the game appears to contain adult content.', game.id),
    ]);
    ctx.waitUntil(deletePrefix(env, `games/${game.id}/v${version}/`).catch(() => {}));
    fail(422, "Your game looks like it contains adult content, which isn't allowed on SpawnpointAI.");
  }

  // A newer submission replaces one still waiting for review.
  const superseded = game.pending_version && game.pending_version !== version ? game.pending_version : null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE versions SET published = 1, review = 'pending', flags = ? WHERE game_id = ? AND version = ?`).bind(joinFlags(notes), game.id, version),
    env.DB.prepare(`UPDATE games SET pending_version = ?, pending_entry = ?, review_note = '', flags = ?,
        status = CASE WHEN status IN ('draft', 'rejected') THEN 'pending' ELSE status END, updated_at = datetime('now') WHERE id = ?`)
      .bind(version, entry, joinFlags(splitFlags(game.flags), notes), game.id),
  ]);
  if (superseded) {
    await env.DB.prepare(`UPDATE versions SET review = 'superseded' WHERE game_id = ? AND version = ?`).bind(game.id, superseded).run();
    ctx.waitUntil(deletePrefix(env, `games/${game.id}/v${superseded}/`).catch(() => {}));
  }
  if (admin) return approveGame(env, slug, ctx);
  return json({ game: gameFor(await loadGame(env, slug), 'owner'), submitted: true });
}

// Checks one image from an unpublished version with the vision model. The upload page calls
// this for the game's main images before submitting.
async function scanImage(request, env, slug, versionRaw, url) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const version = parseInt(versionRaw, 10);
  const ver = await env.DB.prepare('SELECT * FROM versions WHERE game_id = ? AND version = ?').bind(game.id, version).first();
  if (!ver || ver.published) fail(409, 'Images can only be checked before a version is submitted.');
  if (ver.scans >= 4) return json({ result: 'skipped' });
  const path = cleanPath(url.searchParams.get('path') || '');
  if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) fail(400, 'Only images can be checked.');
  const obj = await env.FILES.get(`games/${game.id}/v${version}/${path}`);
  if (!obj) fail(404, 'That image is not part of this upload.');
  if (obj.size > MAX_SCAN_BYTES) return json({ result: 'skipped' });
  const result = await aiImageCheck(env, await obj.arrayBuffer());
  const note = result === 'explicit' ? `EXPLICIT image: ${path}` : result === 'unavailable' ? `Image not AI-checked: ${path}` : null;
  await env.DB.prepare(`UPDATE versions SET scans = scans + 1, flags = ? WHERE game_id = ? AND version = ?`)
    .bind(joinFlags(splitFlags(ver.flags), [note]), game.id, version).run();
  if (result === 'explicit') fail(422, "Your game looks like it contains adult content, which isn't allowed on SpawnpointAI.");
  return json({ result });
}

async function uploadCover(request, env, slug) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const admin = isAdmin(request, env);
  const type = request.headers.get('content-type') || '';
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) fail(400, 'Use a PNG, JPG, WebP or GIF image for the cover.');
  const data = await request.arrayBuffer();
  if (data.byteLength > MAX_COVER_BYTES) fail(413, 'Keep the cover image under 3 MB.');
  const check = admin ? 'safe' : await aiImageCheck(env, data);
  if (check === 'explicit') fail(422, ADULT_MESSAGE);

  // A live game keeps its approved cover until the new one is reviewed.
  const staged = game.status === 'live' && !admin;
  const key = staged ? `covers/${game.id}-pending` : `covers/${game.id}`;
  const old = await env.FILES.head(key);
  await reserveR2(env, data.byteLength);
  await env.FILES.put(key, data, { httpMetadata: { contentType: type } });
  if (old) await releaseR2(env, old.size);
  const flags = check === 'unavailable' ? joinFlags(splitFlags(game.flags), ['Cover image was not AI-checked']) : game.flags;
  await env.DB.prepare(`UPDATE games SET ${staged ? 'cover_pending = 1' : 'has_cover = 1'}, flags = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(flags, game.id).run();
  return json({ ok: true, pending: staged });
}

// ---------- review ----------

async function reviewQueue(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM games WHERE status != 'deleted'
      AND (status = 'pending' OR pending_version IS NOT NULL OR cover_pending = 1 OR pending_url IS NOT NULL)
      ORDER BY updated_at ASC LIMIT 100`).all();
  const { results: counts } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports r JOIN games g ON g.id = r.game_id WHERE g.status != 'deleted'`).all();
  return json({ games: results.map((g) => gameFor(g, 'admin')), reports: counts[0]?.n || 0 });
}

async function approveGame(env, slug, ctx) {
  const game = await loadGame(env, slug);
  const sets = [`status = CASE WHEN status = 'hidden' THEN 'hidden' ELSE 'live' END`, `review_note = ''`, `flags = ''`, `pending_version = NULL`, `pending_entry = NULL`, `pending_url = NULL`, `cover_pending = 0`];
  const binds = [];
  const stmts = [];
  if (game.pending_version) {
    sets.push('current_version = ?', 'entry = ?');
    binds.push(game.pending_version, game.pending_entry || 'index.html');
    stmts.push(env.DB.prepare(`UPDATE versions SET review = 'approved' WHERE game_id = ? AND version = ?`).bind(game.id, game.pending_version));
  }
  if (game.pending_url) { sets.push('external_url = ?'); binds.push(game.pending_url); }
  if (game.cover_pending) {
    const staged = await env.FILES.get(`covers/${game.id}-pending`);
    if (staged) {
      const bytes = await staged.arrayBuffer();
      const old = await env.FILES.head(`covers/${game.id}`);
      await reserveR2(env, bytes.byteLength);
      await env.FILES.put(`covers/${game.id}`, bytes, { httpMetadata: staged.httpMetadata });
      await env.FILES.delete(`covers/${game.id}-pending`);
      await releaseR2(env, bytes.byteLength + (old?.size || 0));
      sets.push('has_cover = 1');
    }
  }
  stmts.push(env.DB.prepare(`UPDATE games SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...binds, game.id));
  await env.DB.batch(stmts);
  // Keep the version players had before (for rollback); clear out anything older.
  const previous = game.current_version;
  if (game.pending_version && previous && previous < game.pending_version - 1) {
    ctx.waitUntil(deletePrefix(env, `games/${game.id}/v${previous - 1}/`).catch(() => {}));
  }
  return json({ game: gameFor(await loadGame(env, slug), 'admin'), approved: true });
}

async function rejectGame(request, env, slug, ctx) {
  const game = await loadGame(env, slug);
  const body = await readJson(request).catch(() => ({}));
  const note = cleanText(body.reason, 500, 'reason') || 'The site owner did not approve this submission.';
  const stmts = [];
  if (game.pending_version) {
    stmts.push(env.DB.prepare(`UPDATE versions SET review = 'rejected' WHERE game_id = ? AND version = ?`).bind(game.id, game.pending_version));
    ctx.waitUntil(deletePrefix(env, `games/${game.id}/v${game.pending_version}/`).catch(() => {}));
  }
  if (game.cover_pending) ctx.waitUntil(deletePrefix(env, `covers/${game.id}-pending`).catch(() => {}));
  const neverLive = game.status === 'pending';
  stmts.push(env.DB.prepare(`UPDATE games SET review_note = ?, flags = '', pending_version = NULL, pending_entry = NULL, pending_url = NULL,
      cover_pending = 0, status = ?, updated_at = datetime('now') WHERE id = ?`).bind(note, neverLive ? 'rejected' : game.status, game.id));
  await env.DB.batch(stmts);
  return json({ game: gameFor(await loadGame(env, slug), 'admin'), rejected: true });
}

async function deleteGame(request, env, slug, ctx) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  await env.DB.prepare(`UPDATE games SET status = 'deleted', slug = slug || '-deleted-' || id, updated_at = datetime('now') WHERE id = ?`).bind(game.id).run();
  ctx.waitUntil(Promise.all([deletePrefix(env, `games/${game.id}/`), deletePrefix(env, `covers/${game.id}`)]).catch(() => {}));
  return json({ ok: true });
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    await bumpUsage(env, monthKey(), 1); // a list is a write-class operation in R2 billing
    const list = await env.FILES.list({ prefix, cursor, limit: 1000 });
    if (list.objects.length) {
      await env.FILES.delete(list.objects.map((o) => o.key));
      await releaseR2(env, list.objects.reduce((n, o) => n + o.size, 0));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function recordPlay(env, slug) {
  await env.DB.prepare(`UPDATE games SET plays = plays + 1 WHERE slug = ? AND status = 'live'`).bind(slug).run();
  return json({ ok: true });
}

async function vote(request, env, slug) {
  const game = await loadGame(env, slug);
  if (game.status !== 'live') fail(404, 'This game is not live yet.');
  const body = await readJson(request);
  const voter = cleanText(body.voter, 64, 'voter id', true);
  const value = [1, -1, 0].includes(body.value) ? body.value : fail(400, 'Vote must be 1, -1 or 0.');
  const voterHash = await sha256(voter + (await clientHash(request)));
  const stmts = value === 0
    ? [env.DB.prepare('DELETE FROM votes WHERE game_id = ? AND voter = ?').bind(game.id, voterHash)]
    : [env.DB.prepare('INSERT INTO votes (game_id, voter, value) VALUES (?, ?, ?) ON CONFLICT(game_id, voter) DO UPDATE SET value = excluded.value').bind(game.id, voterHash, value)];
  stmts.push(env.DB.prepare(`UPDATE games SET
      up = (SELECT COUNT(*) FROM votes WHERE game_id = ?1 AND value = 1),
      down = (SELECT COUNT(*) FROM votes WHERE game_id = ?1 AND value = -1)
      WHERE id = ?1`).bind(game.id));
  await env.DB.batch(stmts);
  const g = await env.DB.prepare('SELECT up, down FROM games WHERE id = ?').bind(game.id).first();
  return json({ up: g.up, down: g.down, value });
}

async function report(request, env, slug) {
  const game = await loadGame(env, slug);
  if (game.status !== 'live') fail(404, 'This game is not live.');
  const body = await readJson(request);
  const reasons = ['broken', 'malicious', 'inappropriate', 'copyright', 'spam', 'other'];
  const reason = reasons.includes(body.reason) ? body.reason : fail(400, 'Pick a reason for the report.');
  await env.DB.prepare('INSERT INTO reports (game_id, reason, details) VALUES (?, ?, ?)')
    .bind(game.id, reason, cleanText(body.details, 1000, 'details')).run();
  return json({ ok: true }, 201);
}

// ---------- game files ----------

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', map: 'application/json', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', fbx: 'application/octet-stream',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  csv: 'text/csv', tmx: 'application/xml', tsx: 'application/xml', atlas: 'text/plain', fnt: 'text/plain', bin: 'application/octet-stream', data: 'application/octet-stream',
};
function contentTypeFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

// Games run with no access to the site's storage or cookies (opaque origin).
// This small script gives them a working localStorage that the site saves per game.
const STORAGE_SHIM = `<script>(function(){var d={},G=location.pathname.split('/')[2]||'';try{if(window.name&&window.name.indexOf('__sp:')===0){d=JSON.parse(window.name.slice(5))||{};}}catch(e){}try{window.name='';}catch(e){}
var t=null;function save(){if(window.parent===window)return;clearTimeout(t);t=setTimeout(function(){try{window.parent.postMessage({__sp:'save',game:G,data:d},'*');}catch(e){}},150);}
function mk(s,p){var api={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null;},setItem:function(k,v){s[String(k)]=String(v);if(p)save();},removeItem:function(k){delete s[String(k)];if(p)save();},clear:function(){for(var k in s)delete s[k];if(p)save();},key:function(i){var ks=Object.keys(s);return i<ks.length?ks[i]:null;}};Object.defineProperty(api,'length',{get:function(){return Object.keys(s).length;}});return api;}
function def(o,n,v){try{Object.defineProperty(o,n,{configurable:true,get:function(){return v;}});}catch(e){}}
var ok=false;try{ok=!!window.localStorage;}catch(e){}if(!ok){def(window,'localStorage',mk(d,true));def(window,'sessionStorage',mk({},false));try{document.cookie;}catch(e){def(document,'cookie','');}}})();</script>`;

async function servePlayFile(request, env, url) {
  // /play/<gameId>/<version>/<path...>
  const m = url.pathname.match(/^\/play\/([a-f0-9]{16})\/(\d+)\/?(.*)$/);
  if (!m) return new Response('Not found', { status: 404 });
  const [, id, version, rest] = m;
  let path = rest ? cleanPath(rest) : 'index.html';
  if (path.endsWith('/')) path += 'index.html';
  const key = `games/${id}/v${version}/${path}`;
  const range = request.headers.get('range');
  const obj = await env.FILES.get(key, range ? { range: request.headers } : {});
  if (!obj) return new Response('File not found in this game.', { status: 404, headers: { 'access-control-allow-origin': '*' } });

  const type = obj.httpMetadata?.contentType || contentTypeFor(path);
  const headers = new Headers({
    'content-type': type,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    etag: obj.httpEtag,
    // Even if opened directly, a game page is sandboxed away from the site.
    'content-security-policy': "sandbox allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-downloads allow-orientation-lock",
  });

  if (type.startsWith('text/html')) {
    let html = await obj.text();
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + STORAGE_SHIM) : STORAGE_SHIM + html;
    headers.delete('accept-ranges');
    headers.delete('etag');
    return new Response(html, { headers });
  }
  if (range && obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}

async function serveCover(env, url) {
  const id = url.pathname.split('/')[2] || '';
  if (!/^[a-f0-9]{16}$/.test(id)) return new Response('Not found', { status: 404 });
  const obj = await env.FILES.get(url.searchParams.get('pending') ? `covers/${id}-pending` : `covers/${id}`);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' },
  });
}

// ---------- share previews for game pages ----------

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

async function serveGamePage(request, env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: { accept: 'text/html' } }));
  const slug = decodeURIComponent(url.pathname.split('/')[2] || '');
  const game = slug ? await env.DB.prepare(`SELECT * FROM games WHERE slug = ? AND status = 'live'`).bind(slug).first() : null;
  if (!game) return res;
  const title = `${game.title} by ${game.creator}`;
  const desc = game.tagline || game.description.slice(0, 160) || `Play ${game.title} in your browser.`;
  const image = game.has_cover ? `${url.origin}/cover/${game.id}` : '';
  const tags = `<title>${esc(title)} | ${esc(env.SITE_NAME || 'SpawnpointAI')}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url.origin + url.pathname)}">
${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}`;
  const html = (await res.text()).replace(/<title>[\s\S]*?<\/title>/i, tags);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
}
