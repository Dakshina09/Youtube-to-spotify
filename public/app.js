const fetchBtn = document.getElementById('fetchBtn');
const ytUrlInput = document.getElementById('ytUrl');
const fetchError = document.getElementById('fetchError');

const stageConnect = document.getElementById('stage-connect');
const connectBtn = document.getElementById('connectBtn');
const connectText = document.getElementById('connectText');

const stageMatch = document.getElementById('stage-match');
const matchBtn = document.getElementById('matchBtn');
const matchSummary = document.getElementById('matchSummary');
const matchList = document.getElementById('matchList');

const stageCreate = document.getElementById('stage-create');
const playlistNameInput = document.getElementById('playlistName');
const createBtn = document.getElementById('createBtn');
const createResult = document.getElementById('createResult');

let ytTracks = [];
let matchedResults = [];

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

// ---- Stage 1: fetch YouTube playlist ----
fetchBtn.addEventListener('click', async () => {
  fetchError.hidden = true;
  const url = ytUrlInput.value.trim();
  if (!url) return showError(fetchError, 'Paste a YouTube playlist URL first.');

  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching…';
  try {
    const resp = await fetch(`/api/youtube-playlist?url=${encodeURIComponent(url)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Something went wrong.');

    ytTracks = data.tracks;
    playlistNameInput.value = `YouTube import (${data.count} tracks)`;
    stageConnect.hidden = false;
    checkSpotifyStatus();
  } catch (err) {
    showError(fetchError, err.message);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch playlist';
  }
});

// ---- Stage 2: connect Spotify ----
async function checkSpotifyStatus() {
  const resp = await fetch('/api/spotify-status');
  const data = await resp.json();
  if (data.connected) {
    connectText.textContent = `Connected as ${data.displayName || 'your Spotify account'}.`;
    connectBtn.textContent = 'Connected';
    connectBtn.disabled = true;
    stageMatch.hidden = false;
    matchSummary.textContent = `${ytTracks.length} tracks ready to match.`;
  }
}

connectBtn.addEventListener('click', () => {
  window.location.href = '/auth/spotify';
});

// Handle redirect back from Spotify OAuth
const params = new URLSearchParams(window.location.search);
if (params.get('spotify_connected')) {
  window.history.replaceState({}, '', '/');
}
if (params.get('spotify_error')) {
  showError(fetchError, `Spotify connection failed: ${params.get('spotify_error')}`);
}
// If a playlist was already fetched in this session before redirect, ytTracks would be empty after reload —
// so this just re-checks connection state for the next fetch.
checkSpotifyStatus();

// ---- Stage 3: match tracks ----
matchBtn.addEventListener('click', async () => {
  matchBtn.disabled = true;
  matchBtn.textContent = 'Matching…';
  matchSummary.textContent = 'Searching Spotify for each track…';
  matchList.innerHTML = '';

  try {
    const resp = await fetch('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: ytTracks })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Matching failed.');

    matchedResults = data.results;
    renderMatches();
    const foundCount = matchedResults.filter((r) => r.match).length;
    matchSummary.textContent = `${foundCount} of ${matchedResults.length} tracks found on Spotify. Uncheck any wrong matches.`;
    stageCreate.hidden = false;
  } catch (err) {
    matchSummary.textContent = err.message;
  } finally {
    matchBtn.disabled = false;
    matchBtn.textContent = 'Find matches on Spotify';
  }
});

function renderMatches() {
  matchList.innerHTML = '';
  matchedResults.forEach((r, idx) => {
    const li = document.createElement('li');
    li.className = 'match-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!r.match;
    checkbox.disabled = !r.match;
    checkbox.dataset.idx = idx;

    let art;
    if (r.match && r.match.albumArt) {
      art = document.createElement('img');
      art.className = 'match-art';
      art.src = r.match.albumArt;
      art.alt = '';
    } else {
      art = document.createElement('div');
      art.className = 'match-art placeholder';
      art.textContent = '?';
    }

    const info = document.createElement('div');
    info.className = 'match-info';
    const title = document.createElement('div');
    title.className = 'match-title';
    title.textContent = r.match ? r.match.name : r.source.guessedTitle || r.source.rawTitle;
    const sub = document.createElement('div');
    sub.className = 'match-sub';
    sub.textContent = r.match ? r.match.artists : r.source.rawTitle;
    info.append(title, sub);

    const tag = document.createElement('span');
    tag.className = `match-tag ${r.match ? 'found' : 'missing'}`;
    tag.textContent = r.match ? 'found' : 'no match';

    li.append(checkbox, art, info, tag);
    matchList.appendChild(li);
  });
}

// ---- Stage 4: create playlist ----
createBtn.addEventListener('click', async () => {
  createResult.hidden = true;
  const name = playlistNameInput.value.trim();
  if (!name) return showError(createResult, 'Give the playlist a name.');

  const checkboxes = matchList.querySelectorAll('input[type="checkbox"]:checked');
  const uris = Array.from(checkboxes)
    .map((cb) => matchedResults[cb.dataset.idx].match?.uri)
    .filter(Boolean);

  if (uris.length === 0) {
    createResult.textContent = 'No matched tracks selected.';
    createResult.hidden = false;
    return;
  }

  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';
  try {
    const resp = await fetch('/api/create-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: 'Imported from a YouTube playlist',
        uris
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not create the playlist.');

    createResult.innerHTML = `Done — <a href="${data.url}" target="_blank" rel="noopener">open your new Spotify playlist</a>.`;
    createResult.hidden = false;
  } catch (err) {
    createResult.textContent = err.message;
    createResult.hidden = false;
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'Create on Spotify';
  }
});
