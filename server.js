// server.js — zero-dependency Node HTTP server (no express/socket.io needed).
// Real-time push via Server-Sent Events; client actions via POST /api/*.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const G = require('./lib/game.js');
const P = require('./lib/poker.js');
const Bot = require('./lib/bot.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

/**
 * In-memory room store. Rooms disappear on server restart — fine for a casual
 * game among friends. Structure:
 * rooms[code] = {
 *   code, maxPlayers, phase: 'lobby'|'arranging'|'results',
 *   hostId, players: [{ id, token, name, sseRes, connected, hand, assignment, locked }],
 *   boards, handNumber, cumulative: { [id]: number }, lastResults
 * }
 */
const rooms = new Map();

// The same pre-solved (hand, split) pool the browser's Practice Mode downloads. Bots
// best-respond against opponents drawn from it, so a bot seat plays against (and as)
// near-equilibrium strategy rather than something ad hoc. Loaded lazily and cached; a
// missing file just means bots fall back to random opponents when sampling.
let OPPONENT_POOL = null;
function opponentPool() {
  if (OPPONENT_POOL === null) {
    try {
      OPPONENT_POOL = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'opponent-pool.json'), 'utf8'));
    } catch (e) {
      console.error('bot: could not load opponent-pool.json, bots will sample random opponents');
      OPPONENT_POOL = [];
    }
  }
  return OPPONENT_POOL;
}

const BOT_MIN_THINK_MS = 400; // bots shouldn't lock before you've even seen your cards
const BOT_MAX_THINK_MS = 1300;

function makePlayer({ name, isBot = false }) {
  return {
    id: crypto.randomUUID(),
    // Bots get a real token they never hand out, and authPlayer refuses bot seats outright
    // — otherwise a client could post as a bot's playerId with a null token and act as it.
    token: crypto.randomUUID(),
    name,
    isBot,
    sseRes: null,
    connected: false,
    hand: null,
    assignment: null,
    locked: false
  };
}

function defaultBotName(room) {
  const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
  for (let i = 1; i <= 8; i++) {
    const name = i === 1 ? 'GTO Bot' : `GTO Bot ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return 'GTO Bot';
}

function cleanDisplayName(raw, fallback) {
  return String(raw || '').trim().slice(0, 20) || fallback;
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, connected: p.connected, locked: p.locked, isBot: !!p.isBot };
}

function publicRoomState(room) {
  return {
    code: room.code,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    hostId: room.hostId,
    handNumber: room.handNumber,
    players: room.players.map(publicPlayer),
    cumulative: room.cumulative
  };
}

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* connection may already be closed */ }
}

function broadcast(room, event, data) {
  for (const p of room.players) if (p.sseRes) sendEvent(p.sseRes, event, data);
}

function sendTo(player, event, data) {
  if (player.sseRes) sendEvent(player.sseRes, event, data);
}

function broadcastState(room) {
  broadcast(room, 'room_state', publicRoomState(room));
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function resetForNextHand(room) {
  room.boards = null;
  room.lastResults = null;
  for (const p of room.players) {
    p.hand = null;
    p.assignment = null;
    p.locked = false;
  }
}

function dealNewHand(room) {
  resetForNextHand(room);
  room.handNumber += 1;
  const ids = room.players.map((p) => p.id);
  const { hands, boards } = G.dealHand(ids);
  room.boards = boards;
  room.phase = 'arranging';
  for (const p of room.players) {
    p.hand = hands[p.id];
    p.assignment = null;
    p.locked = false;
    sendTo(p, 'your_hand', { hand: p.hand, assignment: null });
  }
  broadcastState(room);
  runBots(room);
}

// Every path that locks a hand funnels through here. The phase check matters: a bot
// finishing and a human clicking Lock can both observe "everyone is locked", and without
// it the hand would be scored twice.
function maybeFinishHand(room) {
  if (room.phase !== 'arranging') return;
  if (!room.players.every((p) => p.locked)) return;
  finishHand(room);
}

// Each bot solves its own hand off the main path (chunked inside lib/bot.js so the server
// keeps serving everyone else mid-solve), then locks itself in. The handNumber/phase guard
// stops a late solve from a previous hand clobbering the current one.
function runBots(room) {
  const handNumber = room.handNumber;
  for (const bot of room.players.filter((p) => p.isBot)) {
    const hand = bot.hand;
    if (!hand) continue;
    const think = BOT_MIN_THINK_MS + Math.random() * (BOT_MAX_THINK_MS - BOT_MIN_THINK_MS);
    const started = Date.now();
    Bot.chooseSplit(hand, opponentPool())
      .catch(() => Bot.fallbackSplit(hand))
      .then((assignment) => {
        const wait = Math.max(0, think - (Date.now() - started));
        setTimeout(() => {
          if (rooms.get(room.code) !== room) return;
          if (room.phase !== 'arranging' || room.handNumber !== handNumber || bot.locked) return;
          if (G.validateAssignment(bot.hand, assignment)) assignment = Bot.fallbackSplit(bot.hand);
          bot.assignment = assignment;
          bot.locked = true;
          broadcastState(room);
          maybeFinishHand(room);
        }, wait);
      });
  }
}

function finishHand(room) {
  const players = room.players.map((p) => ({ id: p.id, name: p.name, assignment: p.assignment }));
  const { evals, comparisons, pointsByPlayer, homeruns } = G.computeResults(players, room.boards);

  for (const p of room.players) {
    room.cumulative[p.id] = (room.cumulative[p.id] || 0) + pointsByPlayer[p.id];
  }

  const serializedEvals = {};
  for (const p of room.players) {
    serializedEvals[p.id] = {};
    for (const cat of ['one', 'two', 'four']) {
      serializedEvals[p.id][cat] = evals[p.id][cat].map((e) => ({
        category: P.categoryName(e.score),
        score: e.score,
        cards: e.cards
      }));
    }
  }

  room.phase = 'results';
  room.lastResults = {
    boards: room.boards,
    players: room.players.map((p) => ({ id: p.id, name: p.name, hand: p.hand, assignment: p.assignment })),
    evals: serializedEvals,
    comparisons,
    pointsThisHand: pointsByPlayer,
    cumulative: room.cumulative,
    handNumber: room.handNumber,
    labels: G.CATEGORY_LABELS,
    points: G.POINTS,
    homeruns
  };

  broadcast(room, 'results', room.lastResults);
  broadcastState(room);
}

function handleDisconnect(room, player) {
  if (!player) return;
  player.connected = false;
  player.sseRes = null;
  broadcastState(room);
  setTimeout(() => {
    const stillThere = rooms.get(room.code);
    if (stillThere && stillThere.players.every((p) => !p.connected)) {
      rooms.delete(room.code);
    }
  }, 10 * 60 * 1000);
}

// ---------------- HTTP plumbing ----------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('Payload too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function authPlayer(body) {
  const room = rooms.get(String(body.code || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  const player = room.players.find((p) => p.id === body.playerId && p.token === body.token);
  if (!player || player.isBot) return { error: 'Not authorized for this room.' };
  return { room, player };
}

const API_HANDLERS = {
  '/api/create_room': (body) => {
    const cleanName = cleanDisplayName(body.name, 'Host');
    const max = Math.min(4, Math.max(2, Number(body.maxPlayers) || 4));
    const host = makePlayer({ name: cleanName });
    const room = {
      code: makeRoomCode(),
      maxPlayers: max,
      phase: 'lobby',
      hostId: host.id,
      players: [host],
      boards: null,
      handNumber: 0,
      cumulative: { [host.id]: 0 },
      lastResults: null
    };
    // Bots requested at creation fill seats immediately, so a solo host can start a game
    // without waiting for anyone. They're capped to leave at least the host's seat free.
    const wanted = Math.max(0, Math.min(max - 1, Number(body.bots) || 0));
    for (let i = 0; i < wanted; i++) {
      const bot = makePlayer({ name: defaultBotName(room), isBot: true });
      room.players.push(bot);
      room.cumulative[bot.id] = 0;
    }
    rooms.set(room.code, room);
    return { ok: true, code: room.code, playerId: host.id, token: host.token };
  },

  '/api/join_room': (body) => {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return { ok: false, error: 'Room not found.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'That game has already started.' };
    if (room.players.length >= room.maxPlayers) return { ok: false, error: 'Room is full.' };
    const player = makePlayer({ name: cleanDisplayName(body.name, 'Player') });
    room.players.push(player);
    room.cumulative[player.id] = 0;
    broadcastState(room);
    return { ok: true, code: room.code, playerId: player.id, token: player.token };
  },

  '/api/start_game': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (player.id !== room.hostId) return { ok: false, error: 'Only the host can start the game.' };
    if (room.players.length < 2) return { ok: false, error: 'Need at least 2 players.' };
    dealNewHand(room);
    return { ok: true };
  },

  '/api/lock_hand': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (room.phase !== 'arranging') return { ok: false, error: 'Not in arranging phase.' };
    if (player.locked) return { ok: false, error: 'Already locked.' };
    const err = G.validateAssignment(player.hand, body.assignment);
    if (err) return { ok: false, error: err };
    player.assignment = body.assignment;
    player.locked = true;
    broadcastState(room);
    maybeFinishHand(room);
    return { ok: true };
  },

  // ---- bot seats (host only) ----
  // Bots can be added or removed in the lobby, and renamed at any time — renaming is
  // cosmetic, so there's no reason to lock it to a phase.
  '/api/add_bot': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (player.id !== room.hostId) return { ok: false, error: 'Only the host can add bots.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'Bots can only be added in the lobby.' };
    if (room.players.length >= room.maxPlayers) return { ok: false, error: 'Table is full.' };
    const bot = makePlayer({ name: cleanDisplayName(body.name, defaultBotName(room)), isBot: true });
    room.players.push(bot);
    room.cumulative[bot.id] = 0;
    broadcastState(room);
    return { ok: true, botId: bot.id };
  },

  '/api/remove_bot': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (player.id !== room.hostId) return { ok: false, error: 'Only the host can remove bots.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'Bots can only be removed in the lobby.' };
    const idx = room.players.findIndex((p) => p.id === body.botId && p.isBot);
    if (idx === -1) return { ok: false, error: 'No such bot.' };
    const [bot] = room.players.splice(idx, 1);
    delete room.cumulative[bot.id];
    broadcastState(room);
    return { ok: true };
  },

  '/api/rename_bot': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (player.id !== room.hostId) return { ok: false, error: 'Only the host can rename bots.' };
    const bot = room.players.find((p) => p.id === body.botId && p.isBot);
    if (!bot) return { ok: false, error: 'No such bot.' };
    bot.name = cleanDisplayName(body.name, bot.name);
    broadcastState(room);
    return { ok: true, name: bot.name };
  },

  '/api/next_hand': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (player.id !== room.hostId) return { ok: false, error: 'Only the host can deal the next hand.' };
    if (room.phase !== 'results') return { ok: false, error: 'Not ready for next hand.' };
    dealNewHand(room);
    return { ok: true };
  }
};

function handleStream(req, res, parsedUrl) {
  const code = String(parsedUrl.searchParams.get('code') || '').toUpperCase();
  const playerId = parsedUrl.searchParams.get('playerId');
  const token = parsedUrl.searchParams.get('token');
  const room = rooms.get(code);
  if (!room) { res.writeHead(404); res.end('Room not found'); return; }
  const player = findPlayer(room, playerId);
  if (!player || player.token !== token) { res.writeHead(403); res.end('Not authorized'); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('\n');

  player.sseRes = res;
  player.connected = true;
  broadcastState(room);

  // initial snapshot for this connection
  sendEvent(res, 'room_state', publicRoomState(room));
  if (room.phase === 'arranging' && player.hand) {
    sendEvent(res, 'your_hand', { hand: player.hand, assignment: player.assignment });
  }
  if (room.phase === 'results' && room.lastResults) {
    sendEvent(res, 'results', room.lastResults);
  }

  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (player.sseRes === res) handleDisconnect(room, player);
  });
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(500); res.end('Server error'); return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/stream' && req.method === 'GET') {
    handleStream(req, res, parsedUrl);
    return;
  }

  // Serve the hand evaluator straight from lib/ so Practice Mode's client-side EV
  // math (150 board runouts per redo, no server round-trip) runs the exact same
  // code as the server — no separate browser port to keep in sync.
  if (pathname === '/lib/poker.js' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'lib', 'poker.js'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(data);
    });
    return;
  }

  if (pathname.startsWith('/api/') && req.method === 'POST') {
    const handler = API_HANDLERS[pathname];
    if (!handler) { json(res, 404, { ok: false, error: 'Unknown endpoint.' }); return; }
    readJsonBody(req)
      .then((body) => {
        let result;
        try {
          result = handler(body);
        } catch (e) {
          console.error(e);
          result = { ok: false, error: 'Server error.' };
        }
        json(res, 200, result);
      })
      .catch(() => json(res, 400, { ok: false, error: 'Malformed request.' }));
    return;
  }

  if (req.method === 'GET') {
    serveStatic(pathname, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Taiwanese Poker listening on http://localhost:${PORT}`);
});
