require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 } // 1 hour
  })
);

const {
  YOUTUBE_API_KEY,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PORT = 3000
} = process.env;

// ---------- helpers ----------

// Pull a playlist ID out of a full URL or accept a bare ID
function extractPlaylistId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const list = url.searchParams.get('list');
    if (list) return list;
  } catch (e) {
    // not a URL, fall through
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

// Strip common YouTube title noise so search against Spotify works better
function cleanTitle(rawTitle, channelTitle) {
  let t = rawTitle;
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/\([^)]*\)/g, ' ');
  t = t.replace(
    /official\s*(music\s*)?video|official\s*audio|lyric[s]?\s*video|lyrics|hd|hq|4k|remastered|full\s*song|audio|visualizer|mv/gi,
    ' '
  );
  t = t.replace(/[-|•]+/g, ' - ');
  t = t.replace(/\s{2,}/g, ' ').trim();

  // Many YouTube titles are "Artist - Song". If so, split for a cleaner Spotify query.
  let artist = null;
  let title = t;
  const dashSplit = t.split(' - ');
  if (dashSplit.length >= 2) {
    artist = dashSplit[0].trim();
    title = dashSplit.slice(1).join(' - ').trim();
  } else if (channelTitle) {
    artist = channelTitle.replace(/\s*-\s*Topic$/i, '').trim();
  }
  return { artist, title, cleaned: t };
}

function requireSpotifyAuth(req, res, next) {
  if (!req.session.spotify_access_token) {
    return res.status(401).json({ error: 'Not connected to Spotify' });
  }
  next();
}

async function refreshSpotifyTokenIfNeeded(req) {
  const { spotify_expires_at, spotify_refresh_token } = req.session;
  if (!spotify_expires_at || Date.now() < spotify_expires_at - 30000) return;
  if (!spotify_refresh_token) return;

  const resp = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: spotify_refresh_token
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
      }
    }
  );
  req.session.spotify_access_token = resp.data.access_token;
  req.session.spotify_expires_at = Date.now() + resp.data.expires_in * 1000;
}

// ---------- YouTube ----------

app.get('/api/youtube-playlist', async (req, res) => {
  try {
    const playlistId = extractPlaylistId(req.query.url);
    if (!playlistId) {
      return res.status(400).json({ error: 'Could not find a playlist ID in that URL.' });
    }
    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({ error: 'Server is missing YOUTUBE_API_KEY.' });
    }

    let items = [];
    let pageToken = '';
    do {
      const resp = await axios.get(
        'https://www.googleapis.com/youtube/v3/playlistItems',
        {
          params: {
            part: 'snippet',
            maxResults: 50,
            playlistId,
            pageToken: pageToken || undefined,
            key: YOUTUBE_API_KEY
          }
        }
      );
      items = items.concat(resp.data.items || []);
      pageToken = resp.data.nextPageToken || '';
    } while (pageToken);

    const tracks = items
      .filter((i) => i.snippet && i.snippet.title !== 'Deleted video' && i.snippet.title !== 'Private video')
      .map((i) => {
        const { artist, title, cleaned } = cleanTitle(
          i.snippet.title,
          i.snippet.videoOwnerChannelTitle
        );
        return {
          videoId: i.snippet.resourceId ? i.snippet.resourceId.videoId : null,
          rawTitle: i.snippet.title,
          channelTitle: i.snippet.videoOwnerChannelTitle || i.snippet.channelTitle,
          guessedArtist: artist,
          guessedTitle: title,
          cleaned
        };
      });

    res.json({ playlistId, count: tracks.length, tracks });
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      return res.status(404).json({ error: 'Playlist not found. Make sure it is public or unlisted.' });
    }
    if (status === 403) {
      return res.status(403).json({ error: 'YouTube API key invalid, quota exceeded, or API not enabled.' });
    }
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch YouTube playlist.' });
  }
});

// ---------- Spotify OAuth ----------

app.get('/auth/spotify', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.spotify_oauth_state = state;
  const scope = 'playlist-modify-public playlist-modify-private';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
    show_dialog: 'true'
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?spotify_error=${encodeURIComponent(error)}`);
  if (!state || state !== req.session.spotify_oauth_state) {
    return res.redirect('/?spotify_error=state_mismatch');
  }
  try {
    const resp = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
        }
      }
    );
    req.session.spotify_access_token = resp.data.access_token;
    req.session.spotify_refresh_token = resp.data.refresh_token;
    req.session.spotify_expires_at = Date.now() + resp.data.expires_in * 1000;

    const me = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${resp.data.access_token}` }
    });
    req.session.spotify_user_id = me.data.id;
    req.session.spotify_display_name = me.data.display_name;

    res.redirect('/?spotify_connected=1');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect('/?spotify_error=token_exchange_failed');
  }
});

app.get('/api/spotify-status', (req, res) => {
  res.json({
    connected: !!req.session.spotify_access_token,
    displayName: req.session.spotify_display_name || null
  });
});

// ---------- Matching ----------

app.post('/api/match', requireSpotifyAuth, async (req, res) => {
  try {
    await refreshSpotifyTokenIfNeeded(req);
    const token = req.session.spotify_access_token;
    const { tracks } = req.body;
    if (!Array.isArray(tracks)) return res.status(400).json({ error: 'tracks must be an array' });

    const results = [];
    for (const t of tracks) {
      const query = t.guessedArtist ? `${t.guessedArtist} ${t.guessedTitle}` : t.cleaned;
      let match = null;
      try {
        const resp = await axios.get('https://api.spotify.com/v1/search', {
          headers: { Authorization: `Bearer ${token}` },
          params: { q: query, type: 'track', limit: 1 }
        });
        const item = resp.data.tracks?.items?.[0];
        if (item) {
          match = {
            uri: item.uri,
            name: item.name,
            artists: item.artists.map((a) => a.name).join(', '),
            album: item.album.name,
            albumArt: item.album.images?.[2]?.url || item.album.images?.[0]?.url || null,
            externalUrl: item.external_urls?.spotify || null
          };
        }
      } catch (e) {
        // leave match as null for this track, continue
      }
      results.push({ source: t, match });
    }

    res.json({ results });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to match tracks against Spotify.' });
  }
});

// ---------- Create playlist ----------

app.post('/api/create-playlist', requireSpotifyAuth, async (req, res) => {
  try {
    await refreshSpotifyTokenIfNeeded(req);
    const token = req.session.spotify_access_token;
    const { name, description, uris } = req.body;

if (!name || !Array.isArray(uris) || uris.length === 0) {
  return res.status(400).json({ error: 'name and a non-empty uris array are required.' });
}

const createResp = await axios.post(
  `https://api.spotify.com/v1/me/playlists`,
  { name, description: description || 'Imported from YouTube', public: false },
  { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
);
    const playlistId = createResp.data.id;

    // Spotify caps add-tracks at 100 URIs per request
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        { uris: batch },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
    }

    res.json({
      playlistId,
      url: createResp.data.external_urls?.spotify || null
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create Spotify playlist.' });
  }
});

app.listen(PORT, () => {
  console.log(`yt2spotify running at http://127.0.0.1:${PORT}`);
});
