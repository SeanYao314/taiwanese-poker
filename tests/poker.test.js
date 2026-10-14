// Dependency-free sanity checks for the hand evaluator and scoring engine.
// Run with: node tests/poker.test.js
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'poker.js'));
const G = require(path.join(__dirname, '..', 'lib', 'game.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

// --- category detection ---
assert(P.evaluate5(['9s', '8s', '7s', '6s', '5s'])[0] === 8, 'straight flush detected');
const wheelSF = P.evaluate5(['As', '2s', '3s', '4s', '5s']);
assert(wheelSF[0] === 8 && wheelSF[1] === 5, 'wheel straight flush high card is the 5');
assert(P.evaluate5(['9s', '9h', '9d', '9c', '2s'])[0] === 7, 'quads detected');
assert(P.evaluate5(['9s', '9h', '9d', '2c', '2s'])[0] === 6, 'full house detected');
assert(P.evaluate5(['2s', '5s', '9s', 'Js', 'Ks'])[0] === 5, 'flush detected');
assert(P.evaluate5(['9s', '8h', '7d', '6c', '5s'])[0] === 4, 'straight detected');
const wheel = P.evaluate5(['As', '2h', '3d', '4c', '5s']);
assert(wheel[0] === 4 && wheel[1] === 5, 'wheel straight (A-2-3-4-5) high card is the 5');
assert(P.evaluate5(['9s', '9h', '9d', '2c', '5s'])[0] === 3, 'trips detected');
assert(P.evaluate5(['9s', '9h', '2d', '2c', '5s'])[0] === 2, 'two pair detected');
assert(P.evaluate5(['9s', '9h', '2d', '7c', '5s'])[0] === 1, 'pair detected');
assert(P.evaluate5(['9s', 'Kh', '2d', '7c', '5s'])[0] === 0, 'high card detected');

// --- ordering ---
const quads = P.evaluate5(['9s', '9h', '9d', '9c', '2s']);
const fh = P.evaluate5(['9s', '9h', '9d', '2c', '2s']);
assert(P.compareScores(quads, fh) > 0, 'quads beat full house');
const aceKingHigh = P.evaluate5(['As', 'Kh', '2d', '7c', '9s']);
const aceQueenHigh = P.evaluate5(['As', 'Qh', '2d', '7c', '9s']);
assert(P.compareScores(aceKingHigh, aceQueenHigh) > 0, 'AK-high beats AQ-high (kicker comparison)');

// --- hand-construction rules ---
// 4-card PLO: must use exactly 2 of your 4 cards + exactly 3 board cards.
const best4 = P.bestPLO(['Ah', 'Ad', '2c', '3c'], ['As', 'Ac', 'Kd', 'Kh', '5s']);
const usedFromHand4 = best4.cards.filter((c) => ['Ah', 'Ad', '2c', '3c'].includes(c));
assert(best4.score[0] === 7, 'PLO construction finds quad aces (2 hand + 3 board)');
assert(usedFromHand4.length === 2, 'PLO hand uses exactly 2 of the 4 hole cards');

// 2-card / 1-card hands: best-of-pool, unrestricted (hold\'em style, board may "play").
const best2 = P.bestGeneric(['Jh', 'Th'], ['3s', '3h', '3d', '3c', '2s']);
assert(best2.score[0] === 7, '2-card hand can use just 1 kicker + 4 board cards for quads');
const best1 = P.bestGeneric(['2h'], ['As', 'Ac', 'Ad', 'Ah', 'Ks']);
assert(best1.score[0] === 7 && best1.score[2] === 13, '1-card hand can ignore its own card and play the board');

// --- deal / scoring integration ---
const { hands, boards } = G.dealHand(['alice', 'bob', 'carol']);
const allDealt = [...hands.alice, ...hands.bob, ...hands.carol, ...boards[0], ...boards[1]];
assert(allDealt.length === new Set(allDealt).size, 'no duplicate cards across hands + boards');
assert(allDealt.length === 3 * 7 + 10, 'correct total card count dealt');

function autoSplit(cards) {
  return { one: [cards[0]], two: [cards[1], cards[2]], four: [cards[3], cards[4], cards[5], cards[6]] };
}
const players = Object.entries(hands).map(([id, cards]) => ({ id, name: id, assignment: autoSplit(cards) }));
const results = G.computeResults(players, boards);
assert(results.comparisons.length === 3 * 2 * 3, 'correct number of pairwise comparisons (3 pairs x 2 boards x 3 categories)');
const sum = Object.values(results.pointsByPlayer).reduce((a, b) => a + b, 0);
assert(sum === 0, 'scoring is zero-sum across all players');

// --- assignment validation ---
assert(G.validateAssignment(hands.alice, autoSplit(hands.alice)) === null, 'valid assignment passes validation');
assert(typeof G.validateAssignment(hands.alice, { one: [], two: [], four: [] }) === 'string', 'incomplete assignment is rejected');
assert(typeof G.validateAssignment(hands.alice, { one: ['Ah'], two: ['2h', '3h'], four: ['4h', '5h', '6h', '7h'] }) === 'string', 'assignment using foreign cards is rejected');

// --- homerun modifier ---
// Homerun requires sweeping ALL 6 comparisons against an opponent (both boards, all 3
// categories, no ties) -- winning just one board outright is NOT enough.

// Case 1: A wins a mixed board (2 of 3 categories) on board 0, then sweeps all 3
// categories on board 1. Only ONE board was swept, not both -- this must NOT trigger
// a homerun even though it would have under the old (per-board) rule.
{
  const boardA = ['2s', '4d', '6c', '9h', 'Jc'];
  const boardB = ['3s', '5d', '7c', 'Th', 'Qc'];
  const playerA = { id: 'A', name: 'A', assignment: { one: ['Ah'], two: ['Ks', 'Kd'], four: ['Qs', 'Qd', '2c', '3c'] } };
  const playerB = { id: 'B', name: 'B', assignment: { one: ['4h'], two: ['6d', '7d'], four: ['8d', '9c', 'Tc', 'Jd'] } };

  const standard = G.computeResults([playerA, playerB], [boardA, boardB], false);
  assert(standard.pointsByPlayer.A === 4 && standard.pointsByPlayer.B === -4, 'standard scoring gives the expected point split for the fixture hand');
  assert(standard.homeruns.length === 0, 'homeruns array is empty when homerun mode is off');

  const homerun = G.computeResults([playerA, playerB], [boardA, boardB], true);
  assert(homerun.homeruns.length === 0, 'sweeping only ONE of the two boards does not trigger a homerun');
  assert(homerun.pointsByPlayer.A === 4 && homerun.pointsByPlayer.B === -4, 'a single-board sweep scores normally (no bonus) since not all 6 comparisons were won');
}

// Case 2: A wins all 3 categories on BOTH boards -- a genuine 6-for-6 sweep -- so the
// whole match total against B doubles (12 -> 24).
{
  const boardA = ['2d', 'Ac', '4d', 'Qc', '8h'];
  const boardB = ['As', 'Jh', 'Jd', '4c', 'Js'];
  const playerA = { id: 'A', name: 'A', assignment: { one: ['7h'], two: ['9h', 'Ad'], four: ['3c', '5s', '3s', '7d'] } };
  const playerB = { id: 'B', name: 'B', assignment: { one: ['5d'], two: ['Td', '5c'], four: ['8s', '2c', 'Th', '7s'] } };

  const standard = G.computeResults([playerA, playerB], [boardA, boardB], false);
  assert(standard.pointsByPlayer.A === 12 && standard.pointsByPlayer.B === -12, 'standard scoring gives a 12-point full-sweep total with no bonus');

  const homerun = G.computeResults([playerA, playerB], [boardA, boardB], true);
  assert(homerun.homeruns.length === 1 && homerun.homeruns[0].winner === 'A', 'homerun mode detects the full 6-comparison sweep for A');
  assert(homerun.pointsByPlayer.A === 24 && homerun.pointsByPlayer.B === -24, 'homerun mode doubles the whole match total (12->24) on a genuine 6-for-6 sweep, and stays zero-sum');
}

// zero-sum should hold under homerun mode too, even without a guaranteed sweep
{
  const hrResults = G.computeResults(players, boards, true);
  const hrSum = Object.values(hrResults.pointsByPlayer).reduce((a, b) => a + b, 0);
  assert(hrSum === 0, 'homerun-mode scoring is still zero-sum on an arbitrary random deal');
}

// --- Homerun Pineapple: deal size, pre-flop capacity, and the discard step ---
{
  // 10-card deal, full boards dealt up front (turn/river fixed before any discarding).
  const pine = G.dealHand(['alice', 'bob', 'carol'], 10);
  const allPineDealt = [...pine.hands.alice, ...pine.hands.bob, ...pine.hands.carol, ...pine.boards[0], ...pine.boards[1]];
  assert(allPineDealt.length === new Set(allPineDealt).size, 'pineapple deal: no duplicate cards across hands + boards');
  assert(allPineDealt.length === 3 * 10 + 10, 'pineapple deal: correct total card count (10/player + 2 boards)');
  assert(pine.hands.alice.length === 10, 'pineapple deal: each player gets 10 cards');

  function pineappleSplit(cards) {
    return { one: cards.slice(0, 2), two: cards.slice(2, 5), four: cards.slice(5, 10) };
  }
  const alicePre = pineappleSplit(pine.hands.alice);
  assert(G.validateAssignment(pine.hands.alice, alicePre, G.PINEAPPLE_PRE_CAPACITY) === null, 'pineapple pre-flop: valid 2/3/5 split passes validation against PINEAPPLE_PRE_CAPACITY');
  assert(typeof G.validateAssignment(pine.hands.alice, alicePre, G.STANDARD_CAPACITY) === 'string', 'pineapple pre-flop: that same 2/3/5 split is correctly REJECTED against STANDARD_CAPACITY (1/2/4)');
  assert(typeof G.validateAssignment(pine.hands.alice, { one: [], two: [], four: [] }, G.PINEAPPLE_PRE_CAPACITY) === 'string', 'pineapple pre-flop: incomplete assignment is rejected');

  // Discard 1 from each hand -> should land exactly on STANDARD_CAPACITY (1/2/4), and the
  // discarded cards should be gone (not present anywhere in the resulting assignment).
  const discards = { one: alicePre.one[0], two: alicePre.two[0], four: alicePre.four[0] };
  const discardResult = G.validateDiscards(alicePre, discards);
  assert(!discardResult.error, 'pineapple discard: a legal one-per-hand discard is accepted');
  const reduced = discardResult.assignment;
  assert(reduced.one.length === 1 && reduced.two.length === 2 && reduced.four.length === 4, 'pineapple discard: reduced assignment lands exactly on the standard 1/2/4 shape');
  const reducedAll = [...reduced.one, ...reduced.two, ...reduced.four];
  assert(!reducedAll.includes(discards.one) && !reducedAll.includes(discards.two) && !reducedAll.includes(discards.four), 'pineapple discard: discarded cards do not appear anywhere in the reduced assignment (not shuffled back in)');
  assert(G.validateAssignment(pine.hands.alice, reduced, G.STANDARD_CAPACITY) === null, 'pineapple discard: the reduced assignment is itself a valid standard assignment');

  // Illegal discards: a card from the wrong hand, or a card not in hand at all.
  const wrongHandDiscard = { one: alicePre.two[0], two: alicePre.two[1], four: alicePre.four[0] };
  assert(typeof G.validateDiscards(alicePre, wrongHandDiscard).error === 'string', 'pineapple discard: discarding a card from the WRONG hand-group is rejected');
  const foreignCardDiscard = { one: 'Ah', two: alicePre.two[0], four: alicePre.four[0] };
  const foreignIsActuallyForeign = !alicePre.one.includes('Ah');
  if (foreignIsActuallyForeign) {
    assert(typeof G.validateDiscards(alicePre, foreignCardDiscard).error === 'string', 'pineapple discard: discarding a card that was never dealt to that hand is rejected');
  }

  // End-to-end: after discarding for all three players, computeResults runs completely
  // unchanged (same function used by standard games) and the result is zero-sum, forced
  // homerun-aware just like a real Pineapple room would use it.
  const finalPlayers = Object.entries(pine.hands).map(([id, cards]) => {
    const pre = pineappleSplit(cards);
    const d = { one: pre.one[0], two: pre.two[0], four: pre.four[0] };
    return { id, name: id, assignment: G.validateDiscards(pre, d).assignment };
  });
  const pineResults = G.computeResults(finalPlayers, pine.boards, true);
  const pineSum = Object.values(pineResults.pointsByPlayer).reduce((a, b) => a + b, 0);
  assert(pineSum === 0, 'pineapple end-to-end: post-discard computeResults (homerun-aware) is zero-sum, same engine as standard games');
}

// --- "Red River" board modifier ---
{
  // isRed: basic sanity on both red suits and both black suits.
  assert(P.isRed('Ah') === true && P.isRed('Ad') === true, 'isRed is true for hearts and diamonds');
  assert(P.isRed('As') === false && P.isRed('Ac') === false, 'isRed is false for spades and clubs');

  // applyRedRiverRule is a pure function: board-so-far + a draw-ordered pool of cards
  // still available, no shuffling or randomness involved, so these are exact.
  const noExtension = G.applyRedRiverRule(['2h', '3d', '4c', '5s', '9s'], ['Ah', 'Kd']);
  assert(noExtension.used === 0, 'river already black: no ocean card dealt, nothing consumed from the pool');
  assert(noExtension.board.length === 5, 'river already black: board stays at exactly 5 cards');

  const oneExtension = G.applyRedRiverRule(['2h', '3d', '4c', '5s', '9h'], ['Kc', 'Ad']);
  assert(oneExtension.used === 1, 'red river: exactly one ocean card dealt before a black one stops it');
  assert(oneExtension.board.length === 6 && oneExtension.board[5] === 'Kc', 'the black ocean card is appended and stays on the board');

  const twoExtensions = G.applyRedRiverRule(['2h', '3d', '4c', '5s', '9h'], ['Qd', 'Jh', 'Tc', 'Ad']);
  assert(twoExtensions.used === 3, 'red river cascades through multiple red oceans (Qd, Jh) until a black one (Tc) stops it');
  assert(
    twoExtensions.board.length === 8 && twoExtensions.board.slice(5).join(',') === 'Qd,Jh,Tc',
    'all three cascaded cards land on the board in draw order, ending on the black stopper'
  );

  // Deck-exhaustion guard: if the pool runs out while still red, the cascade stops
  // gracefully (consumes the whole pool) instead of reading past the end of it.
  const exhausted = G.applyRedRiverRule(['2h', '3d', '4c', '5s', '9h'], ['Qd', 'Jh']);
  assert(exhausted.used === 2, 'red river stops once the available pool is exhausted, even mid-cascade');
  assert(exhausted.board.length === 7 && P.isRed(exhausted.board[6]), 'the board can legitimately end on a red card if the deck simply ran out');

  // dealHand regression: omitting options (or redRiver: false) must deal exactly 5 cards
  // per board every time, identical to the pre-Red-River behavior, regardless of color.
  let alwaysExactlyFive = true;
  for (let i = 0; i < 500; i++) {
    const { boards } = G.dealHand(['p1', 'p2'], 7);
    if (boards[0].length !== 5 || boards[1].length !== 5) alwaysExactlyFive = false;
  }
  assert(alwaysExactlyFive, 'without the Red River option, both boards are always exactly 5 cards across 500 hands (unchanged regression behavior)');

  // dealHand with redRiver: true, run many hands and check every structural invariant:
  // no duplicate cards anywhere, every board ends on a black card (deck is never close to
  // exhausted with 2 players), and every card strictly between the base river and the
  // final one is red (otherwise the cascade would have already stopped there). Asserted
  // once in aggregate rather than per-iteration, to keep the test log readable.
  let noExtraCount = 0;
  let allUnique = true;
  let allEndBlack = true;
  let allMidRed = true;
  let allAtLeastFive = true;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const { hands, boards } = G.dealHand(['p1', 'p2'], 7, { redRiver: true });
    const allCards = [...hands.p1, ...hands.p2, ...boards[0], ...boards[1]];
    if (new Set(allCards).size !== allCards.length) allUnique = false;
    for (const board of boards) {
      if (board.length < 5) allAtLeastFive = false;
      if (P.isRed(board[board.length - 1])) allEndBlack = false;
      for (let p = 4; p < board.length - 1; p++) {
        if (!P.isRed(board[p])) allMidRed = false;
      }
      if (board.length === 5) noExtraCount++;
    }
  }
  assert(allUnique, `red river: every card dealt across ${N} hands (both hands + both extended boards) was always unique, never duplicated`);
  assert(allAtLeastFive, `red river: every board across ${N} hands stayed at least the base 5 cards`);
  assert(allEndBlack, `red river: every board across ${N} hands ended on a black card (deck never runs out with just 2 players)`);
  assert(allMidRed, `red river: every non-final card past the base river in an extended board was red, as required to still be cascading`);

  // Each extra card is ~50/50 red, so roughly half of all boards should need no
  // extension at all (geometric distribution) — loose bounds to avoid test flakiness
  // while still catching a badly wrong probability (e.g. always/never extending).
  const noExtraRate = noExtraCount / (N * 2);
  assert(noExtraRate > 0.35 && noExtraRate < 0.65, `about half of boards should need no Red River extension at all (got ${(noExtraRate * 100).toFixed(1)}%)`);

  // Integration: bestGeneric/bestPLO were already board-length-agnostic (they just
  // operate on whatever "pool"/"board" array they're handed), so Red River needed zero
  // changes to the scoring engine itself — only to how many cards end up in that array.
  // Prove it directly: a board extended by one Red River ocean card can unlock a hand
  // that was flatly impossible with just the base 5 board cards.
  const handFour = ['Ah', '2h', '3c', '4c'];
  const baseBoard = ['Kh', '9h', '5s', '2c', '7d'];
  const oceanBoard = baseBoard.concat(['Qh']); // one extra red ocean card
  const beforeExtension = P.bestPLO(handFour, baseBoard);
  const afterExtension = P.bestPLO(handFour, oceanBoard);
  assert(beforeExtension.score[0] === 1, 'with only the base 5 board cards, the best PLO hand here is just a pair of 2s');
  assert(afterExtension.score[0] === 5, 'the Qh ocean card completes a 5-heart flush that needed a 6th board card to exist at all');

  // computeResults end-to-end on an extended board: still zero-sum, no special-casing
  // needed anywhere in the scoring pipeline for boards longer than 5.
  const { hands: rrHands, boards: rrBoards } = G.dealHand(['alice', 'bob', 'carol'], 7, { redRiver: true });
  const rrPlayers = Object.entries(rrHands).map(([id, cards]) => ({
    id,
    name: id,
    assignment: { one: [cards[0]], two: cards.slice(1, 3), four: cards.slice(3, 7) }
  }));
  const rrResults = G.computeResults(rrPlayers, rrBoards, false);
  const rrSum = Object.values(rrResults.pointsByPlayer).reduce((a, b) => a + b, 0);
  assert(rrSum === 0, 'computeResults stays zero-sum on Red-River-extended boards, exactly like standard 5-card boards');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
