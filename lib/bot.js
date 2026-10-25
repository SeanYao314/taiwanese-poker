// lib/bot.js — a GTO-ish bot seat for live rooms.
//
// A bot can't just look its hand up in the solved pool: public/opponent-pool.json holds
// 5,400 specific hands, and a freshly dealt 7-card hand is essentially never one of them.
// So it solves its own hand the same way Practice Mode's "Show Ideal Split" does — score
// all 105 ways to split the hand against a sample of (opponent split, board pair) trials
// and keep the best — where the opponents sampled ARE drawn from the solved pool, so it's
// best-responding to near-equilibrium play rather than to random splitting. Homerun
// scoring is included, since it's always on.
//
// The work is deliberately chunked with setImmediate between batches. The server is a
// single-threaded Node process serving SSE streams; a synchronous two-second solve would
// freeze every other player at the table while a bot "thinks".
const P = require('./poker.js');

const POINTS = { one: 1, two: 2, four: 3 };
const MATCH_TOTAL = (POINTS.one + POINTS.two + POINTS.four) * 2; // 12 — full-match swing
const DEFAULT_TRIALS = Number(process.env.BOT_TRIALS) || 60;

// All 105 ways to partition a 7-card hand into (1-card, 2-card, 4-card) groups.
function allPartitions(hand) {
  const out = [];
  for (let i = 0; i < hand.length; i++) {
    const rest6 = hand.filter((_, idx) => idx !== i);
    for (const pair of P.combinations(rest6, 2)) {
      out.push({ one: [hand[i]], two: pair, four: rest6.filter((c) => !pair.includes(c)) });
    }
  }
  return out;
}

function fallbackSplit(hand) {
  return { one: [hand[0]], two: [hand[1], hand[2]], four: hand.slice(3, 7) };
}

// One trial = a specific opponent split paired with a specific two-board runout. The
// opponent is drawn from the solved pool (skipping any entry that shares a card with the
// bot's own hand); boards come from whatever is left in the deck. The bot does NOT know
// the other seats' actual cards, which is correct — that's hidden information.
function buildTrials(hand, pool, count) {
  const handSet = new Set(hand);
  const qualifying = pool.filter((e) => {
    const cards = [...e.one, ...e.two, ...e.four];
    return cards.length === 7 && cards.every((c) => !handSet.has(c));
  });
  const trials = [];
  for (let i = 0; i < count; i++) {
    let oppSplit;
    if (qualifying.length) {
      oppSplit = qualifying[Math.floor(Math.random() * qualifying.length)];
    } else {
      // No pool available (missing/empty file) — fall back to a random opponent so a bot
      // still plays a legal, non-absurd hand rather than breaking the table.
      const deck = P.shuffle(P.freshDeck().filter((c) => !handSet.has(c)));
      oppSplit = fallbackSplit(deck.slice(0, 7));
    }
    const used = new Set([...hand, ...oppSplit.one, ...oppSplit.two, ...oppSplit.four]);
    const rest = P.shuffle(P.freshDeck().filter((c) => !used.has(c)));
    trials.push({ oppSplit, boardA: rest.slice(0, 5), boardB: rest.slice(5, 10) });
  }
  return trials;
}

function evalOn(cards, board, cat) {
  return cat === 'four' ? P.bestPLO(cards, board) : P.bestGeneric(cards, board);
}

// Score every partition against the trial set and return the best one. Same optimization
// as the browser's solver: the opponent's evaluation is hoisted out of the partition loop,
// and the expensive 4-card PLO evaluation is shared across every partition using the same
// 4-card subset (35 distinct subsets instead of 105 evaluations per board).
function chooseSplit(hand, pool, options = {}) {
  const trialCount = options.trials || DEFAULT_TRIALS;
  return new Promise((resolve) => {
    let parts;
    let trials;
    try {
      parts = allPartitions(hand);
      trials = buildTrials(hand, pool || [], trialCount);
    } catch (e) {
      resolve(fallbackSplit(hand));
      return;
    }
    if (!parts.length || !trials.length) { resolve(fallbackSplit(hand)); return; }

    const totals = new Float64Array(parts.length);
    const groups = new Map();
    parts.forEach((part, idx) => {
      const key = [...part.four].sort().join(',');
      if (!groups.has(key)) groups.set(key, { four: part.four, members: [] });
      groups.get(key).members.push(idx);
    });

    const chunk = Math.max(1, Math.round(500 / parts.length));
    let ti = 0;

    function step() {
      const end = Math.min(ti + chunk, trials.length);
      for (let i = ti; i < end; i++) {
        const t = trials[i];
        const oc = {
          one: [evalOn(t.oppSplit.one, t.boardA, 'one').score, evalOn(t.oppSplit.one, t.boardB, 'one').score],
          two: [evalOn(t.oppSplit.two, t.boardA, 'two').score, evalOn(t.oppSplit.two, t.boardB, 'two').score],
          four: [evalOn(t.oppSplit.four, t.boardA, 'four').score, evalOn(t.oppSplit.four, t.boardB, 'four').score]
        };
        for (const { four, members } of groups.values()) {
          const ca = P.compareScores(P.bestPLO(four, t.boardA).score, oc.four[0]);
          const cb = P.compareScores(P.bestPLO(four, t.boardB).score, oc.four[1]);
          const d4a = ca > 0 ? 3 : ca < 0 ? -3 : 0;
          const d4b = cb > 0 ? 3 : cb < 0 ? -3 : 0;
          const fourPts = d4a + d4b;
          for (const idx of members) {
            const part = parts[idx];
            const c1a = P.compareScores(P.bestGeneric(part.one, t.boardA).score, oc.one[0]);
            const c1b = P.compareScores(P.bestGeneric(part.one, t.boardB).score, oc.one[1]);
            const c2a = P.compareScores(P.bestGeneric(part.two, t.boardA).score, oc.two[0]);
            const c2b = P.compareScores(P.bestGeneric(part.two, t.boardB).score, oc.two[1]);
            const d1a = c1a > 0 ? 1 : c1a < 0 ? -1 : 0;
            const d1b = c1b > 0 ? 1 : c1b < 0 ? -1 : 0;
            const d2a = c2a > 0 ? 2 : c2a < 0 ? -2 : 0;
            const d2b = c2b > 0 ? 2 : c2b < 0 ? -2 : 0;
            let pts = d1a + d1b + d2a + d2b + fourPts;
            if (d1a > 0 && d1b > 0 && d2a > 0 && d2b > 0 && d4a > 0 && d4b > 0) pts += MATCH_TOTAL;
            else if (d1a < 0 && d1b < 0 && d2a < 0 && d2b < 0 && d4a < 0 && d4b < 0) pts -= MATCH_TOTAL;
            totals[idx] += pts;
          }
        }
      }
      ti = end;
      if (ti < trials.length) { setImmediate(step); return; }
      let best = 0;
      for (let i = 1; i < parts.length; i++) if (totals[i] > totals[best]) best = i;
      resolve(parts[best]);
    }
    step();
  });
}

module.exports = { chooseSplit, allPartitions, buildTrials, fallbackSplit, DEFAULT_TRIALS };
