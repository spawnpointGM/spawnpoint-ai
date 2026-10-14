# SpawnpointAI

A store for browser games made with AI. Players find and play games instantly; creators upload a zip or HTML file (or link to a game hosted elsewhere) and get a game page with ratings, plays and version history.

Runs entirely on Cloudflare's free tier: Workers (site and API), D1 (database) and R2 (game files, no bandwidth fees).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/spawnpointGM/spawnpoint-ai)

## Deploy it

1. Tap **Deploy to Cloudflare** above and sign in (or create a free Cloudflare account).
2. Connect your GitHub account when asked. Cloudflare copies this repo into it.
3. Leave the database and bucket names as they are. For **ADMIN_KEY**, enter a long password only you know.
4. Tap **Deploy**. In about a minute you get a link like `https://spawnpoint-ai.<your-name>.workers.dev`.

If Cloudflare asks you to turn on R2 first, it may ask for a card. That's a verification step; the free tier (10 GB of storage, free bandwidth) isn't charged.

After that, every change pushed to the GitHub copy redeploys the site automatically.

## Publishing a game

- **Upload:** a `.zip` of your game folder or a single `.html` file, up to 50 MB. The zip needs an `index.html` (or another `.html` start file you pick). Use relative paths for assets, like `img/player.png`, not `/img/player.png`.
- **Link:** paste an `https://` link to a game hosted on Rosebud, itch.io, your own site, etc. If that site blocks embedding, players get an "Open on its site" button.

When you publish, you get an **edit key**. It's saved in your browser under My games; copy it somewhere safe too. It's the only way to update or delete the game from another device.

### How games are kept safe

Each game runs in a sandbox with no access to the site, its visitors' data or other games. Games can still use `localStorage` for saves: the site stores that data per game, per player, and it carries over when you publish a new version. Cookies and IndexedDB are not available inside games.

## Moderation

Players can report games. As the site owner, list reports and remove a game with your `ADMIN_KEY`:

```sh
curl https://YOUR-SITE/api/admin/reports -H "x-admin-key: YOUR_ADMIN_KEY"
curl -X DELETE https://YOUR-SITE/api/games/GAME-SLUG -H "x-admin-key: YOUR_ADMIN_KEY"
```

To hide a game without deleting it: `curl -X PATCH https://YOUR-SITE/api/games/GAME-SLUG -H "x-admin-key: YOUR_ADMIN_KEY" -H "content-type: application/json" -d '{"status":"hidden"}'`.

## Settings

Change these in `wrangler.jsonc` (or in the Cloudflare dashboard under the Worker's settings):

| Setting | Default | What it does |
| --- | --- | --- |
| `SITE_NAME` | SpawnpointAI | Name used in page titles and share previews |
| `MAX_GAME_MB` | 50 | Largest upload per game version |
| `MAX_FILES` | 1000 | Most files per game version |
| `NEW_GAMES_PER_DAY` | 10 | New games one person can publish per day |

## Free tier limits and scaling

| Service | Free allowance | When you'd outgrow it |
| --- | --- | --- |
| Workers | 100,000 requests a day | Each game load is roughly 1 request per file. A small game is 5–20 requests. |
| D1 | 5 GB storage, 5 million rows read and 100,000 written a day | Each browse of the game list reads every live game, so about 1,000 games × 5,000 browses a day hits the cap. Playing a game doesn't use D1. |
| R2 | 10 GB storage, free bandwidth | About 200 games at 50 MB, far more at typical sizes |

On the free plan, hitting a daily cap pauses that service until midnight UTC (Cloudflare emails you); stored games are never lost. To scale, turn on the Workers Paid plan ($5/month) in the Cloudflare dashboard. Nothing in the code needs to change. Next steps worth adding as the site grows: a custom domain (enables Cloudflare's edge cache for game files), creator accounts, and the playtesting and multiplayer features from the platform plan.

## Run it locally

```sh
npm install
npm run dev   # http://localhost:8787
```

## How it's built

- `src/index.js` — the Worker: API, game file serving from R2, share previews for game pages
- `public/` — the site (plain HTML, CSS and JavaScript, no build step)
- `wrangler.jsonc` — Cloudflare config; the database and bucket are created on first deploy
