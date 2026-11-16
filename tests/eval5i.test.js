// Proves the integer-packed evaluator (lib/poker.js eval5i) orders hands EXACTLY as the
// readable reference evaluator does — exhaustively, over all 2,598,960 five-card hands.
// eval5i is what Practice Mode and the bots actually run; evaluate5 is what defines the
// rules. If these two ever disagree, every EV number in the app is wrong, so this test is
// the one that has to be exhaustive rather than sampled.
//
// Run with: node tests/eval5i.test.js
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'poker.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

const deck = P.freshDeck();
const ints = deck.map(P.cardToInt);

// card encoding round-trips: 52 distinct ints, rank-major so rank order is preserved
assert(new Set(ints).size === 52, 'every card maps to a distinct integer');
assert(ints.every((v) => v >= 0 && v < 52), 'card integers stay in 0..51');
assert(P.cardToInt('2s') >> 2 < P.cardToInt('As') >> 2, 'the integer encoding keeps rank order');

// --- the exhaustive sweep ---
const rows = [];
for (let a = 0; a < 48; a++)
  for (let b = a + 1; b < 49; b++)
    for (let c = b + 1; c < 50; c++)
      for (let d = c + 1; d < 51; d++)
        for (let e = d + 1; e < 52; e++) {
          rows.push([
            P.evaluate5([deck[a], deck[b], deck[c], deck[d], deck[e]]),
            P.eval5i(ints[a], ints[b], ints[c], ints[d], ints[e])
          ]);
        }
assert(rows.length === 2598960, 'all C(52,5) = 2,598,960 hands evaluated');

rows.sort((x, y) => P.compareScores(x[0], y[0]));
let orderBad = 0;
let tieBad = 0;
for (let i = 1; i < rows.length; i++) {
  const ref = P.compareScores(rows[i - 1][0], rows[i][0]);
  const fast = rows[i - 1][1] - rows[i][1];
  if (ref === 0) { if (fast !== 0) tieBad++; }
  else if (Math.sign(ref) !== Math.sign(fast)) orderBad++;
}
assert(orderBad === 0, 'eval5i orders every pair of hands the same way as evaluate5');
assert(tieBad === 0, 'hands the reference evaluator calls equal get identical integers');

const refClasses = new Set(rows.map((r) => r[0].join(','))).size;
const fastClasses = new Set(rows.map((r) => r[1])).size;
assert(refClasses === fastClasses, 'both evaluators distinguish the same number of hand classes');
assert(fastClasses === 7462, 'that number is 7,462 — the known count of distinct 5-card hand values');

// --- the packing stays inside 32 bits, so comparison is plain integer subtraction ---
const maxScore = rows.reduce((m, r) => (r[1] > m ? r[1] : m), 0);
assert(maxScore < (1 << 24), 'scores fit in 24 bits, well inside a 32-bit int');
assert(rows.every((r) => r[1] >= 0), 'no score is negative, so subtraction can never overflow');

// --- a few spot checks that the categories landed where evaluate5 puts them ---
const i = (cards) => P.eval5i(...cards.map(P.cardToInt));
assert(i(['9s','8s','7s','6s','5s']) >> 20 === 8, 'straight flush is category 8');
assert(i(['As','2s','3s','4s','5s']) >> 20 === 8, 'the wheel straight flush is still a straight flush');
assert(i(['As','2s','3s','4s','5s']) < i(['6s','5s','4s','3s','2s']), 'a wheel loses to a 6-high straight flush');
assert(i(['9s','9h','9d','9c','2s']) >> 20 === 7, 'quads is category 7');
assert(i(['9s','9h','9d','2c','2s']) >> 20 === 6, 'full house is category 6');
assert(i(['2s','5s','9s','Js','Ks']) >> 20 === 5, 'flush is category 5');
assert(i(['9s','8h','7d','6c','5s']) >> 20 === 4, 'straight is category 4');
assert(i(['9s','9h','9d','4c','2s']) >> 20 === 3, 'trips is category 3');
assert(i(['9s','9h','4d','4c','2s']) >> 20 === 2, 'two pair is category 2');
assert(i(['9s','9h','5d','4c','2s']) >> 20 === 1, 'one pair is category 1');
assert(i(['Ks','9h','5d','4c','2s']) >> 20 === 0, 'high card is category 0');

console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
