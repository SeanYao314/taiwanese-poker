// lib/game.js — pure game logic: dealing and scoring. No networking here.
const P = require('./poker.js');

const POINTS = { one: 1, two: 2, four: 3 };
const CATEGORY_LABELS = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
const STANDARD_BOARD_TOTAL = POINTS.one + POINTS.two + POINTS.four; // 6 — full sweep of a board, no bonus

// Deal 7 cards to each player id (array of ids) plus two independent 5-card boards.
// All from a single shuffled 52-card deck, so no collisions are possible.
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

// Validate that `assignment` ({one:[1 card], two:[2 cards], four:[4 cards]}) is a legal
// partition of exactly the 7 cards the player was dealt.
function validateAssignment(dealtCards, assignment) {
  if (!assignment) return 'No arrangement submitted.';
  const { one, two, four } = assignment;
  if (!Array.isArray(one) || !Array.isArray(two) || !Array.isArray(four)) {
    return 'Malformed arrangement.';
  }
  if (one.length !== 1) return '1-card hand must have exactly 1 card.';
  if (two.length !== 2) return '2-card hand must have exactly 2 cards.';
  if (four.length !== 4) return '4-card PLO hand must have exactly 4 cards.';

  const used = [...one, ...two, ...four];
  if (used.length !== 7) return 'You must use all 7 of your cards exactly once.';
  const usedSet = new Set(used);
  if (usedSet.size !== 7) return 'Duplicate card used in your arrangement.';
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
// homerunMode: if true, sweeping all 3 categories against a given opponent on a given
// board (no ties in any of the 3) doubles that board's points for that pairing (6 -> 12,
// or -12 if you get swept). Mixed results on a board score normally either way.
// Returns { evals, comparisons, pointsByPlayer, homeruns }
function computeResults(players, boards, homerunMode = false) {
  const evals = {};
  const pointsByPlayer = {};
  for (const p of players) {
    evals[p.id] = evaluatePlayer(p.assignment, boards);
    pointsByPlayer[p.id] = 0;
  }

  const comparisons = [];
  const homeruns = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      for (let boardIndex = 0; boardIndex < boards.length; boardIndex++) {
        const boardResults = []; // { category, winner, points }
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
          boardResults.push(entry);
        }

        if (homerunMode) {
          const sweepWinner = boardResults.every((r) => r.winner === a.id)
            ? a.id
            : boardResults.every((r) => r.winner === b.id)
              ? b.id
              : null;
          if (sweepWinner) {
            const loser = sweepWinner === a.id ? b.id : a.id;
            pointsByPlayer[sweepWinner] += STANDARD_BOARD_TOTAL; // double the 6 already awarded above
            pointsByPlayer[loser] -= STANDARD_BOARD_TOTAL;
            homeruns.push({ boardIndex, playerA: a.id, playerB: b.id, winner: sweepWinner });
          }
        }
      }
    }
  }

  return { evals, comparisons, pointsByPlayer, homeruns };
}

module.exports = {
  POINTS,
  CATEGORY_LABELS,
  dealHand,
  validateAssignment,
  evaluatePlayer,
  computeResults
};
