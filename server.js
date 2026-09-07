/**
 * elBitBox - a shared network jukebox (synchronized YouTube player).
 *
 * How it works:
 *  - Serves a web page on port 8080.
 *  - Any client on the network can paste a YouTube URL to add a song.
 *  - The server keeps a shared playlist and an authoritative "now playing"
 *    timeline (which video + when it started). It does NOT download anything;
 *    each client's browser embeds the YouTube player and seeks to the shared
 *    position, so everyone watches/listens in sync.
 *  - Songs auto-advance when they finish, while the playlist is not empty.
 *
 * Only lightweight metadata (title + duration) is fetched via yt-dlp, which
 * works even on networks where media downloads are blocked.
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const { create: createYoutubeDl } = require('youtube-dl-exec');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = 8080;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Binary discovery (yt-dlp + ffmpeg)
//
// The bundled yt-dlp binary can fail to download behind corporate proxies, and
// ffmpeg lives in a separate install. We locate real binaries by checking (in
// order): explicit env override, common winget/scoop/choco install locations,
// and finally the system PATH.
// ---------------------------------------------------------------------------
function searchDir(root, exeName, maxDepth) {
  if (maxDepth < 0 || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) {
      return full;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = searchDir(path.join(root, entry.name), exeName, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function discoverBinary(exeName, envVar) {
  const override = process.env[envVar];
  if (override && fs.existsSync(override)) return override;

  const home = os.homedir();
  const roots = [
    path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
    path.join(home, 'scoop', 'apps'),
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\ffmpeg\\bin',
  ];
  for (const root of roots) {
    const found = searchDir(root, exeName, 4);
    if (found) return found;
  }
  return null; // fall back to PATH
}

const YT_DLP_PATH = discoverBinary('yt-dlp.exe', 'YT_DLP_PATH');

// yt-dlp needs a JS runtime (Deno or Node) on PATH to solve YouTube's signature
// ("n") challenge. Make sure the discovered Deno is visible to the yt-dlp child
// process, otherwise many downloads fail.
const DENO_PATH = discoverBinary('deno.exe', 'DENO_PATH');
if (DENO_PATH) {
  process.env.PATH = `${path.dirname(DENO_PATH)}${path.delimiter}${process.env.PATH}`;
}

// A youtube-dl-exec instance bound to the discovered (or PATH) yt-dlp binary.
const youtubedl = createYoutubeDl(YT_DLP_PATH || 'yt-dlp');

console.log('yt-dlp :', YT_DLP_PATH || 'yt-dlp (from PATH)');
console.log('deno   :', DENO_PATH || '(not found — signature solving may fail)');

// Optional network/auth options for restricted environments. YouTube now often
// requires a signed-in session (PO token) to download media; the most reliable
// fix on a locked-down machine is a cookies.txt exported from your browser.
//   ./cookies.txt (auto)   OR  YTDLP_COOKIES_FILE=path\to\cookies.txt
//   YTDLP_PROXY            e.g. http://user:pass@proxy:8080
//   YTDLP_COOKIES_BROWSER  e.g. chrome | edge | firefox
//   YTDLP_PLAYER_CLIENT    e.g. android | web_safari | tv
const COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ||
  (fs.existsSync(path.join(__dirname, 'cookies.txt'))
    ? path.join(__dirname, 'cookies.txt')
    : null);
if (COOKIES_FILE) console.log('cookies:', COOKIES_FILE);

const DOWNLOAD_NET_OPTS = {
  ...(COOKIES_FILE ? { cookies: COOKIES_FILE } : {}),
  ...(process.env.YTDLP_PROXY ? { proxy: process.env.YTDLP_PROXY } : {}),
  ...(process.env.YTDLP_COOKIES_BROWSER
    ? { cookiesFromBrowser: process.env.YTDLP_COOKIES_BROWSER }
    : {}),
  ...(process.env.YTDLP_PLAYER_CLIENT
    ? { extractorArgs: `youtube:player_client=${process.env.YTDLP_PLAYER_CLIENT}` }
    : {}),
};

// ---------------------------------------------------------------------------
// Persistent cache: youtube url -> { url, videoId, title, duration }
// ---------------------------------------------------------------------------
/** @type {Record<string, {url: string, videoId: string, title: string, duration: number}>} */
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
}
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// Playback state (a shared, authoritative timeline)
// ---------------------------------------------------------------------------
/** @typedef {{nick: string, avatar: string}} AddedBy */
/** @typedef {{id: string, url: string, videoId: string, title: string, duration: number, addedBy: AddedBy}} Song */

/** @type {Song[]} */
const playlist = [];
/** @type {Song|null} */
let current = null;
let startedAt = 0; // epoch ms when `current` began playing
let advanceTimer = null; // fires when the current song should end

// ---------------------------------------------------------------------------
// WebSocket: push playlist / now-playing state to every client
// ---------------------------------------------------------------------------
function stateSnapshot() {
  return {
    type: 'state',
    serverNow: Date.now(),
    current: current
      ? {
          id: current.id,
          videoId: current.videoId,
          title: current.title,
          url: current.url,
          duration: current.duration,
          startedAt,
          addedBy: current.addedBy || null,
        }
      : null,
    playlist: playlist.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      addedBy: s.addedBy || null,
    })),
    chat: chatMessages,
    actions: actionLog,
  };
}

let wss = null;
function notifyState() {
  if (!wss) return;
  const msg = JSON.stringify(stateSnapshot());
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}
function notify(event, message) {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'notice', event, message });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Chat + action log — in-memory ring buffers (no persistence). Oldest entries
// are dropped once the cap is reached.
// ---------------------------------------------------------------------------
const CHAT_MAX = 60;
const ACTION_MAX = 60;
/** @type {Array<{id: string, nick: string, avatar: string, text: string, at: number}>} */
const chatMessages = [];
/** @type {Array<{id: string, nick: string, avatar: string, text: string, at: number}>} */
const actionLog = [];

function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

/** Normalize a user identity from a request/message body. */
function readActor(body) {
  return {
    nick: body && body.nick ? String(body.nick).slice(0, 24) : '',
    avatar: body && body.avatar ? String(body.avatar).slice(0, 8) : '',
  };
}

/** Append a chat message and broadcast it to everyone. */
function pushChat({ nick, avatar, text }) {
  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    nick,
    avatar,
    text,
    at: Date.now(),
  };
  chatMessages.push(entry);
  while (chatMessages.length > CHAT_MAX) chatMessages.shift();
  broadcast({ type: 'chat', message: entry });
}

/** Append an action-log entry (who did what) and broadcast it. */
function pushAction(text, actor) {
  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    nick: (actor && actor.nick) || '',
    avatar: (actor && actor.avatar) || '',
    text,
    at: Date.now(),
  };
  actionLog.push(entry);
  while (actionLog.length > ACTION_MAX) actionLog.shift();
  broadcast({ type: 'action', action: entry });
}

// ---------------------------------------------------------------------------
// Playback loop — the server just tracks time; clients do the actual playing.
// ---------------------------------------------------------------------------
function playNext() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }

  const next = playlist.shift();
  if (!next) {
    current = null;
    startedAt = 0;
    notifyState();
    return;
  }

  current = next;
  startedAt = Date.now();
  notifyState();

  // Auto-advance when the song is expected to finish. A small buffer covers
  // seek/network latency; clients also report 'ended' as a fallback.
  if (current.duration && current.duration > 0) {
    advanceTimer = setTimeout(playNext, (current.duration + 1) * 1000);
  }
}

/** Advance only if the given video is still the current one (avoids double-skips). */
function endIfCurrent(videoId) {
  if (current && current.videoId === videoId) playNext();
}

/** Move a queued song up or down by one position. Returns true if it moved. */
function moveSong(id, dir) {
  const i = playlist.findIndex((s) => s.id === id);
  if (i < 0) return false;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= playlist.length) return false;
  [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
  notifyState();
  return true;
}

/** Remove a queued song by id. Returns the removed song, or null. */
function removeSong(id) {
  const i = playlist.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const [removed] = playlist.splice(i, 1);
  notifyState();
  return removed;
}

/** Start playback if nothing is currently playing. */
function ensurePlaying() {
  if (!current) playNext();
}

// ---------------------------------------------------------------------------
// Metadata — resolve a YouTube URL to { videoId, title, duration }.
// Only metadata is fetched (no media download), so this works even where
// downloads are blocked. Falls back to YouTube's oEmbed for the title.
// ---------------------------------------------------------------------------
function extractVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host.endsWith('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|live)\/([^/?]+)/);
      if (m) return m[2];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** Return the playlist id (list=...) if the URL points at a YouTube playlist. */
function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host.endsWith('youtube.com') || host === 'youtu.be') {
      return u.searchParams.get('list');
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function oembedTitle(url) {
  return new Promise((resolve) => {
    const api = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
    https
      .get(api, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).title || null);
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

async function resolveSong(url) {
  const cached = cache[url];
  if (cached && cached.videoId) return cached;

  let videoId = extractVideoId(url);
  let title = null;
  let duration = 0;

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
      ...DOWNLOAD_NET_OPTS,
    });
    videoId = info.id || videoId;
    title = info.title || null;
    duration = Number(info.duration) || 0;
  } catch (err) {
    console.warn('Metadata fetch failed:', err.stderr || err.shortMessage || err.message);
  }

  if (!videoId) throw new Error('Could not recognize a YouTube video in that link.');
  if (!title) title = (await oembedTitle(url)) || 'YouTube video';

  const meta = { url, videoId, title, duration };
  cache[url] = meta;
  saveCache();
  return meta;
}

/**
 * Resolve a YouTube playlist link to an array of song metadata.
 * Uses a flat listing (no per-video extraction) so it stays fast, and caps the
 * number of entries to keep huge playlists / auto-generated mixes reasonable.
 */
const PLAYLIST_MAX = 15;
async function resolvePlaylist(url) {
  const listId = extractPlaylistId(url);
  const target = listId ? `https://www.youtube.com/playlist?list=${listId}` : url;

  const info = await youtubedl(target, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    yesPlaylist: true,
    playlistEnd: PLAYLIST_MAX,
    ...DOWNLOAD_NET_OPTS,
  });

  const entries = info && Array.isArray(info.entries) ? info.entries : [];
  const metas = [];
  for (const e of entries.slice(0, PLAYLIST_MAX)) {
    const videoId = e.id;
    if (!videoId) continue;
    const songUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const meta = {
      url: songUrl,
      videoId,
      title: e.title || 'YouTube video',
      duration: Number(e.duration) || 0,
    };
    cache[songUrl] = meta;
    metas.push(meta);
  }
  if (metas.length) saveCache();
  return metas;
}

/**
 * Resolve a free-text query to the first YouTube search result.
 * Uses yt-dlp's `ytsearch1:` so only metadata is fetched (no media download).
 */
async function resolveSearch(query) {
  const info = await youtubedl(`ytsearch1:${query}`, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    ...DOWNLOAD_NET_OPTS,
  });
  const entry = info && Array.isArray(info.entries) ? info.entries[0] : info;
  if (!entry || !entry.id) throw new Error('No results found for that search.');

  const url = `https://www.youtube.com/watch?v=${entry.id}`;
  const meta = {
    url,
    videoId: entry.id,
    title: entry.title || 'YouTube video',
    duration: Number(entry.duration) || 0,
  };
  cache[url] = meta;
  saveCache();
  return meta;
}

/** Fetch YouTube search-as-you-type suggestions for a query. */
function fetchSuggestions(query) {
  return new Promise((resolve) => {
    const api =
      'https://suggestqueries.google.com/complete/search' +
      `?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
    // rejectUnauthorized:false mirrors yt-dlp's --no-check-certificates, needed
    // on networks with a TLS-inspecting proxy (self-signed cert in the chain).
    https
      .get(api, { rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(Array.isArray(parsed[1]) ? parsed[1].slice(0, 8) : []);
          } catch {
            resolve([]);
          }
        });
      })
      .on('error', () => resolve([]));
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Current state for initial page load.
app.get('/state', (req, res) => {
  res.json(stateSnapshot());
});

// Add a song by YouTube URL or by search query (first result is used).
app.post('/add', (req, res) => {
  const url = (req.body && req.body.url ? String(req.body.url) : '').trim();
  const query = (req.body && req.body.query ? String(req.body.query) : '').trim();

  if (!url && !query) {
    return res.status(400).json({ error: 'Please provide a URL or search term.' });
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Please provide a valid URL.' });
  }

  const addedBy = {
    nick: req.body && req.body.nick ? String(req.body.nick).slice(0, 24) : '',
    avatar: req.body && req.body.avatar ? String(req.body.avatar).slice(0, 8) : '',
  };

  // Respond immediately; resolving metadata may take a moment.
  res.status(202).json({ status: 'adding' });
  notify('adding', 'Adding song…');

  const who = addedBy.nick ? `${addedBy.nick} added` : 'Added';

  // Explicit "Add Playlist" request: add every song (up to PLAYLIST_MAX).
  if (url && req.body && req.body.playlist === true) {
    if (!extractPlaylistId(url)) {
      notify('error', 'That link has no playlist. Use "Add Video" instead.');
      return;
    }
    resolvePlaylist(url)
      .then((metas) => {
        if (!metas.length) throw new Error('No videos found in that playlist.');
        metas.forEach((meta) => {
          playlist.push({ id: crypto.randomBytes(6).toString('hex'), ...meta, addedBy });
        });
        notify('added', `${who} ${metas.length} song${metas.length === 1 ? '' : 's'} from a playlist`);
        pushAction(`added ${metas.length} song${metas.length === 1 ? '' : 's'} from a playlist`, addedBy);
        notifyState();
        ensurePlaying();
      })
      .catch((err) => {
        console.error('Failed to add playlist:', err.message);
        notify('error', err.message || 'Could not add that playlist.');
      });
    return;
  }

  const resolver = url ? resolveSong(url) : resolveSearch(query);
  resolver
    .then((meta) => {
      const song = { id: crypto.randomBytes(6).toString('hex'), ...meta, addedBy };
      playlist.push(song);
      notify('added', `${who}: ${song.title}`);
      pushAction(`added ${song.title}`, addedBy);
      notifyState();
      ensurePlaying();
    })
    .catch((err) => {
      console.error('Failed to add song:', err.message);
      notify('error', err.message || 'Could not add song.');
    });
});

// YouTube search-as-you-type suggestions.
app.get('/suggest', async (req, res) => {
  const q = (req.query && req.query.q ? String(req.query.q) : '').trim();
  if (!q) return res.json([]);
  const suggestions = await fetchSuggestions(q);
  res.json(suggestions);
});

// Skip the current song (advance to the next one).
app.post('/skip', (req, res) => {
  if (current) pushAction(`skipped ${current.title}`, readActor(req.body));
  playNext();
  res.json({ status: 'skipped' });
});

// Reorder a queued song up or down by one position.
app.post('/move', (req, res) => {
  const id = req.body && req.body.id ? String(req.body.id) : '';
  const dir = req.body && req.body.dir === 'up' ? 'up' : 'down';
  const moved = moveSong(id, dir);
  res.status(moved ? 200 : 400).json({ status: moved ? 'moved' : 'no-op' });
});

// Remove a queued song by id.
app.post('/remove', (req, res) => {
  const id = req.body && req.body.id ? String(req.body.id) : '';
  const removed = removeSong(id);
  if (removed) {
    notify('removed', `Removed: ${removed.title}`);
    pushAction(`removed ${removed.title}`, readActor(req.body));
    res.json({ status: 'removed' });
  } else {
    res.status(400).json({ status: 'no-op' });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(stateSnapshot()));
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.type === 'ended' && data.videoId) endIfCurrent(data.videoId);
    if (data.type === 'skip') playNext();
    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 300);
      if (!text) return;
      const actor = readActor(data);
      pushChat({ nick: actor.nick, avatar: actor.avatar, text });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  elBitBox is playing on http://localhost:${PORT}`);
  console.log(`  Share your LAN IP with clients, e.g. http://<your-ip>:${PORT}\n`);
});
