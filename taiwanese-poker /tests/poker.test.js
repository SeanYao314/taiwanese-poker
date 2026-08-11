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
// A deliberately constructed scenario: A wins a mixed board (2 of 3 categories) on
// board 0, then sweeps all 3 categories on board 1 -- a genuine homerun.
{
  const boardA = ['2s', '4d', '6c', '9h', 'Jc'];
  const boardB = ['3s', '5d', '7c', 'Th', 'Qc'];
  const playerA = { id: 'A', name: 'A', assignment: { one: ['Ah'], two: ['Ks', 'Kd'], four: ['Qs', 'Qd', '2c', '3c'] } };
  const playerB = { id: 'B', name: 'B', assignment: { one: ['4h'], two: ['6d', '7d'], four: ['8d', '9c', 'Tc', 'Jd'] } };

  const standard = G.computeResults([playerA, playerB], [boardA, boardB], false);
  assert(standard.pointsByPlayer.A === 4 && standard.pointsByPlayer.B === -4, 'standard scoring gives the expected point split for the fixture hand');
  assert(standard.homeruns.length === 0, 'homeruns array is empty when homerun mode is off');

  const homerun = G.computeResults([playerA, playerB], [boardA, boardB], true);
  assert(homerun.homeruns.length === 1 && homerun.homeruns[0].boardIndex === 1 && homerun.homeruns[0].winner === 'A', 'homerun mode detects the board-1 clean sweep for A');
  assert(homerun.pointsByPlayer.A === 10 && homerun.pointsByPlayer.B === -10, 'homerun mode doubles the swept board\'s points (6->12) while leaving the mixed board normal, and stays zero-sum');
}

// zero-sum should hold under homerun mode too, even without a guaranteed sweep
{
  const hrResults = G.computeResults(players, boards, true);
  const hrSum = Object.values(hrResults.pointsByPlayer).reduce((a, b) => a + b, 0);
  assert(hrSum === 0, 'homerun-mode scoring is still zero-sum on an arbitrary random deal');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
