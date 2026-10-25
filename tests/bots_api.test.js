// Dependency-free end-to-end test of bot seats over the real HTTP + SSE API.
// Run with: node tests/bots_api.test.js
//
// Starts its own server, creates a room with bots, renames one, and plays a full hand as a
// lone human — which only completes if the bots solve and lock themselves. Also checks a
// bot seat can't be driven by a client, since bots live in the same players array as humans
// and an unguarded lookup would let anyone post as one.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT_TEST || 3999);
const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ hostname: 'localhost', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// One SSE connection per seat, like a real client: the server keeps only the newest stream
// for a player, so a second connection would silently starve the first.
function connect(code, id, token) {
  const seen = [];
  let waiters = [];
  const req = http.get(`http://localhost:${PORT}/api/stream?code=${code}&playerId=${id}&token=${token}`, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString();
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const raw of events) {
        const name = (raw.split('\n').find((l) => l.startsWith('event:')) || '').slice(7).trim();
        const data = (raw.split('\n').find((l) => l.startsWith('data:')) || '').slice(5).trim();
        if (!name) continue;
        const payload = data ? JSON.parse(data) : null;
        seen.push({ name, payload });
        waiters.filter((w) => w.name === name).forEach((w) => { w.done = true; w.resolve(payload); });
        waiters = waiters.filter((w) => !w.done);
      }
    });
  });
  return {
    close: () => req.destroy(),
    wait: (name, ms = 40000) => new Promise((resolve, reject) => {
      const hit = seen.find((e) => e.name === name);
      if (hit) return resolve(hit.payload);
      const w = { name, resolve };
      waiters.push(w);
      setTimeout(() => { if (!w.done) reject(new Error('timed out waiting for ' + name)); }, ms);
    })
  };
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}

(async () => {
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  const cleanup = () => { try { server.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  try {
    await waitForServer(`http://localhost:${PORT}/`);

    // --- bots requested at room creation ---
    const host = await post('/api/create_room', { name: 'Sean', maxPlayers: 4, bots: 2 });
    assert(host.ok, 'room created with bots requested up front');
    const stream = connect(host.code, host.playerId, host.token);
    const lobby = await stream.wait('room_state');
    const bots = lobby.players.filter((p) => p.isBot);
    assert(lobby.players.length === 3, 'bots take real seats at the table');
    assert(bots.length === 2, 'the requested number of bots are seated');
    assert(bots.every((b) => /GTO Bot/.test(b.name)), 'bots get distinct default names');
    assert(new Set(lobby.players.map((p) => p.name)).size === 3, 'no two seats share a name');

    // --- bots are capped so the host always has a seat ---
    const greedy = await post('/api/create_room', { name: 'Solo', maxPlayers: 2, bots: 9 });
    const greedyLobby = connect(greedy.code, greedy.playerId, greedy.token);
    const gl = await greedyLobby.wait('room_state');
    assert(gl.players.length === 2 && gl.players.filter((p) => p.isBot).length === 1,
      'a greedy bot count is capped to the table size, leaving the host a seat');
    greedyLobby.close();

    // --- renaming ---
    const renamed = await post('/api/rename_bot', {
      code: host.code, playerId: host.playerId, token: host.token, botId: bots[0].id, name: 'Deep Stack' });
    assert(renamed.ok && renamed.name === 'Deep Stack', 'host can rename a bot');
    const afterRename = await post('/api/rename_bot', {
      code: host.code, playerId: host.playerId, token: host.token, botId: bots[0].id, name: '   ' });
    assert(afterRename.name === 'Deep Stack', 'a blank rename keeps the previous name');
    const longName = await post('/api/rename_bot', {
      code: host.code, playerId: host.playerId, token: host.token, botId: bots[0].id, name: 'x'.repeat(50) });
    assert(longName.name.length === 20, 'bot names are length-capped like human names');
    await post('/api/rename_bot', { code: host.code, playerId: host.playerId, token: host.token,
      botId: bots[0].id, name: 'Deep Stack' });

    // --- a bot seat is not a client ---
    const impersonate = await post('/api/lock_hand', {
      code: host.code, playerId: bots[0].id, token: null, assignment: null });
    assert(!impersonate.ok && /Not authorized/.test(impersonate.error), 'a client cannot act as a bot seat');

    // --- non-host cannot manage bots ---
    const guest = await post('/api/join_room', { code: host.code, name: 'Guest' });
    assert(guest.ok, 'a human can still join a room that has bots in it');
    const guestAdd = await post('/api/add_bot', { code: host.code, playerId: guest.playerId, token: guest.token });
    assert(!guestAdd.ok && /host/i.test(guestAdd.error), 'only the host can add bots');

    // --- table is full now (4/4): adding another is refused ---
    const full = await post('/api/add_bot', { code: host.code, playerId: host.playerId, token: host.token });
    assert(!full.ok && /full/i.test(full.error), 'bots cannot be added past the table size');

    // --- play a hand: it can only finish if both bots solve and lock themselves ---
    const guestStream = connect(host.code, guest.playerId, guest.token);
    const started = await post('/api/start_game', { code: host.code, playerId: host.playerId, token: host.token });
    assert(started.ok, 'the host can start a game with bots seated' + (started.error ? ' — ' + started.error : ''));
    const mine = await stream.wait('your_hand');
    const theirs = await guestStream.wait('your_hand');
    assert(mine.hand.length === 7 && theirs.hand.length === 7, 'humans are dealt their hands');

    const split = (h) => ({ one: [h[0]], two: h.slice(1, 3), four: h.slice(3, 7) });
    await post('/api/lock_hand', { code: host.code, playerId: host.playerId, token: host.token, assignment: split(mine.hand) });
    await post('/api/lock_hand', { code: host.code, playerId: guest.playerId, token: guest.token, assignment: split(theirs.hand) });

    const results = await stream.wait('results');
    assert(results.players.length === 4, 'bots are scored as normal seats in the results');
    const botResult = results.players.find((p) => p.name === 'Deep Stack');
    assert(!!botResult, 'the renamed bot keeps its name into the results');
    const cards = [...botResult.assignment.one, ...botResult.assignment.two, ...botResult.assignment.four];
    assert(cards.length === 7 && new Set(cards).size === 7, 'the bot played all 7 of its own cards, no duplicates');
    assert(botResult.assignment.one.length === 1 && botResult.assignment.two.length === 2
      && botResult.assignment.four.length === 4, 'the bot played a legal 1/2/4 split');
    const sum = Object.values(results.pointsThisHand).reduce((a, b) => a + b, 0);
    assert(sum === 0, 'scoring stays zero-sum with bots at the table');

    // --- bots can't be added mid-game ---
    const midGame = await post('/api/add_bot', { code: host.code, playerId: host.playerId, token: host.token });
    assert(!midGame.ok, 'bots cannot be added once the game has started');

    stream.close();
    guestStream.close();

    // --- removing a bot in the lobby ---
    const solo = await post('/api/create_room', { name: 'Host', maxPlayers: 4, bots: 2 });
    const soloStream = connect(solo.code, solo.playerId, solo.token);
    const soloLobby = await soloStream.wait('room_state');
    const victim = soloLobby.players.find((p) => p.isBot);
    const removed = await post('/api/remove_bot', { code: solo.code, playerId: solo.playerId, token: solo.token, botId: victim.id });
    assert(removed.ok, 'host can remove a bot in the lobby');
    const bogus = await post('/api/remove_bot', { code: solo.code, playerId: solo.playerId, token: solo.token, botId: solo.playerId });
    assert(!bogus.ok, 'remove_bot refuses to remove a human seat');
    soloStream.close();
  } finally {
    cleanup();
  }

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
