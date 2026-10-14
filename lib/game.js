// lib/game.js — pure game logic: dealing and scoring. No networking here.
const P = require('./poker.js');

const POINTS = { one: 1, two: 2, four: 3 };
const CATEGORY_LABELS = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
const STANDARD_BOARD_TOTAL = POINTS.one + POINTS.two + POINTS.four; // 6 — full sweep of a board, no bonus

// The final hand shape every variant converges to: a 1-card hand, a 2-card hand, and a
// 4-card PLO hand. Standard games deal straight into this. Pineapple deals a bigger
// pre-flop hand (see PINEAPPLE_PRE_CAPACITY below) and discards down to this exact shape
// after the flop — which is why computeResults/evaluatePlayer never needed to change at
// all for the new variant, only the dealing and discard steps leading up to them.
const STANDARD_CAPACITY = { one: 1, two: 2, four: 4 };

// "Homerun Pineapple" variant: everyone gets 10 cards (up from 7) and blind-builds a
// 2-card, 3-card, and 5-card hand. Once the flop (first 3 cards of each board) is shown,
// each player discards exactly 1 card from each of those three hands — 2->1, 3->2, 5->4 —
// landing on exactly STANDARD_CAPACITY, then the turn+river complete both boards and it
// scores exactly like a standard homerun hand.
const PINEAPPLE_PRE_CAPACITY = { one: 2, two: 3, four: 5 };

// "Red River" board modifier: a board's 5th card is its river. If the river is red,
// one more card ("the ocean") gets dealt onto the end of that same board, and if THAT
// one is red too, another gets dealt, and so on — the cascade only stops the moment a
// black card lands, and that black card stays on the board as its new last card. Each
// board (A and B) rolls its own cascade independently, so a hand can end up with
// anywhere from 5 to (rarely) quite a few more community cards per board.
//
// This is deliberately unbounded rather than hard-capped: with a fair deck each extra
// card is red roughly half the time, so the length beyond the base 5 follows a geometric
// distribution (~50% chance of 0 extra cards, ~25% of 1, ~12.5% of 2, and so on) — long
// cascades are rare but never impossible. The only real limit is the deck itself, which
// `applyRedRiverRule` respects (see its `used < pool.length` guard below): it's
// astronomically unlikely to matter at normal table sizes (even 4 players at 10 cards
// each for Pineapple leaves 12 undealt cards to extend into after both base boards),
// but a hand can't crash by running out of deck mid-cascade.
//
// Pure and independently testable: takes a board (its current last card is "the river")
// and the pool of cards available to extend into, in draw order, and returns the
// extended board plus how many cards it actually consumed from that pool.
function applyRedRiverRule(board, pool) {
  const extended = board.slice();
  let used = 0;
  while (extended.length > 0 && P.isRed(extended[extended.length - 1]) && used < pool.length) {
    extended.push(pool[used]);
    used += 1;
  }
  return { board: extended, used };
}

// Deal `handSize` cards to each player id (array of ids) plus two independent boards,
// all from a single shuffled 52-card deck, so no collisions are possible. Both boards are
// dealt to their FULL base 5 cards up front, even in Pineapple mode where only the first 3
// of each ("the flop") are shown before the discard step — the turn/river are already
// fixed at deal time, so nothing about a later discard can change which cards they turn
// out to be, and a discarded hole card can never reappear on a board.
//
// `options.redRiver`: if true, each board is then independently extended per
// applyRedRiverRule above — still entirely decided at deal time, before anyone has acted,
// same as the rest of the board.
function dealHand(playerIds, handSize = 7, options = {}) {
  const deck = P.shuffle(P.freshDeck());
  let idx = 0;
  const hands = {};
  for (const id of playerIds) {
    hands[id] = deck.slice(idx, idx + handSize);
    idx += handSize;
  }
  let boardA = deck.slice(idx, idx + 5);
  idx += 5;
  let boardB = deck.slice(idx, idx + 5);
  idx += 5;

  if (options.redRiver) {
    const extA = applyRedRiverRule(boardA, deck.slice(idx));
    boardA = extA.board;
    idx += extA.used;
    const extB = applyRedRiverRule(boardB, deck.slice(idx));
    boardB = extB.board;
    idx += extB.used;
  }

  return { hands, boards: [boardA, boardB] };
}

// Validate that `assignment` ({one:[...], two:[...], four:[...]}) is a legal partition of
// exactly the dealt cards, against whichever capacity applies — STANDARD_CAPACITY for a
// normal hand (or a post-discard Pineapple hand), PINEAPPLE_PRE_CAPACITY for a pre-flop
// Pineapple hand.
function validateAssignment(dealtCards, assignment, capacity = STANDARD_CAPACITY) {
  if (!assignment) return 'No arrangement submitted.';
  const { one, two, four } = assignment;
  if (!Array.isArray(one) || !Array.isArray(two) || !Array.isArray(four)) {
    return 'Malformed arrangement.';
  }
  if (one.length !== capacity.one) return `Your first hand must have exactly ${capacity.one} card${capacity.one === 1 ? '' : 's'}.`;
  if (two.length !== capacity.two) return `Your second hand must have exactly ${capacity.two} card${capacity.two === 1 ? '' : 's'}.`;
  if (four.length !== capacity.four) return `Your third hand must have exactly ${capacity.four} card${capacity.four === 1 ? '' : 's'}.`;

  const used = [...one, ...two, ...four];
  const total = capacity.one + capacity.two + capacity.four;
  if (used.length !== total) return `You must use all ${total} of your cards exactly once.`;
  const usedSet = new Set(used);
  if (usedSet.size !== total) return 'Duplicate card used in your arrangement.';
  const dealtSet = new Set(dealtCards);
  for (const c of used) {
    if (!dealtSet.has(c)) return `Card ${c} was not dealt to you.`;
  }
  return null; // valid
}

// Pineapple's discard step: `discards` is { one: card, two: card, four: card } — exactly
// one card to drop from each of the player's pre-flop hands. Validates each discard is
// actually one of that hand's own cards, then returns the resulting STANDARD_CAPACITY-
// shaped assignment (2->1, 3->2, 5->4) ready to feed straight into evaluatePlayer/
// computeResults unchanged. The dropped cards simply aren't included anywhere in the
// output — they're not shuffled back into anything, they're just gone for the hand.
function validateDiscards(preAssignment, discards) {
  if (!discards) return { error: 'No discards submitted.' };
  const cats = ['one', 'two', 'four'];
  const catOrdinal = { one: 'first', two: 'second', four: 'third' };
  for (const cat of cats) {
    const card = discards[cat];
    if (typeof card !== 'string') return { error: 'Malformed discard selection.' };
    if (!preAssignment || !Array.isArray(preAssignment[cat]) || !preAssignment[cat].includes(card)) {
      return { error: `Your discard for the ${catOrdinal[cat]} hand isn't one of that hand's own cards.` };
    }
  }
  const assignment = {};
  for (const cat of cats) {
    assignment[cat] = preAssignment[cat].filter((c) => c !== discards[cat]);
  }
  return { assignment };
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
// homerunMode: if true, sweeping ALL 6 comparisons against a given opponent — all 3
// categories on BOTH boards, no ties anywhere — doubles the entire match total for that
// pairing (12 -> 24, or -24 if you get swept). Anything short of a full 6-for-6 sweep
// (including sweeping just one board) scores normally, with no bonus.
// Returns { evals, comparisons, pointsByPlayer, homeruns }
function computeResults(players, boards, homerunMode = false) {
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

      if (homerunMode) {
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
  }

  return { evals, comparisons, pointsByPlayer, homeruns };
}

module.exports = {
  POINTS,
  CATEGORY_LABELS,
  STANDARD_CAPACITY,
  PINEAPPLE_PRE_CAPACITY,
  dealHand,
  applyRedRiverRule,
  validateAssignment,
  validateDiscards,
  evaluatePlayer,
  computeResults
};
