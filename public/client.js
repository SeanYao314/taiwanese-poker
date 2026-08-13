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
        cardNode.addEventListener('click', (ev) => {
          if (ev.metaKey || ev.ctrlKey) {
            placeInFirstOpenSlot(state.assignment, c);
            state.selectedCard = null;
            renderGame();
            return;
          }
          state.selectedCard = state.selectedCard === c ? null : c;
          renderGame();
        });
        tray.appendChild(cardNode);
      });
    }

    document.querySelectorAll('#screen-game .slot').forEach((slotDiv) => {
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

  // ⌘/Ctrl+click a tray card to skip the select-then-click-a-slot dance — drops it
  // straight into the first slot (left to right: 1-card, 2-card, 4-card) that still has
  // room. No-ops if every slot is already full. Shared by both the live game and
  // Practice Mode, which each keep their own separate assignment object.
  function placeInFirstOpenSlot(assignment, card) {
    for (const slot of ['one', 'two', 'four']) {
      if (assignment[slot].length < CAPACITY[slot]) {
        assignment[slot].push(card);
        return true;
      }
    }
    return false;
  }

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
  // but we reveal it to the player as a staged, timed "sweat" sequence: hole cards are
  // shown first (like a showdown), then each board is run one at a time — cards land,
  // then what everyone made on that board is revealed, then every comparison for that
  // board is stepped through live with the point swing posted right on the hand it
  // came from. Total runtime targets ~15s for a heads-up hand and scales up naturally
  // for more players/comparisons. "Skip" jumps straight to the end state.
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
    el('revealStatus').textContent = 'Hands are in…';
    show('revealStatus');

    const nameById = {};
    r.players.forEach((p) => (nameById[p.id] = p.name));

    const queue = [];
    const runningPoints = {};
    const cellPoints = {};
    r.players.forEach((p) => { runningPoints[p.id] = 0; });

    // Stage 0: show everyone's hole cards, split into their 1/2/4 slots — before either
    // board is even shown, so you can feel out who has what to work with.
    r.players.forEach((p) => {
      queue.push({ delay: 450, run: () => appendPlayerSkeleton(r, p) });
    });

    // Stages 1-3, run once per board: reveal that board's cards, reveal what everyone
    // made on it, then step through that board's comparisons live with point swings
    // posted on the spot.
    function queueBoardStages(boardIdx, label) {
      const comparisonsForBoard = r.comparisons.filter((c) => c.boardIndex === boardIdx);

      queue.push({
        delay: 500,
        run: () => { el('revealStatus').textContent = `Revealing ${label}…`; ensureBoardBlock(boardIdx, label); }
      });
      r.boards[boardIdx].forEach((c) => {
        queue.push({ delay: 220, run: () => appendBoardCard(boardIdx, c) });
      });

      queue.push({ delay: 400, run: () => { el('revealStatus').textContent = `What's everyone making on ${label}?`; } });
      r.players.forEach((p) => {
        ['one', 'two', 'four'].forEach((cat) => {
          queue.push({ delay: 180, run: () => revealPlayerBoardHand(r, p, cat, boardIdx) });
        });
      });

      const nComp = Math.max(comparisonsForBoard.length, 1);
      const compDelay = Math.max(90, Math.min(500, Math.round(3200 / nComp)));
      queue.push({ delay: 450, run: () => { el('revealStatus').textContent = `Comparing ${label}…`; } });
      comparisonsForBoard.forEach((c) => {
        queue.push({
          delay: compDelay,
          run: () => {
            appendComparisonLine(c, nameById);
            if (c.winner) {
              const loser = c.winner === c.playerA ? c.playerB : c.playerA;
              runningPoints[c.winner] += c.points;
              runningPoints[loser] -= c.points;
              updatePlayerScore(c.winner, runningPoints[c.winner]);
              updatePlayerScore(loser, runningPoints[loser]);
              bumpCellPoints(cellPoints, c.winner, c.category, c.boardIndex, c.points);
              bumpCellPoints(cellPoints, loser, c.category, c.boardIndex, -c.points);
            }
          }
        });
      });
    }

    queueBoardStages(0, 'Board A');
    queueBoardStages(1, 'Board B');

    // Padding pause so the whole reveal lands close to RESULTS_TARGET_MS for a typical
    // heads-up hand, instead of feeling rushed — bigger hands (more players/comparisons)
    // naturally run longer on their own and just skip the padding.
    const flourishMs = 2200;
    const plannedSoFar = queue.reduce((sum, step) => sum + step.delay, 0);
    const pad = Math.max(0, RESULTS_TARGET_MS - plannedSoFar - flourishMs);
    if (pad > 0) {
      queue.push({ delay: pad, run: () => { el('revealStatus').textContent = 'Tallying final results…'; } });
    }

    // Final flourish — homerun banner (if any), then the finished scoreboard.
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

  // Stage 0: player's box with just their hole cards (1/2/4 slots), plus empty
  // pending placeholders for each board's eventual hand-type + points.
  function appendPlayerSkeleton(r, p) {
    const box = document.createElement('div');
    box.className = 'player-result card-reveal';
    box.id = 'playerResult-' + p.id;

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

    const preview = document.createElement('div');
    preview.className = 'hole-cards-preview';
    ['one', 'two', 'four'].forEach((cat) => {
      const group = document.createElement('span');
      group.className = 'hc-group';
      const lbl = document.createElement('span');
      lbl.className = 'hc-label';
      lbl.textContent = SLOT_TITLES[cat] + ':';
      group.appendChild(lbl);
      group.appendChild(cardRow(p.assignment[cat], { size: 'small' }));
      preview.appendChild(group);
    });
    box.appendChild(preview);

    ['one', 'two', 'four'].forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'cat-row';

      const labelDiv = document.createElement('div');
      labelDiv.className = 'cat-label';
      labelDiv.textContent = SLOT_TITLES[cat];
      row.appendChild(labelDiv);

      [0, 1].forEach((boardIndex) => {
        const cell = document.createElement('div');
        cell.className = 'board-eval';
        cell.id = 'boardEval-' + p.id + '-' + cat + '-' + boardIndex;
        const catName = document.createElement('span');
        catName.className = 'cat-name pending';
        catName.textContent = (boardIndex === 0 ? 'Board A: ' : 'Board B: ') + '…';
        cell.appendChild(catName);
        const ptsBadge = document.createElement('span');
        ptsBadge.className = 'cell-points hidden';
        ptsBadge.id = 'cellPts-' + p.id + '-' + cat + '-' + boardIndex;
        cell.appendChild(ptsBadge);
        row.appendChild(cell);
      });

      box.appendChild(row);
    });

    el('resultsPlayers').appendChild(box);
  }

  // Stage 2: fill in what a player made in one category on one board, once that
  // board's cards are known — replaces the "…" placeholder with the real category
  // name and the highlighted cards that made it.
  function revealPlayerBoardHand(r, p, cat, boardIndex) {
    const evalInfo = r.evals[p.id][cat][boardIndex];
    const cell = el('boardEval-' + p.id + '-' + cat + '-' + boardIndex);
    if (!cell) return;
    const catName = cell.querySelector('.cat-name');
    catName.classList.remove('pending');
    catName.textContent = (boardIndex === 0 ? 'Board A: ' : 'Board B: ') + evalInfo.category;
    const usedSet = new Set(evalInfo.cards);
    const handCardsRow = cardRow(p.assignment[cat], { size: 'small' });
    [...handCardsRow.children].forEach((child, idx) => {
      if (usedSet.has(p.assignment[cat][idx])) child.classList.add('used-in-best');
    });
    cell.insertBefore(handCardsRow, cell.querySelector('.cell-points'));
    cell.classList.add('card-reveal');
  }

  function updatePlayerScore(id, pts) {
    const span = el('pscore-' + id);
    if (!span) return;
    span.className = 'pscore ' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '');
    span.textContent = fmtSigned(pts) + ' this hand';
  }

  // Stage 3: post the point swing directly on the (player, category, board) cell it
  // came from, accumulating if that player has multiple opponents at the table.
  function bumpCellPoints(cellPoints, playerId, cat, boardIndex, delta) {
    cellPoints[playerId] = cellPoints[playerId] || {};
    cellPoints[playerId][cat] = cellPoints[playerId][cat] || {};
    const current = (cellPoints[playerId][cat][boardIndex] || 0) + delta;
    cellPoints[playerId][cat][boardIndex] = current;

    const badge = el('cellPts-' + playerId + '-' + cat + '-' + boardIndex);
    if (badge) {
      badge.classList.remove('hidden', 'flash');
      badge.textContent = fmtSigned(current);
      badge.className = 'cell-points ' + (current > 0 ? 'pos' : current < 0 ? 'neg' : 'even');
      void badge.offsetWidth; // restart the flash animation even if it fires again
      badge.classList.add('flash');
    }

    const cell = el('boardEval-' + playerId + '-' + cat + '-' + boardIndex);
    if (cell) {
      cell.classList.remove('cell-pos', 'cell-neg', 'cell-even');
      cell.classList.add(current > 0 ? 'cell-pos' : current < 0 ? 'cell-neg' : 'cell-even');
    }
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

    // Force every displayed score and per-cell point badge to the authoritative final
    // values — guards against any drift in the live running tally and guarantees the
    // numbers match the server exactly.
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

    r.players.forEach((p) => appendPlayerSkeleton(r, p));

    const cellPoints = {};
    [0, 1].forEach((boardIdx) => {
      const label = boardIdx === 0 ? 'Board A' : 'Board B';
      ensureBoardBlock(boardIdx, label);
      r.boards[boardIdx].forEach((c) => appendBoardCard(boardIdx, c));
      r.players.forEach((p) => {
        ['one', 'two', 'four'].forEach((cat) => revealPlayerBoardHand(r, p, cat, boardIdx));
      });
      r.comparisons.filter((c) => c.boardIndex === boardIdx).forEach((c) => {
        appendComparisonLine(c, nameById);
        if (c.winner) {
          const loser = c.winner === c.playerA ? c.playerB : c.playerA;
          bumpCellPoints(cellPoints, c.winner, c.category, c.boardIndex, c.points);
          bumpCellPoints(cellPoints, loser, c.category, c.boardIndex, -c.points);
        }
      });
    });

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

  // ---------- practice mode ----------
  // Entirely client-side after the initial pool fetch: no server round-trip per redo.
  // The "opponent" for each of the 150 trials is a (hand, split) pair pulled from
  // opponent-pool.json — hands whose blind split was solved offline via the iterative
  // best-response bootstrap documented in experiments/solve/. Re-arranging your own
  // hand re-scores instantly against the SAME 150 trials, so EV differences between
  // your attempts are directly comparable (no fresh variance each redo).
  const PRACTICE_TRIALS = 150;
  const PRACTICE_POINTS = { one: 1, two: 2, four: 3 };
  let opponentPool = null; // cached after first fetch
  let practice = null; // { hand, trials, assignment, selectedCard, saved: [] }

  async function loadOpponentPool() {
    if (opponentPool) return opponentPool;
    const res = await fetch('/opponent-pool.json');
    opponentPool = await res.json();
    return opponentPool;
  }

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildPracticeTrials(playerHand, pool) {
    const playerSet = new Set(playerHand);
    const qualifying = pool.filter((entry) => {
      const oppHand = [...entry.one, ...entry.two, ...entry.four];
      return oppHand.every((c) => !playerSet.has(c));
    });

    let chosen;
    if (qualifying.length >= PRACTICE_TRIALS) {
      chosen = shuffleArray(qualifying).slice(0, PRACTICE_TRIALS);
    } else {
      // Extremely unlikely (expected ~300+ qualify out of 1120), but fall back to
      // sampling with replacement rather than ever reusing a card within a trial.
      chosen = [];
      for (let i = 0; i < PRACTICE_TRIALS; i++) {
        chosen.push(qualifying[Math.floor(Math.random() * qualifying.length)] || pool[i % pool.length]);
      }
    }

    return chosen.map((entry) => {
      const oppHand = [...entry.one, ...entry.two, ...entry.four];
      const oppSet = new Set([...playerHand, ...oppHand]);
      const remaining = shuffleArray(window.Poker.freshDeck().filter((c) => !oppSet.has(c)));
      const boardA = remaining.slice(0, 5);
      const boardB = remaining.slice(5, 10);
      return { oppSplit: entry, boardA, boardB };
    });
  }

  async function startPractice() {
    hide('screen-landing');
    show('screen-practice');
    el('practiceEvPanel').classList.add('hidden');
    el('practiceSlots').querySelectorAll('.slot-cards').forEach((n) => (n.innerHTML = ''));
    el('pTray').innerHTML = '<div class="hint">Loading opponent pool…</div>';

    const pool = await loadOpponentPool();
    const hand = window.Poker.shuffle(window.Poker.freshDeck()).slice(0, 7);
    const trials = buildPracticeTrials(hand, pool);

    practice = {
      hand,
      trials,
      assignment: { one: [], two: [], four: [] },
      selectedCard: null,
      saved: [],
      ideal: null
    };
    el('practiceIdealPanel').classList.add('hidden');
    const idealBtn = el('btnPracticeIdeal');
    idealBtn.disabled = false;
    idealBtn.textContent = 'Show Ideal Split';
    renderPracticeArranger();
    renderPracticeSaved();
  }

  function practiceTrayCards() {
    const used = new Set([...practice.assignment.one, ...practice.assignment.two, ...practice.assignment.four]);
    return practice.hand.filter((c) => !used.has(c));
  }

  function renderPracticeArranger() {
    hide('practiceError');
    ['one', 'two', 'four'].forEach((slot) => {
      const container = el('pSlot' + capitalize(slot));
      container.innerHTML = '';
      practice.assignment[slot].forEach((c) => {
        const cardNode = cardEl(c);
        cardNode.addEventListener('click', () => {
          practice.assignment[slot] = practice.assignment[slot].filter((x) => x !== c);
          practice.selectedCard = null;
          renderPracticeArranger();
        });
        container.appendChild(cardNode);
      });
    });

    const tray = el('pTray');
    tray.innerHTML = '';
    practiceTrayCards().forEach((c) => {
      const cardNode = cardEl(c);
      if (practice.selectedCard === c) cardNode.classList.add('selected');
      cardNode.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey) {
          placeInFirstOpenSlot(practice.assignment, c);
          practice.selectedCard = null;
          renderPracticeArranger();
          return;
        }
        practice.selectedCard = practice.selectedCard === c ? null : c;
        renderPracticeArranger();
      });
      tray.appendChild(cardNode);
    });

    document.querySelectorAll('#practiceSlots .slot').forEach((slotDiv) => {
      slotDiv.onclick = () => {
        const slot = slotDiv.dataset.slot;
        if (!practice.selectedCard) return;
        if (practice.assignment[slot].length >= CAPACITY[slot]) return;
        practice.assignment[slot].push(practice.selectedCard);
        practice.selectedCard = null;
        renderPracticeArranger();
      };
    });

    const complete = practiceTrayCards().length === 0
      && practice.assignment.one.length === 1
      && practice.assignment.two.length === 2
      && practice.assignment.four.length === 4;
    el('btnPracticeSave').disabled = !complete;

    if (complete) {
      runPracticeEval();
    } else {
      el('practiceEvPanel').classList.add('hidden');
    }
  }

  el('btnPracticeClear').addEventListener('click', () => {
    if (!practice) return;
    practice.assignment = { one: [], two: [], four: [] };
    practice.selectedCard = null;
    renderPracticeArranger();
  });

  function evalHandOnBoard(cards, board, cat) {
    return cat === 'four' ? window.Poker.bestPLO(cards, board) : window.Poker.bestGeneric(cards, board);
  }

  // Score `assignment` against one trial's fixed opponent + boards. Returns the point
  // swing for each of the 6 (category, board) cells plus the total.
  function scoreTrial(assignment, trial) {
    const cells = { one: [0, 0], two: [0, 0], four: [0, 0] };
    let total = 0;
    ['one', 'two', 'four'].forEach((cat) => {
      [trial.boardA, trial.boardB].forEach((board, bi) => {
        const mine = evalHandOnBoard(assignment[cat], board, cat);
        const theirs = evalHandOnBoard(trial.oppSplit[cat], board, cat);
        const cmp = window.Poker.compareScores(mine.score, theirs.score);
        const pts = PRACTICE_POINTS[cat];
        const delta = cmp > 0 ? pts : cmp < 0 ? -pts : 0;
        cells[cat][bi] = delta;
        total += delta;
      });
    });
    return { total, cells };
  }

  // Runs the current arrangement through all 150 trials — cheap, pure client-side
  // evaluate5() calls, no network — so this can fire on every completed arrangement.
  function evalAssignmentAcrossTrials(assignment, trials) {
    let sumTotal = 0;
    const sumCells = { one: [0, 0], two: [0, 0], four: [0, 0] };
    trials.forEach((trial) => {
      const r = scoreTrial(assignment, trial);
      sumTotal += r.total;
      ['one', 'two', 'four'].forEach((cat) => {
        sumCells[cat][0] += r.cells[cat][0];
        sumCells[cat][1] += r.cells[cat][1];
      });
    });
    const n = trials.length;
    const avgCells = {};
    ['one', 'two', 'four'].forEach((cat) => {
      avgCells[cat] = [sumCells[cat][0] / n, sumCells[cat][1] / n];
    });
    return { avgTotal: sumTotal / n, avgCells };
  }

  function fmtEv(n) { return (n > 0 ? '+' : '') + n.toFixed(2); }

  function runPracticeEval() {
    const { avgTotal, avgCells } = evalAssignmentAcrossTrials(practice.assignment, practice.trials);
    practice.lastEv = { avgTotal, avgCells };
    renderPracticeEV(avgTotal, avgCells);
  }

  function renderPracticeEV(avgTotal, avgCells) {
    el('practiceTrialCount').textContent = practice.trials.length;
    const totalSpan = el('practiceEvTotal');
    totalSpan.textContent = fmtEv(avgTotal);
    totalSpan.className = 'pscore ' + (avgTotal > 0 ? 'pos' : avgTotal < 0 ? 'neg' : '');

    const breakdown = el('practiceEvBreakdown');
    breakdown.innerHTML = '';
    ['one', 'two', 'four'].forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'pcat-row';
      const label = document.createElement('div');
      label.className = 'pcat-label';
      label.textContent = SLOT_TITLES[cat];
      row.appendChild(label);
      [0, 1].forEach((bi) => {
        const v = avgCells[cat][bi];
        const cell = document.createElement('div');
        cell.innerHTML = `<span class="pcell-sub">${bi === 0 ? 'Board A' : 'Board B'}: </span><span class="pcell ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'even'}">${fmtEv(v)}</span>`;
        row.appendChild(cell);
      });
      breakdown.appendChild(row);
    });

    el('practiceEvPanel').classList.remove('hidden');
  }

  // ---------- practice mode: "Show Ideal Split" ----------
  // Exhaustively scores all 105 ways to split the 7 practice cards against the SAME 150
  // trials used everywhere else in this session, and returns the best one. A naive version
  // of this (105 partitions x 150 trials, re-evaluating the opponent from scratch every
  // time) takes ~15s in this codebase; benchmarked and confirmed correct, this version
  // hoists the opponent's evaluation out of the partition loop (it doesn't depend on which
  // partition we're testing) and shares the expensive 4-card PLO evaluation across the 3
  // partitions that happen to use the same 4-card subset — same results, ~4x faster.
  function allPartitions(cards) {
    const partitions = [];
    const oneCombos = window.Poker.combinations(cards, 1);
    for (const one of oneCombos) {
      const rest6 = cards.filter((c) => !one.includes(c));
      const twoCombos = window.Poker.combinations(rest6, 2);
      for (const two of twoCombos) {
        const four = rest6.filter((c) => !two.includes(c));
        partitions.push({ one, two, four });
      }
    }
    return partitions;
  }

  function findIdealSplit(hand, trials) {
    const Poker = window.Poker;
    const partitions = allPartitions(hand);

    const oppCache = trials.map((trial) => ({
      one: [
        evalHandOnBoard(trial.oppSplit.one, trial.boardA, 'one').score,
        evalHandOnBoard(trial.oppSplit.one, trial.boardB, 'one').score
      ],
      two: [
        evalHandOnBoard(trial.oppSplit.two, trial.boardA, 'two').score,
        evalHandOnBoard(trial.oppSplit.two, trial.boardB, 'two').score
      ],
      four: [
        evalHandOnBoard(trial.oppSplit.four, trial.boardA, 'four').score,
        evalHandOnBoard(trial.oppSplit.four, trial.boardB, 'four').score
      ]
    }));

    const fourGroups = new Map();
    partitions.forEach((part, idx) => {
      const key = [...part.four].sort().join(',');
      if (!fourGroups.has(key)) fourGroups.set(key, { four: part.four, members: [] });
      fourGroups.get(key).members.push(idx);
    });

    const totals = new Float64Array(partitions.length);
    for (let ti = 0; ti < trials.length; ti++) {
      const oc = oppCache[ti];
      const trial = trials[ti];
      for (const { four, members } of fourGroups.values()) {
        const fourA = Poker.bestPLO(four, trial.boardA).score;
        const fourB = Poker.bestPLO(four, trial.boardB).score;
        const cmpA = Poker.compareScores(fourA, oc.four[0]);
        const cmpB = Poker.compareScores(fourB, oc.four[1]);
        const fourPts = (cmpA > 0 ? 3 : cmpA < 0 ? -3 : 0) + (cmpB > 0 ? 3 : cmpB < 0 ? -3 : 0);
        for (const idx of members) {
          const part = partitions[idx];
          const oneA = Poker.bestGeneric(part.one, trial.boardA).score;
          const oneB = Poker.bestGeneric(part.one, trial.boardB).score;
          const twoA = Poker.bestGeneric(part.two, trial.boardA).score;
          const twoB = Poker.bestGeneric(part.two, trial.boardB).score;
          const c1a = Poker.compareScores(oneA, oc.one[0]);
          const c1b = Poker.compareScores(oneB, oc.one[1]);
          const c2a = Poker.compareScores(twoA, oc.two[0]);
          const c2b = Poker.compareScores(twoB, oc.two[1]);
          const pts = (c1a > 0 ? 1 : c1a < 0 ? -1 : 0) + (c1b > 0 ? 1 : c1b < 0 ? -1 : 0)
            + (c2a > 0 ? 2 : c2a < 0 ? -2 : 0) + (c2b > 0 ? 2 : c2b < 0 ? -2 : 0) + fourPts;
          totals[idx] += pts;
        }
      }
    }

    let bestIdx = 0;
    for (let i = 1; i < partitions.length; i++) {
      if (totals[i] > totals[bestIdx]) bestIdx = i;
    }
    const bestPartition = partitions[bestIdx];
    // Re-derive the same {avgTotal, avgCells} shape the rest of the UI expects, via the
    // standard (now single-partition, so cheap) evaluator — guarantees the displayed
    // number matches exactly what re-running that split manually would show.
    const { avgTotal, avgCells } = evalAssignmentAcrossTrials(bestPartition, trials);
    return { assignment: bestPartition, avgTotal, avgCells };
  }

  function renderPracticeIdeal(ideal) {
    const cardsWrap = el('practiceIdealCards');
    cardsWrap.innerHTML = '';
    const catShortLabel = { one: '1-Card:', two: '2-Card:', four: '4-Card:' };
    ['one', 'two', 'four'].forEach((cat) => {
      const group = document.createElement('span');
      group.className = 'hc-group';
      const lbl = document.createElement('span');
      lbl.className = 'hc-label';
      lbl.textContent = catShortLabel[cat];
      group.appendChild(lbl);
      group.appendChild(cardRow(ideal.assignment[cat], { size: 'small' }));
      cardsWrap.appendChild(group);
    });

    const evSpan = el('practiceIdealEv');
    evSpan.textContent = fmtEv(ideal.avgTotal);
    evSpan.className = 'pscore ' + (ideal.avgTotal > 0 ? 'pos' : ideal.avgTotal < 0 ? 'neg' : '');

    el('practiceIdealPanel').classList.remove('hidden');
  }

  el('btnPracticeIdeal').addEventListener('click', () => {
    if (!practice) return;
    if (practice.ideal) { renderPracticeIdeal(practice.ideal); return; }

    const btn = el('btnPracticeIdeal');
    btn.disabled = true;
    btn.textContent = 'Calculating… (checking all 105 splits)';
    // Defer so the "Calculating…" label actually paints before the ~1-4s synchronous
    // search runs (this blocks the main thread — there's no free lunch for exhaustive
    // search in a single-threaded browser tab, but a few seconds for a one-off "show me
    // the answer" click is a reasonable trade for exactness over the full 150 boards).
    setTimeout(() => {
      practice.ideal = findIdealSplit(practice.hand, practice.trials);
      btn.disabled = false;
      btn.textContent = 'Show Ideal Split';
      renderPracticeIdeal(practice.ideal);
    }, 30);
  });

  el('btnPracticeLoadIdeal').addEventListener('click', () => {
    if (!practice || !practice.ideal) return;
    practice.assignment = deepCopy(practice.ideal.assignment);
    practice.selectedCard = null;
    renderPracticeArranger();
  });

  el('btnPracticeSave').addEventListener('click', () => {
    if (!practice || !practice.lastEv) return;
    const key = fmtAssignmentKey(practice.assignment);
    if (practice.saved.some((s) => s.key === key)) {
      el('practiceError').textContent = "You've already saved this exact split.";
      show('practiceError');
      return;
    }
    hide('practiceError');
    practice.saved.push({
      key,
      assignment: deepCopy(practice.assignment),
      avgTotal: practice.lastEv.avgTotal,
      avgCells: practice.lastEv.avgCells
    });
    renderPracticeSaved();
  });

  function fmtAssignmentKey(a) {
    return ['one', 'two', 'four'].map((c) => c + ':' + [...a[c]].sort().join(',')).join('|');
  }

  function renderPracticeSaved() {
    const list = el('practiceSaved');
    list.innerHTML = '';
    if (!practice || practice.saved.length === 0) {
      show('practiceSavedEmpty');
      return;
    }
    hide('practiceSavedEmpty');

    const sorted = [...practice.saved].sort((a, b) => b.avgTotal - a.avgTotal);
    sorted.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'practice-saved-item' + (i === 0 ? ' best' : '');

      const rank = document.createElement('div');
      rank.className = 'psi-rank';
      rank.textContent = '#' + (i + 1);
      item.appendChild(rank);

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'psi-cards';
      const catShortLabel = { one: '1:', two: '2:', four: '4:' };
      ['one', 'two', 'four'].forEach((cat) => {
        const group = document.createElement('span');
        group.className = 'psi-group';
        const lbl = document.createElement('span');
        lbl.className = 'hc-label';
        lbl.textContent = catShortLabel[cat];
        group.appendChild(lbl);
        group.appendChild(cardRow(s.assignment[cat], { size: 'small' }));
        cardsWrap.appendChild(group);
      });
      item.appendChild(cardsWrap);

      const ev = document.createElement('div');
      ev.className = 'psi-ev ' + (s.avgTotal > 0 ? 'pos' : s.avgTotal < 0 ? 'neg' : '');
      ev.textContent = fmtEv(s.avgTotal) + ' EV';
      item.appendChild(ev);

      const actions = document.createElement('div');
      actions.className = 'psi-actions';
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => {
        practice.assignment = deepCopy(s.assignment);
        practice.selectedCard = null;
        renderPracticeArranger();
      });
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        practice.saved = practice.saved.filter((x) => x.key !== s.key);
        renderPracticeSaved();
      });
      actions.appendChild(loadBtn);
      actions.appendChild(removeBtn);
      item.appendChild(actions);

      list.appendChild(item);
    });
  }

  el('btnPracticeStart').addEventListener('click', () => { startPractice(); });
  el('btnPracticeNewHand').addEventListener('click', () => { startPractice(); });
  el('btnPracticeBack').addEventListener('click', () => {
    hide('screen-practice');
    show('screen-landing');
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
