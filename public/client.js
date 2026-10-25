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
  const CAPACITY = { one: 1, two: 2, four: 4 }; // final-hand shape
  const SLOT_TITLES = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
  const STORAGE_KEY = 'taiwanese-poker-session';

  // ---------- card sorting ----------
  // A shared display preference (not per-hand state) for how "your cards" areas lay
  // themselves out: 'dealt' (whatever order the server sent, i.e. unsorted), 'rank'
  // (high to low, ties broken by suit), or 'suit' (grouped s/h/d/c, high to low within
  // each suit). Applies to the live game's tray and Practice Mode's tray — anywhere
  // you're looking at a raw pile of your own cards deciding what to do with them.
  // Doesn't touch cards already placed into hand slots —
  // those stay in the order you put them, since reordering a hand you've already built
  // would just be confusing. Persisted across visits like the sound preference.
  const CARD_SORT_KEY = 'taiwanese-poker-card-sort';
  const RANK_ORDER = '23456789TJQKA';
  const SUIT_ORDER = ['s', 'h', 'd', 'c'];
  let cardSortMode = 'dealt';
  try {
    const savedSort = localStorage.getItem(CARD_SORT_KEY);
    if (savedSort === 'rank' || savedSort === 'suit' || savedSort === 'dealt') cardSortMode = savedSort;
  } catch (e) { /* localStorage unavailable — default stays 'dealt' */ }

  function sortCards(cards, mode) {
    if (mode !== 'rank' && mode !== 'suit') return cards; // 'dealt' — leave as-is
    const arr = cards.slice();
    const rankOf = (c) => RANK_ORDER.indexOf(c[0]);
    const suitOf = (c) => SUIT_ORDER.indexOf(c[1]);
    if (mode === 'rank') {
      arr.sort((a, b) => rankOf(b) - rankOf(a) || suitOf(a) - suitOf(b));
    } else {
      arr.sort((a, b) => suitOf(a) - suitOf(b) || rankOf(b) - rankOf(a));
    }
    return arr;
  }

  // Wires up a "Sort: Dealt / Rank / Suit" button group inside `containerId`. Clicking a
  // button updates the shared cardSortMode, persists it, keeps every such control on the
  // page in sync (even ones on screens not currently visible), and re-renders whichever
  // screen this particular control belongs to via `onChange`.
  function wireSortControl(containerId, onChange) {
    const container = el(containerId);
    if (!container) return;
    function syncActiveStates() {
      document.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('active', b.dataset.sort === cardSortMode));
    }
    container.querySelectorAll('.sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.sort === cardSortMode) return;
        cardSortMode = btn.dataset.sort;
        try { localStorage.setItem(CARD_SORT_KEY, cardSortMode); } catch (e) { /* ignore */ }
        syncActiveStates();
        onChange();
      });
    });
    syncActiveStates();
  }

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

  // ---------- win sounds ----------
  // Synthesized with the Web Audio API (a couple of short oscillator tones per cue)
  // instead of shipping audio files — zero extra assets to host, and it means "add a
  // sound" doesn't turn into "find/license/host an mp3." The win/homerun fanfares fire in
  // live PvP games only (at the results reveal) — Practice Mode runs hands too quickly in
  // succession for those to feel good rather than annoying. Rapid Fire has its own much
  // shorter correct-answer blip (playCorrectSound), which is sized for hearing it many
  // times a minute.
  const SOUND_PREF_KEY = 'taiwanese-poker-sound-enabled';
  let soundEnabled = true;
  try {
    const saved = localStorage.getItem(SOUND_PREF_KEY);
    if (saved !== null) soundEnabled = saved === 'true';
  } catch (e) { /* localStorage unavailable (e.g. private mode) — default stays on */ }

  let audioCtx = null;
  function getAudioCtx() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function playTone(ctx, freq, startTime, duration, peakGain, type) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  // A short ascending major arpeggio — the standard "you won this hand" chime.
  function playWinSound() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => { // C5 E5 G5 C6
      playTone(ctx, freq, now + i * 0.09, 0.35, 0.16);
    });
  }

  // A bigger fanfare for a homerun — the same arpeggio plus an extra high note and a
  // sparkly triangle-wave tail, so it's clearly a step up from a plain win.
  function playHomerunSound() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((freq, i) => { // C5 E5 G5 C6 E6
      playTone(ctx, freq, now + i * 0.08, 0.4, 0.19);
    });
    playTone(ctx, 1567.98, now + 0.42, 0.55, 0.13, 'triangle'); // G6 sparkle on top
  }

  function setSoundEnabled(on) {
    soundEnabled = on;
    try { localStorage.setItem(SOUND_PREF_KEY, String(on)); } catch (e) { /* ignore */ }
    const btn = el('btnSoundToggle');
    if (btn) {
      btn.textContent = on ? '🔊' : '🔇';
      btn.classList.toggle('muted', !on);
      btn.title = on ? 'Sound on — click to mute' : 'Sound off — click to unmute';
    }
  }

  const soundToggleBtn = el('btnSoundToggle');
  if (soundToggleBtn) {
    setSoundEnabled(soundEnabled);
    soundToggleBtn.addEventListener('click', () => setSoundEnabled(!soundEnabled));
  }

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
  // Scoped to [data-tab] on purpose: other screens reuse the .tab-btn look for their own
  // in-screen tabs (Rapid Fire's Quiz/Mistakes), and those carry a different data attribute
  // and manage their own active state.
  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
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
    const res = await api('/api/create_room', { name, maxPlayers });
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
  function liveCapacity() {
    return CAPACITY;
  }

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
    return sortCards(state.myHand.filter((c) => !used.has(c)), cardSortMode);
  }

  function renderGame() {
    el('handNumber').textContent = state.room ? state.room.handNumber : '';

    el('slotTitleOne').textContent = '1-Card Hand';
    el('slotTitleTwo').textContent = '2-Card Hand';
    el('slotTitleFour').textContent = '4-Card PLO Hand';

    const cap = CAPACITY;
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
            placeInFirstOpenSlot(state.assignment, c, cap);
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
        if (state.assignment[slot].length >= cap[slot]) return;
        state.assignment[slot].push(state.selectedCard);
        state.selectedCard = null;
        renderGame();
      };
    });

    const allPlaced = trayCards().length === 0
      && state.assignment.one.length === cap.one
      && state.assignment.two.length === cap.two
      && state.assignment.four.length === cap.four;
    el('btnLock').disabled = disabled || !allPlaced;
    el('btnClear').disabled = disabled;

    updateLockStatus();
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ⌘/Ctrl+click a tray card to skip the select-then-click-a-slot dance — drops it
  // straight into the first slot (left to right: 1-card, 2-card, 4-card) that still has
  // room. No-ops if every slot is already full. Shared by the live game and Practice
  // Mode, each with their own separate assignment object.
  function placeInFirstOpenSlot(assignment, card, capacity = CAPACITY) {
    for (const slot of ['one', 'two', 'four']) {
      if (assignment[slot].length < capacity[slot]) {
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
    const hasHomerun = !!(r.homeruns && r.homeruns.length > 0);
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

    if (r.homeruns.some((h) => h.winner === state.playerId)) playHomerunSound();
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

    // A homerun already got its own bigger fanfare (via showHomerunBanner, timed to the
    // banner appearing) — don't also play the plain win chime on top of that for the same
    // hand. Otherwise, a positive net score this hand gets the regular "you won" cue.
    const wonHomerun = !!(r.homeruns && r.homeruns.some((h) => h.winner === state.playerId));
    if (!wonHomerun && (r.pointsThisHand[state.playerId] || 0) > 0) playWinSound();

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

    const hasHomerun = !!(r.homeruns && r.homeruns.length > 0);
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
  // The "opponent" for each trial is a (hand, split) pair pulled from opponent-pool.json —
  // hands whose blind split was solved offline via the iterative best-response bootstrap
  // documented in experiments/solve/. Re-arranging your own hand re-scores instantly
  // against the SAME set of trials, so EV differences between your attempts are directly
  // comparable (no fresh variance each redo).
  const PRACTICE_TRIALS_MIN = 100;
  const PRACTICE_TRIALS_MAX = 10000;
  const PRACTICE_TRIALS_DEFAULT = 150;
  let practiceTrialTarget = PRACTICE_TRIALS_DEFAULT; // takes effect on the next dealt hand

  // The board-count slider is logarithmic (100 to 10,000 spans two orders of magnitude —
  // a linear slider would waste almost all of its travel on the 1000-10000 range and make
  // it nearly impossible to land precisely on, say, 200). The <input type="range"> itself
  // stays a plain linear control internally (0..PRACTICE_SLIDER_STEPS); these two helpers
  // convert between that raw position and an actual trial count, snapped to a clean-ish
  // number so the displayed value doesn't look like random noise (e.g. "2340" not "2337").
  const PRACTICE_SLIDER_STEPS = 1000;
  function practiceSliderToTrials(raw) {
    const t = Math.min(1, Math.max(0, raw / PRACTICE_SLIDER_STEPS));
    const logMin = Math.log10(PRACTICE_TRIALS_MIN);
    const logMax = Math.log10(PRACTICE_TRIALS_MAX);
    const exact = Math.pow(10, logMin + t * (logMax - logMin));
    let snapped;
    if (exact < 1000) snapped = Math.round(exact / 10) * 10;
    else if (exact < 3000) snapped = Math.round(exact / 50) * 50;
    else snapped = Math.round(exact / 100) * 100;
    return Math.min(PRACTICE_TRIALS_MAX, Math.max(PRACTICE_TRIALS_MIN, snapped));
  }
  function practiceTrialsToSlider(trials) {
    const logMin = Math.log10(PRACTICE_TRIALS_MIN);
    const logMax = Math.log10(PRACTICE_TRIALS_MAX);
    const t = (Math.log10(trials) - logMin) / (logMax - logMin);
    return Math.round(t * PRACTICE_SLIDER_STEPS);
  }

  // "Show Ideal Split" has its own separate board-count slider (same 100-10,000 log range
  // and the same helpers above) instead of always riding on the EV panel's slider — the
  // ideal split search is far more expensive per board (105 partitions vs. 1), so someone
  // running 10,000 boards through the EV panel usually still wants the search itself to
  // stay fast, but they can dial it up if they want a slower, more precise search. It's
  // sticky (unlike the EV slider, it applies immediately, not just on New Hand) and gets
  // clamped down to however many boards this hand actually has if set higher than that.
  const PRACTICE_IDEAL_TRIALS_DEFAULT = 1000;
  let practiceIdealTrialTarget = PRACTICE_IDEAL_TRIALS_DEFAULT;

  // Homerun scoring is always part of the game now, so Practice Mode's EV calculations
  // and the ideal-split search always factor it in too — there's no toggle for it.
  const practiceHomerunMode = true;
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

  function buildPracticeTrials(playerHand, pool, trialCount) {
    const playerSet = new Set(playerHand);
    const qualifying = pool.filter((entry) => {
      const oppHand = [...entry.one, ...entry.two, ...entry.four];
      return oppHand.every((c) => !playerSet.has(c));
    });

    let chosen;
    if (qualifying.length >= trialCount) {
      chosen = shuffleArray(qualifying).slice(0, trialCount);
    } else {
      // The pre-solved opponent pool has ~5400 hands total, and roughly a third of those
      // qualify (don't share a card with yours) for any given hand — about 1800 distinct
      // opponents, so the default 150 boards and the ideal-split search's default 1000 both
      // draw a fresh opponent every trial. Past ~1800 opponents start repeating (with fresh
      // boards each trial). Still zero risk of a duplicate card within any single trial.
      chosen = [];
      for (let i = 0; i < trialCount; i++) {
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
    const trials = buildPracticeTrials(hand, pool, practiceTrialTarget);

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
    return sortCards(practice.hand.filter((c) => !used.has(c)), cardSortMode);
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

  // Matches lib/game.js's rule exactly: sweeping all 6 comparisons against this one
  // opponent (both boards, all 3 hand sizes, no ties anywhere) doubles the match total
  // for that trial, 12 -> 24 (or -24 if you're the one swept). The opponent's split in
  // opponent-pool.json is itself solved for this same homerun rule (see
  // experiments/solve/solve_round_hr.js and solve_fixed_hr.js) — not a standard-rules
  // opponent that just happens to get scored with the bonus on top.
  const PRACTICE_MATCH_TOTAL = (PRACTICE_POINTS.one + PRACTICE_POINTS.two + PRACTICE_POINTS.four) * 2;

  // Score `assignment` against one trial's fixed opponent + boards. Returns the point
  // swing for each of the 6 (category, board) cells, the total, and whether this trial
  // was a homerun (for either side) once homerunMode's bonus is folded in.
  function scoreTrial(assignment, trial, homerunMode) {
    const cells = { one: [0, 0], two: [0, 0], four: [0, 0] };
    let total = 0;
    let allWon = true;
    let allLost = true;
    ['one', 'two', 'four'].forEach((cat) => {
      [trial.boardA, trial.boardB].forEach((board, bi) => {
        const mine = evalHandOnBoard(assignment[cat], board, cat);
        const theirs = evalHandOnBoard(trial.oppSplit[cat], board, cat);
        const cmp = window.Poker.compareScores(mine.score, theirs.score);
        const pts = PRACTICE_POINTS[cat];
        const delta = cmp > 0 ? pts : cmp < 0 ? -pts : 0;
        cells[cat][bi] = delta;
        total += delta;
        if (delta <= 0) allWon = false;
        if (delta >= 0) allLost = false;
      });
    });
    let homerun = null;
    if (homerunMode) {
      if (allWon) { total += PRACTICE_MATCH_TOTAL; homerun = 'win'; }
      else if (allLost) { total -= PRACTICE_MATCH_TOTAL; homerun = 'loss'; }
    }
    return { total, cells, homerun };
  }

  // Runs the current arrangement through all trials — cheap, pure client-side
  // evaluate5() calls, no network — so this can fire on every completed arrangement.
  // Also tracks the sum of squares of the per-hand total so it can report the variance
  // and standard deviation of the outcome (how swingy this split's results are trial to
  // trial), plus the standard error of the EV estimate itself — i.e. roughly how far off
  // "avgTotal" might be from the true long-run EV, given only `n` trials.
  function evalAssignmentAcrossTrials(assignment, trials, homerunMode) {
    let sumTotal = 0;
    let sumTotalSq = 0;
    const sumCells = { one: [0, 0], two: [0, 0], four: [0, 0] };
    let homerunWins = 0;
    let homerunLosses = 0;
    trials.forEach((trial) => {
      const r = scoreTrial(assignment, trial, homerunMode);
      sumTotal += r.total;
      sumTotalSq += r.total * r.total;
      ['one', 'two', 'four'].forEach((cat) => {
        sumCells[cat][0] += r.cells[cat][0];
        sumCells[cat][1] += r.cells[cat][1];
      });
      if (r.homerun === 'win') homerunWins++;
      else if (r.homerun === 'loss') homerunLosses++;
    });
    const n = trials.length;
    const avgCells = {};
    ['one', 'two', 'four'].forEach((cat) => {
      avgCells[cat] = [sumCells[cat][0] / n, sumCells[cat][1] / n];
    });
    const avgTotal = sumTotal / n;
    // Sample variance (n-1 denominator); guard the n===1 edge case.
    const varianceTotal = n > 1 ? Math.max(0, (sumTotalSq - n * avgTotal * avgTotal) / (n - 1)) : 0;
    const sdTotal = Math.sqrt(varianceTotal);
    const seTotal = n > 0 ? sdTotal / Math.sqrt(n) : 0;
    return { avgTotal, avgCells, homerunWins, homerunLosses, n, varianceTotal, sdTotal, seTotal };
  }

  function fmtEv(n) { return (n > 0 ? '+' : '') + n.toFixed(2); }

  function runPracticeEval() {
    const result = evalAssignmentAcrossTrials(practice.assignment, practice.trials, practiceHomerunMode);
    practice.lastEv = result;
    renderPracticeEV(result);
  }

  function renderPracticeEV(result) {
    const { avgTotal, avgCells, homerunWins, homerunLosses, n, varianceTotal, sdTotal, seTotal } = result;
    el('practiceTrialCount').textContent = practice.trials.length;
    const totalSpan = el('practiceEvTotal');
    totalSpan.textContent = fmtEv(avgTotal);
    totalSpan.className = 'pscore ' + (avgTotal > 0 ? 'pos' : avgTotal < 0 ? 'neg' : '');

    // Just for fun / for the curious: how swingy is this split's outcome trial-to-trial
    // (variance / SD of the per-hand total), and how precise is the EV number above given
    // only `n` trials (standard error of the mean — roughly, the true EV is within about
    // +/-2*SE of avgTotal, 95% of the time).
    const varLine = el('practiceVarianceLine');
    if (varLine) {
      varLine.textContent =
        `\u{1F4CA} Variance: ${varianceTotal.toFixed(2)} pts² (SD ±${sdTotal.toFixed(2)} pts/hand) ` +
        `· this EV estimate is accurate to roughly ±${seTotal.toFixed(3)} (1 SE) over ${n.toLocaleString()} boards`;
    }

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

    const hrLine = el('practiceHomerunRate');
    if (n) {
      hrLine.innerHTML = `⚾ Homerun rate: you swept <span class="pcell pos">${homerunWins}/${n}</span> boards &middot; opponent swept <span class="pcell neg">${homerunLosses}/${n}</span> boards`;
      hrLine.classList.remove('hidden');
    } else {
      hrLine.classList.add('hidden');
    }

    el('practiceEvPanel').classList.remove('hidden');
  }

  // ---------- practice mode: "Show Ideal Split" ----------
  // Scores the 105 ways to split the 7 practice cards against the same trial set used
  // everywhere else in this session, and returns the best one (plus 2 runner-ups). Two
  // layers of speedup, both benchmarked and verified to produce the same winner as a plain
  // exhaustive search in the common case: (1) the opponent's evaluation is hoisted out of
  // the partition loop (it doesn't depend on which partition is being tested) and the
  // expensive 4-card PLO evaluation is shared across whichever partitions happen to use the
  // same 4-card subset — ~4x faster on its own; (2) a successive-halving search (see
  // IDEAL_SEARCH_CHECKPOINTS below) that narrows from 105 partitions down to 10, then 3,
  // using cheap early checkpoints, so the bulk of a large requested trial count only gets
  // spent on genuine finalists.
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

  // Successive-halving search: instead of scoring all 105 partitions against every single
  // requested board (expensive once the ideal-split slider is set high), narrow the field
  // down using cheap early checkpoints, the same way you'd play it by hand — 200 boards is
  // plenty to see which splits are clearly out of contention, 1000 narrows further to the
  // real finalists, and only those get the rest of the requested trial budget. A partition
  // that survives a checkpoint keeps its full cumulative score from trial 0 onward (nothing
  // is re-run) — a partition that gets cut just stops accumulating, its score frozen at
  // whatever it had at the checkpoint, since it was only needed to decide who gets cut.
  // Checkpoints past the requested trial count are simply skipped, so at 100-200 boards
  // this degrades gracefully back to "just run all 105 the whole way," same as before.
  //
  // The tradeoff: this is a heuristic, not an exhaustive search anymore. A partition that
  // gets unlucky in its first 200 boards and falls out of the top 10 is gone for good, even
  // if it would have pulled ahead given the full trial count. In practice the margin
  // between the true best split and a split that's merely very good is usually much bigger
  // than the noise at 200-1000 boards, so this rarely changes the answer — but it's not a
  // hard guarantee the way scoring all 105 the whole way was.
  const IDEAL_SEARCH_CHECKPOINTS = [
    { afterTrials: 200, keep: 10 },
    { afterTrials: 1000, keep: 3 }
  ];

  function findIdealSplitAsync(hand, trials, homerunMode, onProgress) {
    return new Promise((resolve) => {
      const Poker = window.Poker;
      const allParts = allPartitions(hand);
      const totalTrials = trials.length;
      const checkpoints = IDEAL_SEARCH_CHECKPOINTS.filter((c) => c.afterTrials < totalTrials);

      const totals = new Float64Array(allParts.length);
      let active = allParts.map((_, i) => i); // indices into allParts/totals still in contention
      let checkpointIdx = 0;
      let ti = 0;

      function fourGroupsFor(idxList) {
        const groups = new Map();
        idxList.forEach((idx) => {
          const part = allParts[idx];
          const key = [...part.four].sort().join(',');
          if (!groups.has(key)) groups.set(key, { four: part.four, members: [] });
          groups.get(key).members.push(idx);
        });
        return groups;
      }
      let fourGroups = fourGroupsFor(active);

      // Rough work-unit estimate (trials x active-partition-count at each stage) purely to
      // drive the progress bar — later stages process far fewer partitions per trial.
      let totalWork = 0;
      {
        let prevCap = 0;
        let keepCount = allParts.length;
        checkpoints.forEach((c) => {
          totalWork += (c.afterTrials - prevCap) * keepCount;
          prevCap = c.afterTrials;
          keepCount = c.keep;
        });
        totalWork += (totalTrials - prevCap) * keepCount;
      }
      let workDone = 0;

      function currentCap() {
        return checkpointIdx < checkpoints.length ? checkpoints[checkpointIdx].afterTrials : totalTrials;
      }

      function scoreRange(start, end) {
        for (let i = start; i < end; i++) {
          const trial = trials[i];
          const oc = {
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
          };
          for (const { four, members } of fourGroups.values()) {
            const fourA = Poker.bestPLO(four, trial.boardA).score;
            const fourB = Poker.bestPLO(four, trial.boardB).score;
            const cmpA = Poker.compareScores(fourA, oc.four[0]);
            const cmpB = Poker.compareScores(fourB, oc.four[1]);
            const d4a = cmpA > 0 ? 3 : cmpA < 0 ? -3 : 0;
            const d4b = cmpB > 0 ? 3 : cmpB < 0 ? -3 : 0;
            const fourPts = d4a + d4b;
            for (const idx of members) {
              const part = allParts[idx];
              const oneA = Poker.bestGeneric(part.one, trial.boardA).score;
              const oneB = Poker.bestGeneric(part.one, trial.boardB).score;
              const twoA = Poker.bestGeneric(part.two, trial.boardA).score;
              const twoB = Poker.bestGeneric(part.two, trial.boardB).score;
              const c1a = Poker.compareScores(oneA, oc.one[0]);
              const c1b = Poker.compareScores(oneB, oc.one[1]);
              const c2a = Poker.compareScores(twoA, oc.two[0]);
              const c2b = Poker.compareScores(twoB, oc.two[1]);
              const d1a = c1a > 0 ? 1 : c1a < 0 ? -1 : 0;
              const d1b = c1b > 0 ? 1 : c1b < 0 ? -1 : 0;
              const d2a = c2a > 0 ? 2 : c2a < 0 ? -2 : 0;
              const d2b = c2b > 0 ? 2 : c2b < 0 ? -2 : 0;
              let pts = d1a + d1b + d2a + d2b + fourPts;
              // A split that sets up more clean sweeps can beat a higher-raw-EV split once
              // the homerun bonus is on, so this has to be part of the search objective
              // itself, not just applied after the fact to whichever partition wins on raw
              // points.
              if (homerunMode) {
                if (d1a > 0 && d1b > 0 && d2a > 0 && d2b > 0 && d4a > 0 && d4b > 0) pts += PRACTICE_MATCH_TOTAL;
                else if (d1a < 0 && d1b < 0 && d2a < 0 && d2b < 0 && d4a < 0 && d4b < 0) pts -= PRACTICE_MATCH_TOTAL;
              }
              totals[idx] += pts;
            }
          }
        }
      }

      function step() {
        const cap = currentCap();
        // Aim each tick at roughly a fixed amount of work (trials x active partitions), so
        // ticks stay responsive without wasting time on scheduling overhead once the field
        // has narrowed and each trial got a lot cheaper to score.
        const chunkTrials = Math.max(1, Math.min(cap - ti, Math.round(525 / active.length)));
        const end = Math.min(ti + chunkTrials, cap);
        if (end > ti) {
          scoreRange(ti, end);
          workDone += (end - ti) * active.length;
          ti = end;
        }

        if (onProgress) onProgress(Math.min(1, workDone / totalWork));

        if (ti < cap) {
          setTimeout(step, 0);
          return;
        }

        if (checkpointIdx < checkpoints.length) {
          const keep = checkpoints[checkpointIdx].keep;
          active = active.slice().sort((a, b) => totals[b] - totals[a]).slice(0, keep);
          fourGroups = fourGroupsFor(active);
          checkpointIdx++;
          setTimeout(step, 0);
          return;
        }

        // Rank whatever's still active (could be all 105, if the trial count never hit a
        // checkpoint, or as few as 3) and keep the top 3 — the winner, plus the next 2
        // runner-ups shown collapsed in the UI.
        const ranked = active.slice().sort((a, b) => totals[b] - totals[a]);
        const top3 = ranked.slice(0, 3).map((idx) => allParts[idx]);
        const [bestPartition, ...runnerUpPartitions] = top3;
        // Re-derive the same result shape the rest of the UI expects, via the standard
        // (single-partition, so cheap) evaluator — guarantees the displayed number matches
        // exactly what re-running that split manually would show, and fills in the
        // avgCells/homerun breakdown the fast scoring pass above doesn't track. Same for
        // each runner-up; only 3 partitions get this treatment, so it's negligible cost.
        const result = evalAssignmentAcrossTrials(bestPartition, trials, homerunMode);
        const runnersUp = runnerUpPartitions.map((partition) => ({
          assignment: partition,
          ...evalAssignmentAcrossTrials(partition, trials, homerunMode)
        }));
        resolve({ assignment: bestPartition, ...result, runnersUp });
      }

      step();
    });
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

    // The search runs against however many boards the "Ideal split search boards" slider
    // asked for, clamped down to however many this hand actually has (from the main EV
    // slider at deal time). Make that explicit whenever the clamp actually kicked in —
    // otherwise "Average EV" here and the EV panel's own number are silently over
    // different-sized (if overlapping) trial sets.
    const noteEl = el('practiceIdealTrialNote');
    if (noteEl) {
      if (ideal.n < practice.trials.length) {
        noteEl.textContent = `(checked against ${ideal.n.toLocaleString()} of your ${practice.trials.length.toLocaleString()} boards, per the search slider below)`;
      } else {
        noteEl.textContent = '(checked against these same boards)';
      }
    }

    renderPracticeRunnersUp(ideal.runnersUp || []);

    el('practiceIdealPanel').classList.remove('hidden');
  }

  // Renders the 2nd- and 3rd-place partitions inside a collapsed <details> — off by
  // default so it doesn't clutter the panel, but there for anyone curious how close the
  // field was (a clear standout winner vs. a virtual tie with a couple of alternatives).
  function renderPracticeRunnersUp(runnersUp) {
    const list = el('practiceRunnerUps');
    if (!list) return;
    list.innerHTML = '';
    const catShortLabel = { one: '1-Card:', two: '2-Card:', four: '4-Card:' };
    runnersUp.forEach((ru, i) => {
      const item = document.createElement('div');
      item.className = 'practice-runnerup-item';

      const rank = document.createElement('div');
      rank.className = 'practice-runnerup-rank';
      rank.textContent = `#${i + 2}`;
      item.appendChild(rank);

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'practice-ideal-cards';
      ['one', 'two', 'four'].forEach((cat) => {
        const group = document.createElement('span');
        group.className = 'hc-group';
        const lbl = document.createElement('span');
        lbl.className = 'hc-label';
        lbl.textContent = catShortLabel[cat];
        group.appendChild(lbl);
        group.appendChild(cardRow(ru.assignment[cat], { size: 'small' }));
        cardsWrap.appendChild(group);
      });
      item.appendChild(cardsWrap);

      const footer = document.createElement('div');
      footer.className = 'practice-ideal-footer';
      const evSpan = document.createElement('span');
      evSpan.innerHTML = `Average EV: <span class="pscore ${ru.avgTotal > 0 ? 'pos' : ru.avgTotal < 0 ? 'neg' : ''}">${fmtEv(ru.avgTotal)}</span> pts/hand`;
      footer.appendChild(evSpan);
      const loadBtn = document.createElement('button');
      loadBtn.className = 'secondary';
      loadBtn.textContent = 'Load This Split';
      loadBtn.addEventListener('click', () => {
        if (!practice) return;
        practice.assignment = deepCopy(ru.assignment);
        practice.selectedCard = null;
        renderPracticeArranger();
      });
      footer.appendChild(loadBtn);
      item.appendChild(footer);

      list.appendChild(item);
    });
  }

  el('btnPracticeIdeal').addEventListener('click', async () => {
    if (!practice) return;
    if (practice.ideal) { renderPracticeIdeal(practice.ideal); return; }

    const btn = el('btnPracticeIdeal');
    btn.disabled = true;
    btn.textContent = 'Calculating… 0%';
    const idealTrials = practice.trials.length > practiceIdealTrialTarget
      ? practice.trials.slice(0, practiceIdealTrialTarget)
      : practice.trials;
    practice.ideal = await findIdealSplitAsync(practice.hand, idealTrials, practiceHomerunMode, (frac) => {
      btn.textContent = `Calculating… ${Math.round(frac * 100)}%`;
    });
    btn.disabled = false;
    btn.textContent = 'Show Ideal Split';
    renderPracticeIdeal(practice.ideal);
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

  // The slider element itself is a plain linear <input type="range"> — its raw value is
  // a position (0..PRACTICE_SLIDER_STEPS), not a trial count. Set its bounds/initial
  // position here (rather than hardcoding a "nice" HTML default attribute) so it stays in
  // sync with PRACTICE_TRIALS_MIN/MAX/DEFAULT if those ever change.
  const trialsRangeEl = el('practiceTrialsRange');
  trialsRangeEl.min = 0;
  trialsRangeEl.max = PRACTICE_SLIDER_STEPS;
  trialsRangeEl.step = 1;
  trialsRangeEl.value = practiceTrialsToSlider(practiceTrialTarget);
  el('practiceTrialsValue').textContent = practiceTrialTarget.toLocaleString();
  el('practiceHintTrials').textContent = practiceTrialTarget.toLocaleString();

  trialsRangeEl.addEventListener('input', () => {
    practiceTrialTarget = practiceSliderToTrials(Number(trialsRangeEl.value));
    el('practiceTrialsValue').textContent = practiceTrialTarget.toLocaleString();
    el('practiceHintTrials').textContent = practiceTrialTarget.toLocaleString();
  });

  // Same log-scale setup, for the separate "Ideal split search boards" slider. Unlike the
  // EV slider above, changing this doesn't require a New Hand — it just invalidates any
  // cached ideal-split answer so the next "Show Ideal Split" click recomputes at the new
  // count.
  const idealTrialsRangeEl = el('practiceIdealTrialsRange');
  if (idealTrialsRangeEl) {
    idealTrialsRangeEl.min = 0;
    idealTrialsRangeEl.max = PRACTICE_SLIDER_STEPS;
    idealTrialsRangeEl.step = 1;
    idealTrialsRangeEl.value = practiceTrialsToSlider(practiceIdealTrialTarget);
    el('practiceIdealTrialsValue').textContent = practiceIdealTrialTarget.toLocaleString();

    idealTrialsRangeEl.addEventListener('input', () => {
      practiceIdealTrialTarget = practiceSliderToTrials(Number(idealTrialsRangeEl.value));
      el('practiceIdealTrialsValue').textContent = practiceIdealTrialTarget.toLocaleString();
      if (practice) {
        practice.ideal = null;
        el('practiceIdealPanel').classList.add('hidden');
        const idealBtn = el('btnPracticeIdeal');
        idealBtn.disabled = false;
        idealBtn.textContent = 'Show Ideal Split';
      }
    });
  }

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

  // Wire up every "Sort: Dealt / Rank / Suit" control on the page. Each one re-renders
  // only its own screen — renderGame/renderPracticeArranger are each guarded internally
  // against running before that screen has real state to show, and since a hidden
  // screen's buttons can't be clicked (`.hidden` is display:none), the right one always
  // fires.
  wireSortControl('gameSortControl', renderGame);
  wireSortControl('practiceSortControl', renderPracticeArranger);

  // ---------- rapid fire (GTO drill) ----------
  // Three drills on the one decision this game actually has, all scored against the same
  // homerun-solved opponents Practice Mode uses (full-match-sweep bonus included, since
  // that's always on):
  //   arrange  — you build the 1/2/4 split yourself, graded against the true best of all
  //              105 partitions of that hand.
  //   estimate — you're shown a split and type what you think its EV is, to calibrate a
  //              repeatable read of a hand rather than just recognizing shapes.
  //   locked   — the 2-card NLH hand is fixed for you; you choose which of the remaining
  //              five cards plays alone, and the other four become the PLO hand.
  // Quiz hands are drawn from the solved pool itself, so the offline solver's own split for
  // the hand is always reachable — but "best" is always whatever genuinely graded best on
  // this hand's board set, never an assumption about what the solver picked.
  const RAPID_TRIALS = 120; // arrange: boards per hand (105 partitions scored against these)
  const RAPID_LOCKED_TRIALS = 240; // locked: only 5 completions to score, so afford more boards
  const RAPID_EST_TRIALS = 400; // estimate: a single split, so the target EV can be tighter
  // "Close EV is fine": within this of the best split counts as correct. Two splits inside
  // ~0.15 pts/hand are a coin flip at this many boards (well inside the standard error), so
  // insisting on the exact argmax would be grading Monte Carlo noise.
  const RAPID_TOLERANCE = 0.15;
  const RAPID_TIERS = [
    { key: 'inaccuracy', label: 'Inaccuracy', mark: '?!', max: 0.75 },
    { key: 'mistake', label: 'Mistake', mark: '?', max: 2.0 },
    { key: 'blunder', label: 'Blunder', mark: '??', max: Infinity }
  ];
  // Estimate mode grades absolute error instead of EV lost, so it needs its own scale.
  const RAPID_EST_TOLERANCE = 0.75;
  const RAPID_EST_TIERS = [
    { key: 'inaccuracy', label: 'Close', mark: '?!', max: 2.0 },
    { key: 'mistake', label: 'Off', mark: '?', max: 4.0 },
    { key: 'blunder', label: 'Way off', mark: '??', max: Infinity }
  ];
  const RAPID_MODE_HINTS = {
    arrange: 'Build the highest-EV split you can. Click a card then a hand, press 1-7 to drop the next card into the first open slot, Backspace to undo. Graded against all 105 ways to split this hand.',
    estimate: 'Read the split below and estimate its EV in points per hand. Negative is fine — most splits lose to a solved opponent. The breakdown on reveal shows which hand your read was wrong about.',
    locked: 'The 2-card NLH hand is locked. Pick which of the five remaining cards plays as the 1-card hand — the other four become the PLO hand. Press 1-5 or click.'
  };

  let rapid = null;

  function rapidNewModeStats() {
    return { played: 0, totalLoss: 0, totalAbsErr: 0, totalSignedErr: 0, streak: 0, bestStreak: 0,
      counts: { best: 0, inaccuracy: 0, mistake: 0, blunder: 0 } };
  }

  function rapidNewState() {
    return {
      mode: 'arrange',
      current: null,
      next: null,
      stats: { arrange: rapidNewModeStats(), estimate: rapidNewModeStats(), locked: rapidNewModeStats() },
      mistakes: [],
      mistakeSeq: 0,
      view: 'drill',
      retry: null,
      loading: false
    };
  }

  function randomPartitionOf(hand) {
    const s = shuffleArray(hand);
    return { one: [s[0]], two: [s[1], s[2]], four: [s[3], s[4], s[5], s[6]] };
  }

  function nextTick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

  // Score an arbitrary list of partitions against a fixed trial set, returning every one
  // ranked. Same shape of optimization as Practice Mode's ideal-split search — the
  // opponent's evaluation is hoisted out of the partition loop, and the expensive 4-card
  // PLO evaluation is computed once per distinct 4-card subset rather than once per
  // partition — but it keeps ALL results instead of just the winner, which is what lets a
  // freely-arranged split be ranked (#k of 105) rather than only compared to the best.
  // Runs in small batches with a yield between them so the tab never freezes.
  function scorePartitionsAsync(parts, trials, onProgress) {
    return new Promise((resolve) => {
      const Poker = window.Poker;
      const totals = new Float64Array(parts.length);
      const groups = new Map();
      parts.forEach((part, idx) => {
        const key = [...part.four].sort().join(',');
        if (!groups.has(key)) groups.set(key, { four: part.four, members: [] });
        groups.get(key).members.push(idx);
      });
      const chunkTrials = Math.max(1, Math.round(525 / Math.max(1, parts.length)));
      let ti = 0;

      function step() {
        const end = Math.min(ti + chunkTrials, trials.length);
        for (let i = ti; i < end; i++) {
          const trial = trials[i];
          const oc = {
            one: [evalHandOnBoard(trial.oppSplit.one, trial.boardA, 'one').score, evalHandOnBoard(trial.oppSplit.one, trial.boardB, 'one').score],
            two: [evalHandOnBoard(trial.oppSplit.two, trial.boardA, 'two').score, evalHandOnBoard(trial.oppSplit.two, trial.boardB, 'two').score],
            four: [evalHandOnBoard(trial.oppSplit.four, trial.boardA, 'four').score, evalHandOnBoard(trial.oppSplit.four, trial.boardB, 'four').score]
          };
          for (const { four, members } of groups.values()) {
            const cmpA = Poker.compareScores(Poker.bestPLO(four, trial.boardA).score, oc.four[0]);
            const cmpB = Poker.compareScores(Poker.bestPLO(four, trial.boardB).score, oc.four[1]);
            const d4a = cmpA > 0 ? 3 : cmpA < 0 ? -3 : 0;
            const d4b = cmpB > 0 ? 3 : cmpB < 0 ? -3 : 0;
            const fourPts = d4a + d4b;
            for (const idx of members) {
              const part = parts[idx];
              const c1a = Poker.compareScores(Poker.bestGeneric(part.one, trial.boardA).score, oc.one[0]);
              const c1b = Poker.compareScores(Poker.bestGeneric(part.one, trial.boardB).score, oc.one[1]);
              const c2a = Poker.compareScores(Poker.bestGeneric(part.two, trial.boardA).score, oc.two[0]);
              const c2b = Poker.compareScores(Poker.bestGeneric(part.two, trial.boardB).score, oc.two[1]);
              const d1a = c1a > 0 ? 1 : c1a < 0 ? -1 : 0;
              const d1b = c1b > 0 ? 1 : c1b < 0 ? -1 : 0;
              const d2a = c2a > 0 ? 2 : c2a < 0 ? -2 : 0;
              const d2b = c2b > 0 ? 2 : c2b < 0 ? -2 : 0;
              let pts = d1a + d1b + d2a + d2b + fourPts;
              if (d1a > 0 && d1b > 0 && d2a > 0 && d2b > 0 && d4a > 0 && d4b > 0) pts += PRACTICE_MATCH_TOTAL;
              else if (d1a < 0 && d1b < 0 && d2a < 0 && d2b < 0 && d4a < 0 && d4b < 0) pts -= PRACTICE_MATCH_TOTAL;
              totals[idx] += pts;
            }
          }
        }
        ti = end;
        if (onProgress) onProgress(ti / trials.length);
        if (ti < trials.length) { setTimeout(step, 0); return; }
        const scored = parts.map((assignment, idx) => ({
          assignment,
          key: fmtAssignmentKey(assignment),
          ev: totals[idx] / trials.length
        }));
        scored.sort((a, b) => b.ev - a.ev);
        resolve(scored);
      }
      step();
    });
  }

  function rapidSeedHand(pool) {
    const seed = pool[Math.floor(Math.random() * pool.length)];
    return { seed, hand: [...seed.one, ...seed.two, ...seed.four] };
  }

  async function buildArrangeQuiz() {
    const pool = await loadOpponentPool();
    const { hand } = rapidSeedHand(pool);
    const trials = buildPracticeTrials(hand, pool, RAPID_TRIALS);
    const quiz = {
      mode: 'arrange', hand, trials, solved: null,
      assignment: { one: [], two: [], four: [] }, selected: null, placeOrder: [],
      answered: false
    };
    // Solve in the background while the player arranges — by the time anyone has placed
    // seven cards, the full 105-partition answer is already waiting.
    quiz.solvePromise = scorePartitionsAsync(allPartitions(hand), trials).then((s) => { quiz.solved = s; return s; });
    return quiz;
  }

  async function buildLockedQuiz() {
    const pool = await loadOpponentPool();
    const { seed, hand } = rapidSeedHand(pool);
    const trials = buildPracticeTrials(hand, pool, RAPID_LOCKED_TRIALS);
    const lockedTwo = [...seed.two]; // the solver's own NLH hand for this holding
    const rest = hand.filter((c) => !lockedTwo.includes(c));
    const parts = rest.map((c) => ({ one: [c], two: lockedTwo, four: rest.filter((x) => x !== c) }));
    const quiz = { mode: 'locked', hand, trials, lockedTwo, rest, parts, solved: null, answered: false, chosenCard: null };
    quiz.solvePromise = scorePartitionsAsync(parts, trials).then((s) => { quiz.solved = s; return s; });
    return quiz;
  }

  async function buildEstimateQuiz() {
    const pool = await loadOpponentPool();
    const { seed, hand } = rapidSeedHand(pool);
    const trials = buildPracticeTrials(hand, pool, RAPID_EST_TRIALS);
    // Half solver splits, half random ones: estimating only good splits would teach you the
    // range of "fine" and nothing about the range of "bad".
    const fromSolver = Math.random() < 0.5;
    const split = fromSolver
      ? { one: [...seed.one], two: [...seed.two], four: [...seed.four] }
      : randomPartitionOf(hand);
    const quiz = { mode: 'estimate', hand, trials, split, fromSolver, result: null, answered: false, guess: null };
    quiz.solvePromise = (async () => {
      await nextTick();
      const r = evalAssignmentAcrossTrials(split, trials, practiceHomerunMode);
      quiz.result = r;
      return r;
    })();
    return quiz;
  }

  function buildQuizForMode(mode) {
    if (mode === 'estimate') return buildEstimateQuiz();
    if (mode === 'locked') return buildLockedQuiz();
    return buildArrangeQuiz();
  }

  function classifyLoss(loss, mode) {
    const tiers = mode === 'estimate' ? RAPID_EST_TIERS : RAPID_TIERS;
    const tol = mode === 'estimate' ? RAPID_EST_TOLERANCE : RAPID_TOLERANCE;
    if (loss <= tol) return { key: 'best', label: mode === 'estimate' ? 'Sharp' : 'Best', mark: '!' };
    return tiers.find((t) => loss <= t.max);
  }

  // A short rising two-note blip — deliberately much shorter than the live game's win
  // chime, since in a drill you hear it many times a minute.
  function playCorrectSound() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    playTone(ctx, 880, now, 0.1, 0.14); // A5
    playTone(ctx, 1318.51, now + 0.075, 0.14, 0.13); // E6
  }

  function rapidActiveQuiz() {
    return rapid && (rapid.retry ? rapid.retry.quiz : rapid.current);
  }
  function rapidModeStats() {
    return rapid.stats[rapid.mode];
  }

  function splitGroupsNode(assignment, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'rapid-split-groups';
    const labels = { one: '1', two: '2', four: '4' };
    ['one', 'two', 'four'].forEach((cat) => {
      const group = document.createElement('span');
      group.className = 'rapid-split-group';
      const lbl = document.createElement('span');
      lbl.className = 'hc-label';
      lbl.textContent = labels[cat] + ':';
      group.appendChild(lbl);
      group.appendChild(cardRow(assignment[cat], { size: opts.size || 'small' }));
      wrap.appendChild(group);
    });
    return wrap;
  }

  function renderRapidStats() {
    const st = rapidModeStats();
    const isEst = rapid.mode === 'estimate';
    const headlineVal = isEst
      ? (st.played ? st.totalAbsErr / st.played : 0)
      : (st.played ? st.totalLoss / st.played : 0);
    const headlineLabel = isEst ? 'Avg estimate error' : 'Avg EV lost / hand';
    const good = isEst ? 1.0 : 0.25;
    const mid = isEst ? 2.5 : 0.9;
    const bias = st.played ? st.totalSignedErr / st.played : 0;
    el('rapidStats').innerHTML = `
      <div class="rapid-stat headline">
        <span class="rs-label">${headlineLabel}</span>
        <span class="rs-value ${headlineVal <= good ? 'good' : headlineVal <= mid ? 'mid' : 'bad'}">${headlineVal.toFixed(3)}</span>
      </div>
      <div class="rapid-stat">
        <span class="rs-label">Hands</span>
        <span class="rs-value">${st.played}</span>
      </div>
      <div class="rapid-stat">
        <span class="rs-label">${isEst ? 'Sharp' : 'Best found'}</span>
        <span class="rs-value">${st.counts.best}${st.played ? ` <span class="rs-sub">(${((st.counts.best / st.played) * 100).toFixed(0)}%)</span>` : ''}</span>
      </div>
      <div class="rapid-stat">
        <span class="rs-label">${isEst ? 'Bias' : 'Streak'}</span>
        <span class="rs-value">${isEst
          ? (st.played ? `${bias > 0 ? '+' : ''}${bias.toFixed(2)} <span class="rs-sub">${Math.abs(bias) < 0.3 ? '(calibrated)' : bias > 0 ? '(too high)' : '(too low)'}</span>` : '—')
          : `${st.streak}${st.bestStreak ? ` <span class="rs-sub">(best ${st.bestStreak})</span>` : ''}`}</span>
      </div>
      <div class="rapid-stat tiers">
        <span class="tier-chip inaccuracy">${isEst ? 'Close' : '?!'} ${st.counts.inaccuracy}</span>
        <span class="tier-chip mistake">${isEst ? 'Off' : '?'} ${st.counts.mistake}</span>
        <span class="tier-chip blunder">${isEst ? 'Way off' : '??'} ${st.counts.blunder}</span>
      </div>`;
    el('rapidMistakeCount').textContent = rapid.mistakes.filter((m) => !m.resolved).length;
  }

  // ---- arrange mode ----
  function rapidTrayCards(quiz) {
    const used = new Set([...quiz.assignment.one, ...quiz.assignment.two, ...quiz.assignment.four]);
    return sortCards(quiz.hand.filter((c) => !used.has(c)), cardSortMode);
  }

  function rapidPlace(quiz, card, slot) {
    if (quiz.assignment[slot].length >= CAPACITY[slot]) return false;
    quiz.assignment[slot].push(card);
    quiz.placeOrder.push({ slot, card });
    return true;
  }

  function rapidUnplace(quiz, card) {
    for (const slot of ['one', 'two', 'four']) {
      if (quiz.assignment[slot].includes(card)) {
        quiz.assignment[slot] = quiz.assignment[slot].filter((c) => c !== card);
        quiz.placeOrder = quiz.placeOrder.filter((p) => p.card !== card);
        return;
      }
    }
  }

  function rapidArrangeComplete(quiz) {
    return quiz.assignment.one.length === 1 && quiz.assignment.two.length === 2 && quiz.assignment.four.length === 4;
  }

  function renderRapidArrange() {
    const quiz = rapidActiveQuiz();
    ['one', 'two', 'four'].forEach((slot) => {
      const container = el('rSlot' + capitalize(slot));
      container.innerHTML = '';
      quiz.assignment[slot].forEach((c) => {
        const node = cardEl(c);
        if (!quiz.answered) {
          node.addEventListener('click', (ev) => {
            ev.stopPropagation();
            rapidUnplace(quiz, c);
            quiz.selected = null;
            renderRapidArrange();
          });
        }
        container.appendChild(node);
      });
    });

    const tray = el('rTray');
    tray.innerHTML = '';
    if (quiz.answered) {
      const msg = document.createElement('div');
      msg.className = 'hint';
      msg.textContent = 'Graded — see below.';
      tray.appendChild(msg);
    } else {
      rapidTrayCards(quiz).forEach((c, i) => {
        const node = cardEl(c);
        if (quiz.selected === c) node.classList.add('selected');
        const num = document.createElement('span');
        num.className = 'rapid-tray-key';
        num.textContent = String(i + 1);
        node.appendChild(num);
        node.addEventListener('click', (ev) => {
          if (ev.metaKey || ev.ctrlKey) {
            rapidPlaceFirstOpen(quiz, c);
            quiz.selected = null;
          } else {
            quiz.selected = quiz.selected === c ? null : c;
          }
          renderRapidArrange();
        });
        tray.appendChild(node);
      });
    }

    document.querySelectorAll('#rapidSlots .slot').forEach((slotDiv) => {
      slotDiv.onclick = () => {
        if (quiz.answered || !quiz.selected) return;
        if (rapidPlace(quiz, quiz.selected, slotDiv.dataset.rslot)) quiz.selected = null;
        renderRapidArrange();
      };
    });

    el('btnRapidSubmit').disabled = quiz.answered || !rapidArrangeComplete(quiz);
    el('btnRapidClear').disabled = quiz.answered;
  }

  function rapidPlaceFirstOpen(quiz, card) {
    for (const slot of ['one', 'two', 'four']) {
      if (quiz.assignment[slot].length < CAPACITY[slot]) { rapidPlace(quiz, card, slot); return true; }
    }
    return false;
  }

  // ---- locked-NLH mode ----
  function renderRapidLocked() {
    const quiz = rapidActiveQuiz();
    const lockedWrap = el('rapidLockedTwo');
    lockedWrap.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.className = 'hc-label';
    lbl.textContent = 'Locked 2-card NLH hand:';
    lockedWrap.appendChild(lbl);
    lockedWrap.appendChild(cardRow(quiz.lockedTwo));

    const choices = el('rapidLockedChoices');
    choices.innerHTML = '';
    sortCards(quiz.rest, cardSortMode).forEach((card, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rapid-locked-choice';
      btn.disabled = quiz.answered;

      const num = document.createElement('span');
      num.className = 'rapid-opt-num';
      num.textContent = String(i + 1);
      btn.appendChild(num);

      const oneWrap = document.createElement('span');
      oneWrap.className = 'rlc-part';
      const oneLbl = document.createElement('span');
      oneLbl.className = 'hc-label';
      oneLbl.textContent = '1:';
      oneWrap.appendChild(oneLbl);
      oneWrap.appendChild(cardRow([card], { size: 'small' }));
      btn.appendChild(oneWrap);

      const ploWrap = document.createElement('span');
      ploWrap.className = 'rlc-part';
      const ploLbl = document.createElement('span');
      ploLbl.className = 'hc-label';
      ploLbl.textContent = '4:';
      ploWrap.appendChild(ploLbl);
      ploWrap.appendChild(cardRow(quiz.rest.filter((x) => x !== card), { size: 'small' }));
      btn.appendChild(ploWrap);

      const meta = document.createElement('span');
      meta.className = 'rapid-opt-meta';
      if (quiz.answered && quiz.solved) {
        const entry = quiz.solved.find((s) => s.assignment.one[0] === card);
        const loss = quiz.solved[0].ev - entry.ev;
        const ev = document.createElement('span');
        ev.className = 'rapid-opt-ev';
        ev.textContent = `${fmtEv(entry.ev)} EV`;
        meta.appendChild(ev);
        if (loss > RAPID_TOLERANCE) {
          const l = document.createElement('span');
          l.className = 'rapid-opt-loss';
          l.textContent = `−${loss.toFixed(2)}`;
          meta.appendChild(l);
        }
        if (entry.key === quiz.solved[0].key) btn.classList.add('is-best');
        else if (loss <= RAPID_TOLERANCE) btn.classList.add('is-close');
        if (card === quiz.chosenCard) btn.classList.add('is-chosen');
      }
      btn.appendChild(meta);

      if (!quiz.answered) btn.addEventListener('click', () => rapidAnswerLocked(card));
      choices.appendChild(btn);
    });
  }

  // ---- estimate mode ----
  function renderRapidEstimate() {
    const quiz = rapidActiveQuiz();
    const wrap = el('rapidEstSplit');
    wrap.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.className = 'hc-label';
    lbl.textContent = 'Estimate the EV of this split:';
    wrap.appendChild(lbl);
    wrap.appendChild(splitGroupsNode(quiz.split, { size: 'normal' }));

    el('rapidEstInput').disabled = quiz.answered;
    el('btnRapidEstSubmit').disabled = quiz.answered;
    if (!quiz.answered) {
      el('rapidEstInput').value = '';
      el('rapidEstReveal').classList.add('hidden');
    }
  }

  function renderRapidEstimateReveal() {
    const quiz = rapidActiveQuiz();
    const r = quiz.result;
    const reveal = el('rapidEstReveal');
    const rows = ['one', 'two', 'four'].map((cat) => {
      const a = r.avgCells[cat][0];
      const b = r.avgCells[cat][1];
      return `<div class="pcat-row">
        <div class="pcat-label">${SLOT_TITLES[cat]}</div>
        <div><span class="pcell-sub">Board A: </span><span class="pcell ${a > 0 ? 'pos' : a < 0 ? 'neg' : 'even'}">${fmtEv(a)}</span></div>
        <div><span class="pcell-sub">Board B: </span><span class="pcell ${b > 0 ? 'pos' : b < 0 ? 'neg' : 'even'}">${fmtEv(b)}</span></div>
      </div>`;
    }).join('');
    reveal.innerHTML = `
      <div class="rapid-est-compare">
        <span>Your estimate: <strong>${fmtEv(quiz.guess)}</strong></span>
        <span>Actual: <strong class="pscore ${r.avgTotal > 0 ? 'pos' : r.avgTotal < 0 ? 'neg' : ''}">${fmtEv(r.avgTotal)}</strong></span>
        <span class="rapid-est-err">off by ${Math.abs(r.avgTotal - quiz.guess).toFixed(2)}</span>
      </div>
      <div class="practice-ev-breakdown">${rows}</div>
      <p class="practice-homerun-rate">⚾ This split swept ${r.homerunWins}/${r.n} boards · got swept ${r.homerunLosses}/${r.n}</p>
      <p class="hint" style="margin-bottom:0;">${quiz.fromSolver ? "This was the solver's own split for this hand." : 'This was a randomly generated split, not the solver\'s.'}</p>`;
    reveal.classList.remove('hidden');
  }

  // ---- shared rendering ----
  function renderRapidDrill() {
    const quiz = rapidActiveQuiz();
    const isRetry = !!(rapid && rapid.retry);

    el('rapidRetryBanner').classList.toggle('hidden', !isRetry);
    if (isRetry) {
      const m = rapid.retry.mistake;
      el('rapidRetryBanner').innerHTML = `↻ Retrying a stored ${m.tier.label.toLowerCase()} — same hand, same boards. Retries don't count toward your session average.`;
    }

    document.querySelectorAll('#rapidModeRow .rapid-mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.rapidMode === rapid.mode);
      b.disabled = isRetry;
    });
    el('rapidModeHint').textContent = RAPID_MODE_HINTS[rapid.mode];

    ['rapidArrange', 'rapidEstimate', 'rapidLocked'].forEach((id) => el(id).classList.add('hidden'));
    if (!quiz) {
      el('rapidLoading').classList.remove('hidden');
      el('btnRapidNext').classList.add('hidden');
      return;
    }
    el('rapidLoading').classList.add('hidden');

    if (quiz.mode === 'arrange') { el('rapidArrange').classList.remove('hidden'); renderRapidArrange(); }
    else if (quiz.mode === 'locked') { el('rapidLocked').classList.remove('hidden'); renderRapidLocked(); }
    else { el('rapidEstimate').classList.remove('hidden'); renderRapidEstimate(); if (quiz.answered) renderRapidEstimateReveal(); }

    el('btnRapidNext').classList.toggle('hidden', !quiz.answered);
    el('btnRapidNext').textContent = isRetry ? 'Back to Mistakes' : 'Next Hand (Enter)';
  }

  function rapidRecord(tier, loss, signedErr, quiz, extra) {
    const isRetry = !!rapid.retry;
    const correct = tier.key === 'best';
    if (isRetry) {
      const m = rapid.retry.mistake;
      m.attempts = (m.attempts || 0) + 1;
      if (correct) m.resolved = true;
    } else {
      const st = rapidModeStats();
      st.played++;
      st.totalLoss += loss;
      st.totalAbsErr += Math.abs(signedErr === null ? loss : signedErr);
      if (signedErr !== null) st.totalSignedErr += signedErr;
      st.counts[tier.key]++;
      if (correct) {
        st.streak++;
        if (st.streak > st.bestStreak) st.bestStreak = st.streak;
      } else {
        st.streak = 0;
        // Estimate mode is deliberately not retryable: once you've been told the answer,
        // re-guessing the same hand tests memory, not calibration.
        if (quiz.mode !== 'estimate') {
          rapid.mistakeSeq++;
          rapid.mistakes.push(Object.assign({
            id: rapid.mistakeSeq, mode: quiz.mode, hand: quiz.hand, trials: quiz.trials,
            solved: quiz.solved, loss, tier, attempts: 0, resolved: false
          }, extra));
        }
      }
    }
    if (correct) playCorrectSound();
    return correct;
  }

  async function rapidSubmitArrange() {
    const quiz = rapidActiveQuiz();
    if (!quiz || quiz.answered || !rapidArrangeComplete(quiz)) return;
    if (!quiz.solved) {
      el('rapidFeedback').className = 'rapid-feedback';
      el('rapidFeedback').textContent = 'Grading all 105 splits…';
      el('rapidFeedback').classList.remove('hidden');
      await quiz.solvePromise;
    }
    quiz.answered = true;
    const key = fmtAssignmentKey(quiz.assignment);
    const rank = quiz.solved.findIndex((s) => s.key === key);
    const mine = quiz.solved[rank];
    const best = quiz.solved[0];
    const loss = Math.max(0, best.ev - mine.ev);
    const tier = classifyLoss(loss, 'arrange');
    const correct = rapidRecord(tier, loss, null, quiz, {
      userAssignment: deepCopy(quiz.assignment), bestAssignment: best.assignment,
      userEv: mine.ev, bestEv: best.ev, rank
    });

    const fb = el('rapidFeedback');
    fb.className = 'rapid-feedback tier-' + tier.key;
    fb.innerHTML = `<strong>${tier.mark} ${correct ? (rapid.retry ? 'Fixed' : 'Best split') : tier.label}</strong>
      <span class="fb-sub">your split graded ${fmtEv(mine.ev)} EV · ranked #${rank + 1} of ${quiz.solved.length}${correct ? '' : ` · the best split was ${fmtEv(best.ev)}, costing you ${loss.toFixed(2)} pts/hand`}</span>`;
    if (!correct) {
      const cmp = document.createElement('div');
      cmp.className = 'rapid-best-reveal';
      const lbl = document.createElement('span');
      lbl.className = 'hc-label';
      lbl.textContent = 'Best split:';
      cmp.appendChild(lbl);
      cmp.appendChild(splitGroupsNode(best.assignment));
      fb.appendChild(cmp);
    }
    fb.classList.remove('hidden');

    renderRapidStats();
    renderRapidDrill();
    renderRapidMistakes();
    if (correct && !rapid.retry) setTimeout(() => { if (rapid && rapid.view === 'drill' && !rapid.retry) rapidNext(); }, 1100);
  }

  async function rapidAnswerLocked(card) {
    const quiz = rapidActiveQuiz();
    if (!quiz || quiz.answered) return;
    if (!quiz.solved) await quiz.solvePromise;
    quiz.answered = true;
    quiz.chosenCard = card;
    const mine = quiz.solved.find((s) => s.assignment.one[0] === card);
    const best = quiz.solved[0];
    const rank = quiz.solved.findIndex((s) => s.key === mine.key);
    const loss = Math.max(0, best.ev - mine.ev);
    const tier = classifyLoss(loss, 'locked');
    const correct = rapidRecord(tier, loss, null, quiz, {
      userAssignment: mine.assignment, bestAssignment: best.assignment,
      userEv: mine.ev, bestEv: best.ev, rank, lockedTwo: quiz.lockedTwo, rest: quiz.rest, parts: quiz.parts
    });

    const fb = el('rapidFeedback');
    fb.className = 'rapid-feedback tier-' + tier.key;
    fb.innerHTML = `<strong>${tier.mark} ${correct ? (rapid.retry ? 'Fixed' : 'Best completion') : tier.label}</strong>
      <span class="fb-sub">${fmtEv(mine.ev)} EV · ranked #${rank + 1} of ${quiz.solved.length} completions${correct ? '' : ` · best was ${fmtEv(best.ev)}, costing you ${loss.toFixed(2)} pts/hand`}</span>`;
    fb.classList.remove('hidden');

    renderRapidStats();
    renderRapidDrill();
    renderRapidMistakes();
    if (correct && !rapid.retry) setTimeout(() => { if (rapid && rapid.view === 'drill' && !rapid.retry) rapidNext(); }, 1100);
  }

  async function rapidSubmitEstimate() {
    const quiz = rapidActiveQuiz();
    if (!quiz || quiz.answered) return;
    const raw = el('rapidEstInput').value.trim();
    if (raw === '' || isNaN(Number(raw))) {
      el('rapidEstInput').focus();
      return;
    }
    if (!quiz.result) await quiz.solvePromise;
    quiz.answered = true;
    quiz.guess = Number(raw);
    const signedErr = quiz.guess - quiz.result.avgTotal; // positive = you were too optimistic
    const absErr = Math.abs(signedErr);
    const tier = classifyLoss(absErr, 'estimate');
    const correct = rapidRecord(tier, absErr, signedErr, quiz, null);

    const fb = el('rapidFeedback');
    fb.className = 'rapid-feedback tier-' + tier.key;
    fb.innerHTML = `<strong>${tier.mark} ${tier.label}</strong>
      <span class="fb-sub">off by ${absErr.toFixed(2)} pts/hand — you read it ${signedErr > 0 ? 'better' : 'worse'} than it actually is</span>`;
    fb.classList.remove('hidden');

    renderRapidStats();
    renderRapidDrill();
    if (correct && !rapid.retry) setTimeout(() => { if (rapid && rapid.view === 'drill' && !rapid.retry) rapidNext(); }, 1400);
  }

  function rapidSubmit() {
    const quiz = rapidActiveQuiz();
    if (!quiz) return;
    if (quiz.mode === 'arrange') rapidSubmitArrange();
    else if (quiz.mode === 'estimate') rapidSubmitEstimate();
  }

  async function rapidNext() {
    if (!rapid) return;
    if (rapid.retry) {
      rapid.retry = null;
      setRapidView('mistakes');
      return;
    }
    el('rapidFeedback').classList.add('hidden');
    if (rapid.next) {
      rapid.current = rapid.next;
      rapid.next = null;
      renderRapidDrill();
      preloadRapidNext();
      return;
    }
    if (rapid.loading) return;
    rapid.loading = true;
    rapid.current = null;
    renderRapidDrill();
    const mode = rapid.mode;
    const quiz = await buildQuizForMode(mode);
    rapid.loading = false;
    if (!rapid || rapid.mode !== mode) return; // mode switched while building
    rapid.current = quiz;
    renderRapidDrill();
    preloadRapidNext();
  }

  async function preloadRapidNext() {
    if (!rapid || rapid.next || rapid.loading) return;
    const mode = rapid.mode;
    const quiz = await buildQuizForMode(mode);
    if (rapid && rapid.mode === mode && !rapid.next) rapid.next = quiz;
  }

  async function setRapidMode(mode) {
    if (!rapid || rapid.mode === mode || rapid.retry) return;
    rapid.mode = mode;
    rapid.current = null;
    rapid.next = null;
    el('rapidFeedback').classList.add('hidden');
    renderRapidStats();
    renderRapidDrill();
    await rapidNext();
  }

  function renderRapidMistakes() {
    const list = el('rapidMistakeList');
    list.innerHTML = '';
    if (!rapid.mistakes.length) {
      show('rapidMistakeEmpty');
      return;
    }
    hide('rapidMistakeEmpty');
    [...rapid.mistakes].reverse().forEach((m) => {
      const item = document.createElement('div');
      item.className = 'rapid-mistake' + (m.resolved ? ' resolved' : '');

      const head = document.createElement('div');
      head.className = 'rm-head';
      head.innerHTML = `
        <span class="tier-chip ${m.tier.key}">${m.tier.mark} ${m.tier.label}</span>
        <span class="rm-mode">${m.mode === 'locked' ? 'Locked NLH' : 'Arrange'}</span>
        <span class="rm-loss">−${m.loss.toFixed(2)} pts/hand</span>
        ${m.resolved ? '<span class="rm-fixed">✓ fixed on retry</span>' : m.attempts ? `<span class="rm-tries">${m.attempts} attempt${m.attempts === 1 ? '' : 's'}</span>` : ''}`;
      item.appendChild(head);

      const handWrap = document.createElement('div');
      handWrap.className = 'rm-hand';
      const hl = document.createElement('span');
      hl.className = 'hc-label';
      hl.textContent = 'Hand:';
      handWrap.appendChild(hl);
      handWrap.appendChild(cardRow(sortCards(m.hand, cardSortMode), { size: 'small' }));
      item.appendChild(handWrap);

      const cmp = document.createElement('div');
      cmp.className = 'rm-compare';
      [['You played', m.userAssignment, m.userEv, 'bad'], ['Best was', m.bestAssignment, m.bestEv, 'good']].forEach(([label, assignment, ev, cls]) => {
        const line = document.createElement('div');
        line.className = 'rm-line ' + cls;
        const lab = document.createElement('span');
        lab.className = 'hc-label';
        lab.textContent = label + ':';
        line.appendChild(lab);
        line.appendChild(splitGroupsNode(assignment));
        const evs = document.createElement('span');
        evs.className = 'rapid-opt-ev';
        evs.textContent = `${fmtEv(ev)} EV`;
        line.appendChild(evs);
        cmp.appendChild(line);
      });
      item.appendChild(cmp);

      const actions = document.createElement('div');
      actions.className = 'rm-actions';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'secondary';
      retryBtn.textContent = m.resolved ? 'Retry again' : 'Retry this hand';
      retryBtn.addEventListener('click', () => startRapidRetry(m.id));
      actions.appendChild(retryBtn);
      const dropBtn = document.createElement('button');
      dropBtn.className = 'secondary';
      dropBtn.textContent = 'Remove';
      dropBtn.addEventListener('click', () => {
        rapid.mistakes = rapid.mistakes.filter((x) => x.id !== m.id);
        renderRapidStats();
        renderRapidMistakes();
      });
      actions.appendChild(dropBtn);
      item.appendChild(actions);

      list.appendChild(item);
    });
  }

  // Re-drill a stored mistake on the exact same hand and boards, graded against the same
  // precomputed solve — so a retry is a real second attempt at the same problem, with the
  // arrangement cleared so you have to rebuild it rather than recognize a position.
  function startRapidRetry(mistakeId) {
    const m = rapid.mistakes.find((x) => x.id === mistakeId);
    if (!m) return;
    const quiz = m.mode === 'locked'
      ? { mode: 'locked', hand: m.hand, trials: m.trials, lockedTwo: m.lockedTwo, rest: m.rest, parts: m.parts,
          solved: m.solved, solvePromise: Promise.resolve(m.solved), answered: false, chosenCard: null }
      : { mode: 'arrange', hand: m.hand, trials: m.trials, solved: m.solved, solvePromise: Promise.resolve(m.solved),
          assignment: { one: [], two: [], four: [] }, selected: null, placeOrder: [], answered: false };
    rapid.retry = { mistake: m, quiz };
    el('rapidFeedback').classList.add('hidden');
    setRapidView('drill');
  }

  function setRapidView(view) {
    rapid.view = view;
    el('rapid-tab-drill').classList.toggle('hidden', view !== 'drill');
    el('rapid-tab-mistakes').classList.toggle('hidden', view !== 'mistakes');
    document.querySelectorAll('#rapidTabs .tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.rapidTab === view);
    });
    if (view === 'drill') renderRapidDrill(); else renderRapidMistakes();
  }

  async function startRapidFire() {
    hide('screen-landing');
    show('screen-rapid');
    rapid = rapidNewState();
    renderRapidStats();
    renderRapidMistakes();
    el('rapidFeedback').classList.add('hidden');
    setRapidView('drill');
    await rapidNext();
  }

  el('btnRapidStart').addEventListener('click', () => { startRapidFire(); });
  el('btnRapidNext').addEventListener('click', () => rapidNext());
  el('btnRapidSubmit').addEventListener('click', () => rapidSubmitArrange());
  el('btnRapidEstSubmit').addEventListener('click', () => rapidSubmitEstimate());
  el('btnRapidClear').addEventListener('click', () => {
    const quiz = rapidActiveQuiz();
    if (!quiz || quiz.answered || quiz.mode !== 'arrange') return;
    quiz.assignment = { one: [], two: [], four: [] };
    quiz.placeOrder = [];
    quiz.selected = null;
    renderRapidArrange();
  });
  el('btnRapidBack').addEventListener('click', () => {
    rapid = null;
    hide('screen-rapid');
    show('screen-landing');
  });
  document.querySelectorAll('#rapidModeRow .rapid-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setRapidMode(btn.dataset.rapidMode));
  });
  document.querySelectorAll('#rapidTabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setRapidView(btn.dataset.rapidTab));
  });
  wireSortControl('rapidSortControl', () => { if (rapid && rapid.view === 'drill') renderRapidDrill(); });

  document.addEventListener('keydown', (ev) => {
    if (!rapid || el('screen-rapid').classList.contains('hidden')) return;
    const quiz = rapidActiveQuiz();
    const typing = ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);

    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!quiz) return;
      if (quiz.answered) rapidNext(); else rapidSubmit();
      return;
    }
    if (typing || !quiz || quiz.answered) return;

    if (/^[1-9]$/.test(ev.key)) {
      const i = Number(ev.key) - 1;
      if (quiz.mode === 'arrange') {
        const tray = rapidTrayCards(quiz);
        if (i < tray.length) { ev.preventDefault(); rapidPlaceFirstOpen(quiz, tray[i]); quiz.selected = null; renderRapidArrange(); }
      } else if (quiz.mode === 'locked') {
        const choices = sortCards(quiz.rest, cardSortMode);
        if (i < choices.length) { ev.preventDefault(); rapidAnswerLocked(choices[i]); }
      }
      return;
    }
    if (ev.key === 'Backspace' && quiz.mode === 'arrange' && quiz.placeOrder.length) {
      ev.preventDefault();
      rapidUnplace(quiz, quiz.placeOrder[quiz.placeOrder.length - 1].card);
      renderRapidArrange();
    }
  });

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
