# Playlist Bridge — YouTube → Spotify

Paste a YouTube playlist URL, connect your Spotify account, and it builds a
matching playlist in Spotify.

## How it works
1. **Fetch** — reads all video titles from a public/unlisted YouTube playlist via the YouTube Data API.
2. **Connect** — you log in to Spotify (OAuth) so the app can search and create playlists on your behalf.
3. **Match** — each YouTube title is cleaned up (removing "Official Video", "Lyrics", etc.) and searched on Spotify. You can uncheck any wrong matches.
4. **Create** — creates a new private playlist in your Spotify account with the matched tracks.

Nothing is stored anywhere — matching happens live in your browser session.

## 1. Get API credentials

**YouTube Data API key**
1. Go to https://console.cloud.google.com/apis/credentials
2. Create a project (or use an existing one) → Enable **"YouTube Data API v3"**
3. Create an **API key** and copy it.

**Spotify app**
1. Go to https://developer.spotify.com/dashboard → Create app
2. Set the **Redirect URI** to exactly: `http://127.0.0.1:3000/auth/spotify/callback`
3. Copy the **Client ID** and **Client Secret**.

## 2. Configure

```bash
cp .env.example .env
```
Fill in `.env` with the four values above (a random string is fine for `SESSION_SECRET`).

## 3. Run

```bash
npm install
npm start
```

Open **http://127.0.0.1:3000** (use `127.0.0.1`, not `localhost` — it has to match the Spotify redirect URI exactly).

## Notes / limits
- The YouTube playlist must be **public or unlisted** (private playlists aren't readable via the API without the owner's own OAuth, which this app doesn't implement).
- Matching uses a simple "clean the title, search Spotify" heuristic — it's usually right but always double-check the results panel before creating the playlist.
- Spotify's free developer tier only lets you log in with accounts you've added as testers, in your app's Dashboard → Settings → User Management, until you request extended quota.
- Sessions live in server memory and expire after an hour of inactivity — fine for local/personal use; swap in a persistent session store (e.g. Redis) before deploying for multiple users.
