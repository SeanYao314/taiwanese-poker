// lib/bot.js — a GTO-ish bot seat for live rooms.
//
// A bot can't just look its hand up: public/opponent-pool.json holds 5,400 specific hands,
// and a freshly dealt 7-card hand is essentially never one of them. So it solves its own
// hand — score all 105 ways to split it against a sample of (opponent split, board pair)
// trials and keep the best — where the opponents sampled ARE drawn from the solved pool,
// so it's best-responding to near-equilibrium play rather than to random splitting.
// Homerun scoring is included, since it's always on.
//
// HOW IT STAYS FAST
// The naive version evaluates each partition's three hands against each board, which is
// ~10,000 five-card evaluations per trial and takes ~100ms. Almost all of that is repeated
// work, because across all 105 partitions of the same 7 cards there are only:
//   * 7 distinct 1-card hands
//   * 21 distinct 2-card hands
//   * 21 distinct hole PAIRS -- and a PLO hand is by definition "exactly 2 hole cards plus
//     exactly 3 board cards", so the best PLO hand for a 4-card group is just the best of
//     its 6 pairs. The 4-card groups never need evaluating at all.
// So per board we evaluate three small tables once -- the board on its own, each single
// card with 4 board cards, and each pair with 3 board cards -- and then every hand any
// partition could hold is a max over a couple of table entries:
//   1-card {c}        = max(boardOnly, single[c])
//   2-card {a,b}      = max(boardOnly, single[a], single[b], pair[a,b])
//   4-card PLO {abcd} = max(pair[ab], pair[ac], ... ) over its 6 pairs
// That's 246 evaluations per board instead of ~5,000, and scoring a partition afterwards is
// table lookups and integer adds. Measured at ~15x faster end to end.
//
// The work is also time-sliced: the server is a single-threaded Node process holding every
// player's SSE stream, so the solve yields back to the event loop every few milliseconds
// rather than blocking the table while a bot "thinks".
const P = require('./poker.js');

const POINTS = { one: 1, two: 2, four: 3 };
const MATCH_TOTAL = (POINTS.one + POINTS.two + POINTS.four) * 2; // 12 — full-match swing
const DEFAULT_TRIALS = Number(process.env.BOT_TRIALS) || 300;
const SLICE_MS = Number(process.env.BOT_SLICE_MS) || 6; // max ms to hold the event loop

// ---- fixed index tables (a hand is always 7 cards, a board always 5) ----
function combosOf(n, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < n; i++) { acc.push(i); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}
const BOARD_4 = combosOf(5, 4); // 5 ways to use 4 board cards
const BOARD_3 = combosOf(5, 3); // 10 ways to use 3 board cards
const HAND_PAIRS = combosOf(7, 2); // 21 hole pairs
const PAIR_INDEX = (() => {
  const m = new Int8Array(49).fill(-1);
  HAND_PAIRS.forEach(([i, j], k) => { m[i * 7 + j] = k; m[j * 7 + i] = k; });
  return m;
})();
const HAND_QUADS = combosOf(7, 4); // 35 four-card groups
// every quad's 6 constituent pairs, as indices into HAND_PAIRS
const QUAD_PAIRS = HAND_QUADS.map((q) => {
  const out = [];
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) out.push(PAIR_INDEX[q[a] * 7 + q[b]]);
  return out;
});
// the 105 partitions, as (1-card index, 2-card pair index, 4-card quad index)
const PARTITIONS = (() => {
  const quadKey = new Map();
  HAND_QUADS.forEach((q, idx) => quadKey.set(q.join(','), idx));
  const out = [];
  for (let one = 0; one < 7; one++) {
    const rest = [0, 1, 2, 3, 4, 5, 6].filter((i) => i !== one);
    for (let a = 0; a < rest.length; a++) {
      for (let b = a + 1; b < rest.length; b++) {
        const i = rest[a];
        const j = rest[b];
        const quad = rest.filter((x) => x !== i && x !== j);
        out.push({ one, pair: PAIR_INDEX[i * 7 + j], quad: quadKey.get(quad.join(',')) });
      }
    }
  }
  return out;
})();

function partitionToAssignment(hand, part) {
  const [pi, pj] = HAND_PAIRS[part.pair];
  return {
    one: [hand[part.one]],
    two: [hand[pi], hand[pj]],
    four: HAND_QUADS[part.quad].map((i) => hand[i])
  };
}

// All 105 ways to partition a 7-card hand (kept for callers/tests).
function allPartitions(hand) {
  return PARTITIONS.map((p) => partitionToAssignment(hand, p));
}

function fallbackSplit(hand) {
  return { one: [hand[0]], two: [hand[1], hand[2]], four: hand.slice(3, 7) };
}

// Hand strengths here are integers from P.eval5i, so "better" is just the larger one and
// nothing is allocated — see the note above eval5i in lib/poker.js.
const BOARD_I = new Int32Array(5);
const OPP_I = new Int32Array(4);

// The opponent's hand on the board currently in BOARD_I. 1-card and 2-card hands may use
// fewer than all their cards (so the board alone is their floor); PLO must use exactly two.
function oppBest(cards, isPLO, boardOnly) {
  const ev5 = P.eval5i;
  for (let i = 0; i < cards.length; i++) OPP_I[i] = P.cardToInt(cards[i]);
  let v = isPLO ? -1 : boardOnly;
  if (!isPLO) {
    for (let i = 0; i < cards.length; i++) {
      for (let s = 0; s < BOARD_4.length; s++) {
        const sub = BOARD_4[s];
        const x = ev5(OPP_I[i], BOARD_I[sub[0]], BOARD_I[sub[1]], BOARD_I[sub[2]], BOARD_I[sub[3]]);
        if (x > v) v = x;
      }
    }
  }
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      for (let s = 0; s < BOARD_3.length; s++) {
        const sub = BOARD_3[s];
        const x = ev5(OPP_I[i], OPP_I[j], BOARD_I[sub[0]], BOARD_I[sub[1]], BOARD_I[sub[2]]);
        if (x > v) v = x;
      }
    }
  }
  return v;
}

// Scratch buffers, allocated once per solve and overwritten each trial. A solve runs
// thousands of these loops, and churning fresh arrays per trial costs more than the
// comparisons do.
function makeScratch() {
  return {
    handI: new Int32Array(7),
    single: new Int32Array(7),
    pair: new Int32Array(HAND_PAIRS.length),
    d1: [new Int8Array(7), new Int8Array(7)],
    d2: [new Int8Array(HAND_PAIRS.length), new Int8Array(HAND_PAIRS.length)],
    d4: [new Int8Array(HAND_QUADS.length), new Int8Array(HAND_QUADS.length)]
  };
}

// Per-board deltas for every hand any partition could hold, versus this trial's opponent.
function trialDeltas(hand, trial, sc) {
  const { handI, single, pair, d1, d2, d4 } = sc;
  const ev5 = P.eval5i;
  for (let c = 0; c < 7; c++) handI[c] = P.cardToInt(hand[c]);

  for (let b = 0; b < 2; b++) {
    const board = b === 0 ? trial.boardA : trial.boardB;
    for (let i = 0; i < 5; i++) BOARD_I[i] = P.cardToInt(board[i]);
    const b0 = BOARD_I[0], b1 = BOARD_I[1], b2 = BOARD_I[2], b3 = BOARD_I[3], b4 = BOARD_I[4];

    // the three tables: board alone, each card + 4 board, each pair + 3 board
    const boardOnly = ev5(b0, b1, b2, b3, b4);
    for (let c = 0; c < 7; c++) {
      const h = handI[c];
      let v = ev5(h, b1, b2, b3, b4);
      let x = ev5(h, b0, b2, b3, b4); if (x > v) v = x;
      x = ev5(h, b0, b1, b3, b4); if (x > v) v = x;
      x = ev5(h, b0, b1, b2, b4); if (x > v) v = x;
      x = ev5(h, b0, b1, b2, b3); if (x > v) v = x;
      single[c] = v;
    }
    for (let k = 0; k < HAND_PAIRS.length; k++) {
      const hi = handI[HAND_PAIRS[k][0]];
      const hj = handI[HAND_PAIRS[k][1]];
      let v = -1;
      for (let s = 0; s < BOARD_3.length; s++) {
        const sub = BOARD_3[s];
        const x = ev5(hi, hj, BOARD_I[sub[0]], BOARD_I[sub[1]], BOARD_I[sub[2]]);
        if (x > v) v = x;
      }
      pair[k] = v;
    }

    const oppOne = oppBest(trial.oppSplit.one, false, boardOnly);
    const oppTwo = oppBest(trial.oppSplit.two, false, boardOnly);
    const oppFour = oppBest(trial.oppSplit.four, true, boardOnly);

    for (let c = 0; c < 7; c++) {
      const mine = single[c] > boardOnly ? single[c] : boardOnly;
      d1[b][c] = mine > oppOne ? POINTS.one : mine < oppOne ? -POINTS.one : 0;
    }
    for (let k = 0; k < HAND_PAIRS.length; k++) {
      let mine = pair[k] > boardOnly ? pair[k] : boardOnly;
      const si = single[HAND_PAIRS[k][0]]; if (si > mine) mine = si;
      const sj = single[HAND_PAIRS[k][1]]; if (sj > mine) mine = sj;
      d2[b][k] = mine > oppTwo ? POINTS.two : mine < oppTwo ? -POINTS.two : 0;
    }
    for (let q = 0; q < HAND_QUADS.length; q++) {
      const pairs = QUAD_PAIRS[q];
      let mine = pair[pairs[0]];
      for (let x = 1; x < pairs.length; x++) if (pair[pairs[x]] > mine) mine = pair[pairs[x]];
      d4[b][q] = mine > oppFour ? POINTS.four : mine < oppFour ? -POINTS.four : 0;
    }
  }
  return sc;
}

// Adds one trial's points for all 105 partitions into `totals`.
function accumulateTrial(hand, trial, totals, sc) {
  const { d1, d2, d4 } = trialDeltas(hand, trial, sc || makeScratch());
  for (let p = 0; p < PARTITIONS.length; p++) {
    const part = PARTITIONS[p];
    const a1 = d1[0][part.one];
    const b1 = d1[1][part.one];
    const a2 = d2[0][part.pair];
    const b2 = d2[1][part.pair];
    const a4 = d4[0][part.quad];
    const b4 = d4[1][part.quad];
    let pts = a1 + b1 + a2 + b2 + a4 + b4;
    if (a1 > 0 && b1 > 0 && a2 > 0 && b2 > 0 && a4 > 0 && b4 > 0) pts += MATCH_TOTAL;
    else if (a1 < 0 && b1 < 0 && a2 < 0 && b2 < 0 && a4 < 0 && b4 < 0) pts -= MATCH_TOTAL;
    totals[p] += pts;
  }
}

// One trial = a specific opponent split paired with a specific two-board runout. The
// opponent is drawn from the solved pool (skipping any entry sharing a card with the bot's
// hand); boards come from what's left in the deck. The bot does NOT know the other seats'
// actual cards, which is correct — that's hidden information.
function buildTrials(hand, pool, count) {
  const handSet = new Set(hand);
  const qualifying = pool.filter((e) => {
    const cards = [...e.one, ...e.two, ...e.four];
    return cards.length === 7 && cards.every((c) => !handSet.has(c));
  });
  const deckMinusHand = P.freshDeck().filter((c) => !handSet.has(c));
  const trials = [];
  for (let i = 0; i < count; i++) {
    let oppSplit;
    if (qualifying.length) {
      oppSplit = qualifying[Math.floor(Math.random() * qualifying.length)];
    } else {
      // No pool available (missing/empty file) — fall back to a random opponent so a bot
      // still plays a legal, sane hand rather than breaking the table.
      oppSplit = fallbackSplit(P.shuffle(deckMinusHand).slice(0, 7));
    }
    const used = new Set([...oppSplit.one, ...oppSplit.two, ...oppSplit.four]);
    const rest = P.shuffle(deckMinusHand.filter((c) => !used.has(c)));
    trials.push({ oppSplit, boardA: rest.slice(0, 5), boardB: rest.slice(5, 10) });
  }
  return trials;
}

// Total points for each of the 105 partitions across a trial set. Exported so tests can
// check the fast path against a naive evaluation.
function scoreAllPartitions(hand, trials) {
  const totals = new Float64Array(PARTITIONS.length);
  const sc = makeScratch();
  for (const t of trials) accumulateTrial(hand, t, totals, sc);
  return totals;
}

function chooseSplit(hand, pool, options = {}) {
  const trialCount = options.trials || DEFAULT_TRIALS;
  const sliceMs = options.sliceMs || SLICE_MS;
  return new Promise((resolve) => {
    let trials;
    try {
      trials = buildTrials(hand, pool || [], trialCount);
    } catch (e) {
      resolve(fallbackSplit(hand));
      return;
    }
    if (!trials.length) { resolve(fallbackSplit(hand)); return; }

    const totals = new Float64Array(PARTITIONS.length);
    const sc = makeScratch();
    let ti = 0;

    function step() {
      const started = Date.now();
      // Time-sliced rather than fixed-size: bounds how long the event loop is held
      // regardless of how fast the machine is or how many bots are solving at once.
      do {
        accumulateTrial(hand, trials[ti++], totals, sc);
      } while (ti < trials.length && Date.now() - started < sliceMs);

      if (ti < trials.length) { setImmediate(step); return; }
      let best = 0;
      for (let i = 1; i < totals.length; i++) if (totals[i] > totals[best]) best = i;
      resolve(partitionToAssignment(hand, PARTITIONS[best]));
    }
    setImmediate(step); // never block the caller's tick (an HTTP handler) with trial 1
  });
}

module.exports = {
  chooseSplit, allPartitions, buildTrials, fallbackSplit, scoreAllPartitions,
  partitionToAssignment, PARTITIONS, DEFAULT_TRIALS
};
