(() => {
  let es = null; // EventSource

  async function api(pathname, body) {
    const res = await fetch(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  function connectStream() {
    if (es) { es.close(); }
    es = new EventSource(`/api/stream?code=${encodeURIComponent(state.code)}&playerId=${encodeURIComponent(state.playerId)}&token=${encodeURIComponent(state.token)}`);
    es.addEventListener('room_state', (e) => handleRoomState(JSON.parse(e.data)));
    es.addEventListener('your_hand', (e) => handleYourHand(JSON.parse(e.data)));
    es.addEventListener('results', (e) => handleResults(JSON.parse(e.data)));
    return es;
  }

  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_CLASS = { s: 'suit-s', h: 'suit-h', d: 'suit-d', c: 'suit-c' }; // 4-color deck: s=black h=red d=blue c=green
  const CAPACITY = { one: 1, two: 2, four: 4 };
  const SLOT_TITLES = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
  const STORAGE_KEY = 'taiwanese-poker-session';

  const el = (id) => document.getElementById(id);
  const show = (id) => el(id).classList.remove('hidden');
  const hide = (id) => el(id).classList.add('hidden');

  const state = {
    code: null,
    playerId: null,
    token: null,
    name: null,
    room: null,
    myHand: null,
    assignment: { one: [], two: [], four: [] },
    selectedCard: null,
    locked: false
  };
  let revealInProgress = false;

  // ---------- card rendering ----------
  function cardEl(card, { size = 'normal', usedInBest = false } = {}) {
    const rank = card[0];
    const suit = card[1];
    const div = document.createElement('div');
    div.className = 'playing-card' + (size === 'small' ? ' small' : '') + ' ' + SUIT_CLASS[suit] + (usedInBest ? ' used-in-best' : '');
    div.dataset.card = card;
    div.innerHTML = `<span class="rank">${rank}</span><span class="suit">${SUIT_SYMBOL[suit]}</span>`;
    return div;
  }

  function cardRow(cards, opts = {}) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.gap = '4px';
    wrap.style.flexWrap = 'wrap';
    cards.forEach((c) => wrap.appendChild(cardEl(c, opts)));
    return wrap;
  }

  // ---------- persistence ----------
  function saveSession() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      code: state.code, playerId: state.playerId, token: state.token, name: state.name
    }));
  }
  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch { return null; }
  }
  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ---------- landing ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
      el('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  function landingError(msg) {
    el('landingError').textContent = msg;
    show('landingError');
  }

  el('btnCreate').addEventListener('click', async () => {
    const name = el('createName').value.trim() || 'Host';
    const maxPlayers = Number(el('createMax').value);
    const homerunMode = el('createHomerun').checked;
    const res = await api('/api/create_room', { name, maxPlayers, homerunMode });
    if (!res.ok) return landingError(res.error);
    state.code = res.code; state.playerId = res.playerId; state.token = res.token; state.name = name;
    saveSession();
    connectStream();
    enterLobby();
  });

  el('btnJoin').addEventListener('click', async () => {
    const name = el('joinName').value.trim() || 'Player';
    const code = el('joinCode').value.trim().toUpperCase();
    if (!code) return landingError('Enter a room code.');
    const res = await api('/api/join_room', { code, name });
    if (!res.ok) return landingError(res.error);
    state.code = res.code; state.playerId = res.playerId; state.token = res.token; state.name = name;
    saveSession();
    connectStream();
    enterLobby();
  });

  // ---------- lobby ----------
  function enterLobby() {
    el('roomCodeLabel').textContent = state.code;
    show('roomBadge');
    el('lobbyCode').textContent = state.code;
    el('shareLink').value = `${location.origin}/?join=${state.code}`;
    ['landing', 'lobby'].forEach((s) => (s === 'lobby' ? show : hide)('screen-' + s));
    hide('screen-game'); hide('screen-results');
  }

  el('btnCopyLink').addEventListener('click', () => {
    el('shareLink').select();
    navigator.clipboard?.writeText(el('shareLink').value).catch(() => {});
  });

  el('btnStart').addEventListener('click', async () => {
    const res = await api('/api/start_game', { code: state.code, playerId: state.playerId, token: state.token });
    if (res && !res.ok) alert(res.error);
  });

  function renderLobby(room) {
    el('lobbyCount').textContent = room.players.length;
    el('lobbyMax').textContent = room.maxPlayers;
    if (room.homerunMode) show('lobbyHomerunBadge'); else hide('lobbyHomerunBadge');
    const list = el('lobbyPlayers');
    list.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = p.name + (p.id === state.playerId ? ' (you)' : '') + (!p.connected ? ' — offline' : '');
      if (!p.connected) label.classList.add('offline');
      li.appendChild(label);
      if (p.id === room.hostId) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'HOST';
        li.appendChild(tag);
      }
      list.appendChild(li);
    });
    const isHost = room.hostId === state.playerId;
    if (isHost && room.players.length >= 2) {
      show('btnStart');
      el('lobbyHint').textContent = '';
    } else {
      hide('btnStart');
      el('lobbyHint').textContent = isHost ? 'Need at least 2 players to start.' : 'Waiting for the host to start the game…';
    }
  }

  // ---------- arranging ----------
  function handleYourHand({ hand, assignment }) {
    state.myHand = hand;
    state.locked = !!assignment;
    state.assignment = assignment ? deepCopy(assignment) : { one: [], two: [], four: [] };
    state.selectedCard = null;
    hide('screen-lobby'); hide('screen-results');
    show('screen-game');
    renderGame();
  }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  function trayCards() {
    const used = new Set([...state.assignment.one, ...state.assignment.two, ...state.assignment.four]);
    return state.myHand.filter((c) => !used.has(c));
  }

  function renderGame() {
    el('handNumber').textContent = state.room ? state.room.handNumber : '';
    if (state.room && state.room.homerunMode) show('gameHomerunTag'); else hide('gameHomerunTag');

    const disabled = state.locked;
    ['one', 'two', 'four'].forEach((slot) => {
      const container = el('slot' + capitalize(slot));
      container.innerHTML = '';
      state.assignment[slot].forEach((c) => {
        const cardNode = cardEl(c);
        if (!disabled) {
          cardNode.addEventListener('click', () => {
            state.assignment[slot] = state.assignment[slot].filter((x) => x !== c);
            state.selectedCard = null;
            renderGame();
          });
        }
        container.appendChild(cardNode);
      });
    });

    const tray = el('tray');
    tray.innerHTML = '';
    if (disabled) {
      const msg = document.createElement('div');
      msg.className = 'hint';
      msg.textContent = 'Hand locked — waiting for other players…';
      tray.appendChild(msg);
    } else {
      trayCards().forEach((c) => {
        const cardNode = cardEl(c);
        if (state.selectedCard === c) cardNode.classList.add('selected');
        cardNode.addEventListener('click', () => {
          state.selectedCard = state.selectedCard === c ? null : c;
          renderGame();
        });
        tray.appendChild(cardNode);
      });
    }

    document.querySelectorAll('.slot').forEach((slotDiv) => {
      slotDiv.onclick = (ev) => {
        if (disabled) return;
        const slot = slotDiv.dataset.slot;
        if (!state.selectedCard) return;
        if (state.assignment[slot].length >= CAPACITY[slot]) return;
        state.assignment[slot].push(state.selectedCard);
        state.selectedCard = null;
        renderGame();
      };
    });

    const allPlaced = trayCards().length === 0
      && state.assignment.one.length === 1
      && state.assignment.two.length === 2
      && state.assignment.four.length === 4;
    el('btnLock').disabled = disabled || !allPlaced;
    el('btnClear').disabled = disabled;

    updateLockStatus();
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  el('btnClear').addEventListener('click', () => {
    state.assignment = { one: [], two: [], four: [] };
    state.selectedCard = null;
    renderGame();
  });

  el('btnLock').addEventListener('click', async () => {
    const res = await api('/api/lock_hand', { code: state.code, playerId: state.playerId, token: state.token, assignment: state.assignment });
    if (!res.ok) {
      el('gameError').textContent = res.error;
      show('gameError');
      return;
    }
    hide('gameError');
    state.locked = true;
    renderGame();
  });

  function updateLockStatus() {
    if (!state.room) return;
    const lockedCount = state.room.players.filter((p) => p.locked).length;
    el('lockStatus').textContent = `${lockedCount}/${state.room.players.length} locked`;
  }

  // ---------- results ----------
  // The full results payload arrives from the server all at once (nothing is hidden),
  // but we reveal it to the player as a staged, timed sequence for drama — roughly a
  // 15-second build-up: boards, then hands, then a live count-through of every
  // comparison, then a final flourish. "Skip" jumps straight to the end state.
  const RESULTS_TARGET_MS = 15000;
  let revealState = null; // { timers: [], cancelled: false }

  function handleResults(results) {
    state.lastResults = results;
    hide('screen-game'); hide('screen-lobby');
    show('screen-results');
    startResultsReveal(results);
  }

  function clearRevealTimers() {
    if (revealState) {
      revealState.timers.forEach((t) => clearTimeout(t));
      revealState.cancelled = true;
    }
  }

  function runQueue(myRevealState, queue) {
    let i = 0;
    function step() {
      if (myRevealState.cancelled || i >= queue.length) return;
      const item = queue[i++];
      const t = setTimeout(() => {
        if (myRevealState.cancelled) return;
        item.run();
        step();
      }, item.delay);
      myRevealState.timers.push(t);
    }
    step();
  }

  function startResultsReveal(r) {
    clearRevealTimers();
    revealState = { timers: [], cancelled: false };
    const myRevealState = revealState;
    revealInProgress = true;

    el('resultsHandNumber').textContent = r.handNumber;
    hide('homerunBanner');
    el('homerunBanner').innerHTML = '';
    el('homerunBanner').classList.remove('reveal');
    el('boardsRow').innerHTML = '';
    el('resultsPlayers').innerHTML = '';
    el('scoreboard').innerHTML = '';
    el('scoreboard').classList.remove('card-reveal');
    el('comparisonLog').innerHTML = '';
    const logDetails = el('comparisonLog').closest('details');
    if (logDetails) logDetails.open = true;
    hide('btnNextHand');
    show('btnSkipReveal');
    el('revealStatus').textContent = 'Revealing Board A…';
    show('revealStatus');

    const nameById = {};
    r.players.forEach((p) => (nameById[p.id] = p.name));

    const queue = [];

    // Stage 1-2: reveal each board's 5 cards one at a time.
    ['Board A', 'Board B'].forEach((label, boardIdx) => {
      queue.push({
        delay: boardIdx === 0 ? 0 : 250,
        run: () => { el('revealStatus').textContent = `Revealing ${label}…`; ensureBoardBlock(boardIdx, label); }
      });
      r.boards[boardIdx].forEach((c) => {
        queue.push({ delay: 220, run: () => appendBoardCard(boardIdx, c) });
      });
    });

    // Stage 3: reveal each player's constructed hands, one player at a time.
    queue.push({ delay: 400, run: () => { el('revealStatus').textContent = 'Revealing hands…'; } });
    r.players.forEach((p) => {
      queue.push({ delay: 450, run: () => appendPlayerPanel(r, p, nameById) });
    });

    // Stage 4: step through every comparison one at a time, updating a live running
    // score next to each player's name as points land.
    const runningPoints = {};
    r.players.forEach((p) => { runningPoints[p.id] = 0; });
    const nComparisons = r.comparisons.length;
    const comparisonDelay = Math.max(90, Math.min(500, Math.round(7000 / nComparisons)));
    queue.push({ delay: 500, run: () => { el('revealStatus').textContent = 'Comparing hands…'; } });
    r.comparisons.forEach((c) => {
      queue.push({
        delay: comparisonDelay,
        run: () => {
          appendComparisonLine(c, nameById);
          if (c.winner) {
            const loser = c.winner === c.playerA ? c.playerB : c.playerA;
            runningPoints[c.winner] += c.points;
            runningPoints[loser] -= c.points;
            updatePlayerScore(c.winner, runningPoints[c.winner]);
            updatePlayerScore(loser, runningPoints[loser]);
          }
        }
      });
    });

    // Padding pause so the whole reveal lands close to RESULTS_TARGET_MS regardless of
    // player count / comparison count, instead of feeling rushed for a 2-player hand.
    const flourishMs = 2200;
    const plannedSoFar = queue.reduce((sum, step) => sum + step.delay, 0);
    const pad = Math.max(0, RESULTS_TARGET_MS - plannedSoFar - flourishMs);
    if (pad > 0) {
      queue.push({ delay: pad, run: () => { el('revealStatus').textContent = 'Tallying final results…'; } });
    }

    // Stage 5: final flourish — homerun banner (if any), then the finished scoreboard.
    const hasHomerun = !!(r.homerunMode && r.homeruns && r.homeruns.length > 0);
    queue.push({ delay: 500, run: () => { if (hasHomerun) showHomerunBanner(r, nameById); } });
    queue.push({ delay: hasHomerun ? 900 : 200, run: () => finishReveal(r) });

    runQueue(myRevealState, queue);
  }

  function ensureBoardBlock(boardIdx, label) {
    const block = document.createElement('div');
    block.className = 'board-block';
    const h = document.createElement('h4');
    h.textContent = label;
    block.appendChild(h);
    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'board-cards';
    cardsDiv.id = 'boardCards' + boardIdx;
    block.appendChild(cardsDiv);
    el('boardsRow').appendChild(block);
  }

  function appendBoardCard(boardIdx, card) {
    const cardsDiv = el('boardCards' + boardIdx);
    const node = cardEl(card);
    node.classList.add('card-reveal');
    cardsDiv.appendChild(node);
  }

  function appendPlayerPanel(r, p, nameById) {
    const box = document.createElement('div');
    box.className = 'player-result card-reveal';

    const head = document.createElement('div');
    head.className = 'player-result-head';
    head.id = 'playerHead-' + p.id;
    const pname = document.createElement('span');
    pname.className = 'pname';
    pname.textContent = p.name + (p.id === state.playerId ? ' (you)' : '');
    const pscore = document.createElement('span');
    pscore.id = 'pscore-' + p.id;
    pscore.className = 'pscore';
    pscore.textContent = '0 this hand';
    head.appendChild(pname);
    head.appendChild(pscore);
    box.appendChild(head);

    ['one', 'two', 'four'].forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'cat-row';

      const labelDiv = document.createElement('div');
      labelDiv.className = 'cat-label';
      labelDiv.textContent = SLOT_TITLES[cat];
      row.appendChild(labelDiv);

      [0, 1].forEach((boardIndex) => {
        const evalInfo = r.evals[p.id][cat][boardIndex];
        const cell = document.createElement('div');
        cell.className = 'board-eval';
        const catName = document.createElement('span');
        catName.className = 'cat-name';
        catName.textContent = (boardIndex === 0 ? 'Board A: ' : 'Board B: ') + evalInfo.category;
        cell.appendChild(catName);
        const usedSet = new Set(evalInfo.cards);
        const handCardsRow = cardRow(p.assignment[cat], { size: 'small' });
        [...handCardsRow.children].forEach((child, idx) => {
          if (usedSet.has(p.assignment[cat][idx])) child.classList.add('used-in-best');
        });
        cell.appendChild(handCardsRow);
        row.appendChild(cell);
      });

      box.appendChild(row);
    });

    el('resultsPlayers').appendChild(box);
  }

  function updatePlayerScore(id, pts) {
    const span = el('pscore-' + id);
    if (!span) return;
    span.className = 'pscore ' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '');
    span.textContent = fmtSigned(pts) + ' this hand';
  }

  function appendComparisonLine(c, nameById) {
    const log = el('comparisonLog');
    const boardLabel = c.boardIndex === 0 ? 'Board A' : 'Board B';
    const catLabel = SLOT_TITLES[c.category];
    const line = document.createElement('div');
    line.className = 'log-reveal';
    if (!c.winner) {
      line.classList.add('push');
      line.textContent = `${nameById[c.playerA]} vs ${nameById[c.playerB]} — ${catLabel} on ${boardLabel}: push (no points)`;
    } else {
      const loserName = c.winner === c.playerA ? nameById[c.playerB] : nameById[c.playerA];
      line.textContent = `${nameById[c.winner]} beat ${loserName} — ${catLabel} on ${boardLabel}: +${c.points}`;
    }
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function showHomerunBanner(r, nameById) {
    const banner = el('homerunBanner');
    banner.textContent = '';
    r.homeruns.forEach((h, i) => {
      if (i > 0) banner.appendChild(document.createElement('br'));
      const loserId = h.winner === h.playerA ? h.playerB : h.playerA;
      const text = `⚾ ${nameById[h.winner]} hit a HOMERUN — swept all 6 comparisons (both boards) vs ${nameById[loserId]} (double points!)`;
      banner.appendChild(document.createTextNode(text));
    });
    banner.classList.remove('hidden');
    banner.classList.add('reveal');

    r.homeruns.forEach((h) => {
      const head = el('playerHead-' + h.winner);
      if (!head || head.querySelector('.homerun-tag')) return;
      const hrCount = r.homeruns.filter((hh) => hh.winner === h.winner).length;
      const tag = document.createElement('span');
      tag.className = 'homerun-tag';
      tag.textContent = `⚾ HOMERUN${hrCount > 1 ? ' x' + hrCount : ''}`;
      head.querySelector('.pname').after(tag);
    });
  }

  function finishReveal(r) {
    revealInProgress = false;
    hide('revealStatus');
    hide('btnSkipReveal');

    // Force every displayed score to the authoritative final total — guards against any
    // drift in the live running tally and guarantees the numbers match the server exactly.
    r.players.forEach((p) => updatePlayerScore(p.id, r.pointsThisHand[p.id]));

    const table = el('scoreboard');
    const sorted = [...r.players].sort((a, b) => r.cumulative[b.id] - r.cumulative[a.id]);
    table.innerHTML = '<tr><th>Player</th><th>This Hand</th><th>Total</th></tr>' + sorted.map((p) => `
      <tr>
        <td>${escapeHtml(p.name)}${p.id === state.playerId ? ' (you)' : ''}</td>
        <td>${fmtSigned(r.pointsThisHand[p.id])}</td>
        <td><strong>${fmtSigned(r.cumulative[p.id])}</strong></td>
      </tr>
    `).join('');
    table.classList.add('card-reveal');

    const isHost = state.room && state.room.hostId === state.playerId;
    if (isHost) show('btnNextHand'); else hide('btnNextHand');
  }

  function fastForwardResults(r) {
    const nameById = {};
    r.players.forEach((p) => (nameById[p.id] = p.name));

    el('boardsRow').innerHTML = '';
    el('resultsPlayers').innerHTML = '';
    el('comparisonLog').innerHTML = '';

    ['Board A', 'Board B'].forEach((label, i) => {
      ensureBoardBlock(i, label);
      r.boards[i].forEach((c) => appendBoardCard(i, c));
    });
    r.players.forEach((p) => appendPlayerPanel(r, p, nameById));
    r.comparisons.forEach((c) => appendComparisonLine(c, nameById));

    const hasHomerun = !!(r.homerunMode && r.homeruns && r.homeruns.length > 0);
    if (hasHomerun) showHomerunBanner(r, nameById); else hide('homerunBanner');

    finishReveal(r);
  }

  function fmtSigned(n) { return (n > 0 ? '+' : '') + n; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  el('btnSkipReveal').addEventListener('click', () => {
    if (!state.lastResults) return;
    clearRevealTimers();
    fastForwardResults(state.lastResults);
  });

  el('btnNextHand').addEventListener('click', async () => {
    const res = await api('/api/next_hand', { code: state.code, playerId: state.playerId, token: state.token });
    if (res && !res.ok) alert(res.error);
  });

  // ---------- shared room state ----------
  function handleRoomState(room) {
    state.room = room;
    if (room.phase === 'lobby') {
      enterLobby();
      renderLobby(room);
    } else if (room.phase === 'arranging') {
      updateLockStatus();
    } else if (room.phase === 'results') {
      if (revealInProgress) return; // don't let a late room_state event show the button mid-reveal
      const isHost = room.hostId === state.playerId;
      if (isHost) show('btnNextHand'); else hide('btnNextHand');
    }
  }

  // ---------- boot / rejoin ----------
  const params = new URLSearchParams(location.search);
  const joinParam = params.get('join');
  if (joinParam) el('joinCode').value = joinParam.toUpperCase();
  if (joinParam) document.querySelector('.tab-btn[data-tab="join"]').click();

  const saved = loadSession();
  if (saved && saved.code && saved.playerId && saved.token) {
    state.code = saved.code; state.playerId = saved.playerId; state.token = saved.token; state.name = saved.name;
    let succeeded = false;
    const stream = connectStream();
    stream.addEventListener('room_state', () => { succeeded = true; }, { once: true });
    stream.onerror = () => {
      if (!succeeded) { clearSession(); state.code = null; state.playerId = null; state.token = null; stream.close(); }
    };
  }
})();
