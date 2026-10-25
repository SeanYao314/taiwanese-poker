// Dependency-free checks for the GTO bot seat (lib/bot.js).
// Run with: node tests/bot.test.js
//
// The interesting question isn't "does it return something legal" (easy) but "is it
// actually solving?" — so the bot's chosen split is scored against a FRESH, independent
// trial set, not the one it solved against. Beating a random split on data it has never
// seen is the thing worth asserting; beating it on its own solve set would be circular.
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'poker.js'));
const G = require(path.join(__dirname, '..', 'lib', 'game.js'));
const B = require(path.join(__dirname, '..', 'lib', 'bot.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

const POINTS = { one: 1, two: 2, four: 3 };
const MATCH_TOTAL = (POINTS.one + POINTS.two + POINTS.four) * 2;

function evalOn(cards, board, cat) {
  return cat === 'four' ? P.bestPLO(cards, board) : P.bestGeneric(cards, board);
}

// Average points per hand against a trial set, homerun bonus included — the same rule
// lib/game.js scores live hands with.
function evOf(assignment, trials) {
  let total = 0;
  for (const t of trials) {
    let sum = 0, allWon = true, allLost = true;
    for (const cat of ['one', 'two', 'four']) {
      for (const board of [t.boardA, t.boardB]) {
        const cmp = P.compareScores(evalOn(assignment[cat], board, cat).score, evalOn(t.oppSplit[cat], board, cat).score);
        const d = cmp > 0 ? POINTS[cat] : cmp < 0 ? -POINTS[cat] : 0;
        sum += d;
        if (d <= 0) allWon = false;
        if (d >= 0) allLost = false;
      }
    }
    if (allWon) sum += MATCH_TOTAL;
    else if (allLost) sum -= MATCH_TOTAL;
    total += sum;
  }
  return total / trials.length;
}

function randomSplit(hand) {
  const s = P.shuffle(hand);
  return { one: [s[0]], two: [s[1], s[2]], four: s.slice(3, 7) };
}

(async () => {
  let pool = [];
  try {
    pool = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'opponent-pool.json'), 'utf8'));
  } catch (e) { /* tested below */ }
  assert(pool.length > 0, `opponent pool loaded for bots to sample (${pool.length} entries)`);

  // --- legality on every hand it is asked about ---
  const HANDS = 6;
  const hands = [];
  for (let i = 0; i < HANDS; i++) hands.push(P.shuffle(P.freshDeck()).slice(0, 7));

  let botTotal = 0;
  let randTotal = 0;
  let allLegal = true;
  let usedOwnCards = true;
  for (const hand of hands) {
    const split = await B.chooseSplit(hand, pool, { trials: 40 });
    if (G.validateAssignment(hand, split) !== null) allLegal = false;
    const used = [...split.one, ...split.two, ...split.four].slice().sort().join(',');
    if (used !== hand.slice().sort().join(',')) usedOwnCards = false;

    // fresh trials the bot never saw, so this measures generalization not memorization
    const holdout = B.buildTrials(hand, pool, 150);
    botTotal += evOf(split, holdout);
    randTotal += evOf(randomSplit(hand), holdout);
  }
  assert(allLegal, `every bot split is a legal 1/2/4 partition (${HANDS} hands)`);
  assert(usedOwnCards, 'bot splits use exactly the cards it was dealt');

  const botAvg = botTotal / HANDS;
  const randAvg = randTotal / HANDS;
  console.log(`   bot avg EV ${botAvg.toFixed(2)} vs random split ${randAvg.toFixed(2)} on held-out boards`);
  assert(botAvg > randAvg, 'bot beats a random split on boards it did not solve against');
  assert(botAvg - randAvg > 1.0, `the edge is meaningful, not noise (+${(botAvg - randAvg).toFixed(2)} pts/hand)`);

  // --- degrades gracefully with no pool at all ---
  const noPool = await B.chooseSplit(hands[0], [], { trials: 10 });
  assert(G.validateAssignment(hands[0], noPool) === null, 'still returns a legal split with an empty opponent pool');

  // --- a hand it cannot solve still yields something playable ---
  const fallback = B.fallbackSplit(hands[0]);
  assert(G.validateAssignment(hands[0], fallback) === null, 'the fallback split is itself legal');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
