// lib/game.js — pure game logic: dealing and scoring. No networking here.
const P = require('./poker.js');

const POINTS = { one: 1, two: 2, four: 3 };
const CATEGORY_LABELS = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
const STANDARD_BOARD_TOTAL = POINTS.one + POINTS.two + POINTS.four; // 6 — full sweep of a board, no bonus

// The hand shape every game converges to: a 1-card hand, a 2-card hand, and a 4-card PLO
// hand (you use exactly 2 of your 4 cards, plus exactly 3 of the 5 board cards).
const STANDARD_CAPACITY = { one: 1, two: 2, four: 4 };

// Deal 7 cards to each player id (array of ids) plus two independent 5-card boards, all
// from a single shuffled 52-card deck, so no collisions are possible. Both boards are
// dealt to their full 5 cards up front.
function dealHand(playerIds) {
  const deck = P.shuffle(P.freshDeck());
  let idx = 0;
  const hands = {};
  for (const id of playerIds) {
    hands[id] = deck.slice(idx, idx + 7);
    idx += 7;
  }
  const boardA = deck.slice(idx, idx + 5);
  idx += 5;
  const boardB = deck.slice(idx, idx + 5);
  idx += 5;
  return { hands, boards: [boardA, boardB] };
}

// Validate that `assignment` ({one:[...], two:[...], four:[...]}) is a legal partition of
// exactly the dealt cards against STANDARD_CAPACITY.
function validateAssignment(dealtCards, assignment) {
  if (!assignment) return 'No arrangement submitted.';
  const { one, two, four } = assignment;
  if (!Array.isArray(one) || !Array.isArray(two) || !Array.isArray(four)) {
    return 'Malformed arrangement.';
  }
  if (one.length !== STANDARD_CAPACITY.one) return `Your first hand must have exactly ${STANDARD_CAPACITY.one} card${STANDARD_CAPACITY.one === 1 ? '' : 's'}.`;
  if (two.length !== STANDARD_CAPACITY.two) return `Your second hand must have exactly ${STANDARD_CAPACITY.two} card${STANDARD_CAPACITY.two === 1 ? '' : 's'}.`;
  if (four.length !== STANDARD_CAPACITY.four) return `Your third hand must have exactly ${STANDARD_CAPACITY.four} card${STANDARD_CAPACITY.four === 1 ? '' : 's'}.`;

  const used = [...one, ...two, ...four];
  const total = STANDARD_CAPACITY.one + STANDARD_CAPACITY.two + STANDARD_CAPACITY.four;
  if (used.length !== total) return `You must use all ${total} of your cards exactly once.`;
  const usedSet = new Set(used);
  if (usedSet.size !== total) return 'Duplicate card used in your arrangement.';
  const dealtSet = new Set(dealtCards);
  for (const c of used) {
    if (!dealtSet.has(c)) return `Card ${c} was not dealt to you.`;
  }
  return null; // valid
}

// Compute best-hand evaluations for one player's arrangement against both boards.
function evaluatePlayer(assignment, boards) {
  const out = { one: [], two: [], four: [] };
  for (const board of boards) {
    out.one.push(P.bestGeneric(assignment.one, board));
    out.two.push(P.bestGeneric(assignment.two, board));
    out.four.push(P.bestPLO(assignment.four, board));
  }
  return out;
}

// players: [{ id, name, assignment }]  boards: [board0, board1]
// Homerun scoring is always on: sweeping ALL 6 comparisons against a given opponent — all
// 3 categories on BOTH boards, no ties anywhere — doubles the entire match total for that
// pairing (12 -> 24, or -24 if you get swept). Anything short of a full 6-for-6 sweep
// (including sweeping just one board) scores normally, with no bonus.
// Returns { evals, comparisons, pointsByPlayer, homeruns }
function computeResults(players, boards) {
  const evals = {};
  const pointsByPlayer = {};
  for (const p of players) {
    evals[p.id] = evaluatePlayer(p.assignment, boards);
    pointsByPlayer[p.id] = 0;
  }

  const matchTotal = STANDARD_BOARD_TOTAL * boards.length; // 6 * 2 = 12 points max swing per pairing

  const comparisons = [];
  const homeruns = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const matchResults = []; // every comparison across both boards for this pairing
      for (let boardIndex = 0; boardIndex < boards.length; boardIndex++) {
        for (const category of ['one', 'two', 'four']) {
          const scoreA = evals[a.id][category][boardIndex].score;
          const scoreB = evals[b.id][category][boardIndex].score;
          const cmp = P.compareScores(scoreA, scoreB);
          const pts = POINTS[category];
          let winner = null;
          if (cmp > 0) {
            winner = a.id;
            pointsByPlayer[a.id] += pts;
            pointsByPlayer[b.id] -= pts;
          } else if (cmp < 0) {
            winner = b.id;
            pointsByPlayer[b.id] += pts;
            pointsByPlayer[a.id] -= pts;
          }
          const entry = { boardIndex, category, playerA: a.id, playerB: b.id, winner, points: pts };
          comparisons.push(entry);
          matchResults.push(entry);
        }
      }

      const sweepWinner = matchResults.every((r) => r.winner === a.id)
        ? a.id
        : matchResults.every((r) => r.winner === b.id)
          ? b.id
          : null;
      if (sweepWinner) {
        const loser = sweepWinner === a.id ? b.id : a.id;
        pointsByPlayer[sweepWinner] += matchTotal; // double the match total already awarded above
        pointsByPlayer[loser] -= matchTotal;
        homeruns.push({ playerA: a.id, playerB: b.id, winner: sweepWinner });
      }
    }
  }

  return { evals, comparisons, pointsByPlayer, homeruns };
}

module.exports = {
  POINTS,
  CATEGORY_LABELS,
  STANDARD_CAPACITY,
  dealHand,
  validateAssignment,
  evaluatePlayer,
  computeResults
};
