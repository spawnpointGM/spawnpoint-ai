// SpawnpointAI: a store for AI-made browser games.
// One Cloudflare Worker serves the API, the game files (from R2) and the site (static assets).

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
  schemaReady = true;
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
    if (sub === 'cover' && method === 'PUT') return uploadCover(request, env, slug);
    if (sub === 'play' && method === 'POST') return recordPlay(env, slug);
    if (sub === 'vote' && method === 'POST') return vote(request, env, slug);
    if (sub === 'report' && method === 'POST') return report(request, env, slug);
  }

  if (parts[0] === 'admin' && parts[1] === 'usage' && method === 'GET') {
    if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) fail(403, 'Admin key required.');
    const stored = await env.DB.prepare(`SELECT value FROM usage WHERE key = 'storage_bytes'`).first();
    const writes = await env.DB.prepare(`SELECT value FROM usage WHERE key = ?`).bind(monthKey()).first();
    return json({
      storageMB: +((stored?.value || 0) / 1024 ** 2).toFixed(2), storageCapMB: Number(env.R2_MAX_GB || 9) * 1024,
      writesThisMonth: writes?.value || 0, writesCapPerMonth: Number(env.R2_MAX_WRITES_PER_MONTH || 900000),
    });
  }

  if (parts[0] === 'admin' && parts[1] === 'reports' && method === 'GET') {
    if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) fail(403, 'Admin key required.');
    const { results } = await env.DB.prepare(`SELECT r.*, g.slug, g.title FROM reports r JOIN games g ON g.id = r.game_id ORDER BY r.id DESC LIMIT 200`).all();
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
  const { results: versions } = await env.DB.prepare(`SELECT version, notes, size_bytes, file_count, created_at FROM versions WHERE game_id = ? AND published = 1 ORDER BY version DESC LIMIT 20`).bind(game.id).all();
  return json({ game: publicGame(game), versions });
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

  const ipHash = await clientHash(request);
  const perDay = Number(env.NEW_GAMES_PER_DAY || 10);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM games WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')`).bind(ipHash).first();
  if (recent.n >= perDay) fail(429, `You can publish up to ${perDay} new games a day. Try again tomorrow, or upload a new version of an existing game.`);

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const editKey = randomToken();
  let slug = slugify(meta.title);
  const taken = await env.DB.prepare('SELECT 1 FROM games WHERE slug = ?').bind(slug).first();
  if (taken) slug = `${slug}-${id.slice(0, 5)}`;

  await env.DB.prepare(`INSERT INTO games (id, slug, title, creator, tagline, description, genre, tags, controls, kind, external_url,
      ai_code, ai_art, ai_audio, ai_text, ai_live, builder, mobile, status, edit_key_hash, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, slug, meta.title, meta.creator, meta.tagline, meta.description, meta.genre, meta.tags, meta.controls, kind, externalUrl,
      meta.ai_code, meta.ai_art, meta.ai_audio, meta.ai_text, meta.ai_live, meta.builder, meta.mobile,
      kind === 'link' ? 'live' : 'draft', await sha256(editKey), ipHash)
    .run();

  let version = null;
  if (kind === 'hosted') {
    version = 1;
    await env.DB.prepare('INSERT INTO versions (game_id, version, notes) VALUES (?, 1, ?)').bind(id, 'First release').run();
  }
  return json({ slug, id, editKey, version }, 201);
}

async function updateGame(request, env, slug) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const body = await readJson(request);
  const meta = readMeta(body, true);
  if (body.externalUrl !== undefined && game.kind === 'link') {
    try {
      const u = new URL(String(body.externalUrl));
      if (u.protocol !== 'https:') throw new Error();
      meta.external_url = u.toString();
    } catch { fail(400, 'Enter a full game link that starts with https://'); }
  }
  const isAdmin = env.ADMIN_KEY && request.headers.get('x-admin-key') === env.ADMIN_KEY;
  if (isAdmin && ['live', 'hidden'].includes(body.status)) meta.status = body.status;
  const keys = Object.keys(meta);
  if (!keys.length) return json({ game: publicGame(game) });
  await env.DB.prepare(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map((k) => meta[k]), game.id).run();
  return json({ game: publicGame(await loadGame(env, slug)) });
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
  const version = parseInt(versionRaw, 10);
  const ver = await env.DB.prepare('SELECT * FROM versions WHERE game_id = ? AND version = ?').bind(game.id, version).first();
  if (!ver) fail(404, 'That version does not exist.');
  const body = await readJson(request).catch(() => ({}));
  const entry = cleanPath(body.entry || 'index.html');
  if (!/\.html?$/i.test(entry)) fail(400, 'The start file must be an .html file.');
  const head = await env.FILES.head(`games/${game.id}/v${version}/${entry}`);
  if (!head) fail(400, `The start file ${entry} wasn't uploaded. Make sure your game includes it.`);

  const previous = game.current_version;
  await env.DB.batch([
    env.DB.prepare('UPDATE versions SET published = 1 WHERE game_id = ? AND version = ?').bind(game.id, version),
    env.DB.prepare(`UPDATE games SET current_version = ?, entry = ?, status = CASE WHEN status = 'draft' THEN 'live' ELSE status END, updated_at = datetime('now') WHERE id = ?`).bind(version, entry, game.id),
  ]);
  // Keep the previous version for rollback; remove anything older to save storage.
  if (previous && previous < version - 1) ctx.waitUntil(deletePrefix(env, `games/${game.id}/v${previous - 1}/`).catch(() => {}));
  return json({ game: publicGame(await loadGame(env, slug)) });
}

async function uploadCover(request, env, slug) {
  const game = await loadGame(env, slug);
  await requireEditor(request, env, game);
  const type = request.headers.get('content-type') || '';
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) fail(400, 'Use a PNG, JPG, WebP or GIF image for the cover.');
  const data = await request.arrayBuffer();
  if (data.byteLength > MAX_COVER_BYTES) fail(413, 'Keep the cover image under 3 MB.');
  const old = game.has_cover ? await env.FILES.head(`covers/${game.id}`) : null;
  await reserveR2(env, data.byteLength);
  await env.FILES.put(`covers/${game.id}`, data, { httpMetadata: { contentType: type } });
  if (old) await releaseR2(env, old.size);
  await env.DB.prepare(`UPDATE games SET has_cover = 1, updated_at = datetime('now') WHERE id = ?`).bind(game.id).run();
  return json({ ok: true });
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
  const obj = await env.FILES.get(`covers/${id}`);
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
