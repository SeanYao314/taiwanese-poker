// Exploratory script: is naive card-splitting exploitable? How much EV is left on the
// table vs. a brute-force EV-maximizing split, for a fixed field playing a naive heuristic?
// Not a full equilibrium solver — just probes the shape of the problem.
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'poker.js'));

const RANKS = '23456789TJQKA';
const POINTS = { one: 1, two: 2, four: 3 };
const N_TRIALS = 250;

function naiveSplit(hand) {
  const sorted = [...hand].sort((a, b) => RANKS.indexOf(b[0]) - RANKS.indexOf(a[0]));
  return { one: [sorted[0]], two: [sorted[1], sorted[2]], four: [sorted[3], sorted[4], sorted[5], sorted[6]] };
}

function allPartitions(hand) {
  const results = [];
  for (let i = 0; i < 7; i++) {
    const rest6 = hand.filter((_, idx) => idx !== i);
    for (const pair of P.combinations(rest6, 2)) {
      const four = rest6.filter((c) => !pair.includes(c));
      results.push({ one: [hand[i]], two: pair, four });
    }
  }
  return results;
}

function evalAssignment(assignment, boards) {
  return {
    one: boards.map((b) => P.bestGeneric(assignment.one, b).score),
    two: boards.map((b) => P.bestGeneric(assignment.two, b).score),
    four: boards.map((b) => P.bestPLO(assignment.four, b).score)
  };
}

function pointsFromEvals(myEvals, oppEvals) {
  let total = 0;
  for (const cat of ['one', 'two', 'four']) {
    for (let b = 0; b < 2; b++) {
      const cmp = P.compareScores(myEvals[cat][b], oppEvals[cat][b]);
      if (cmp > 0) total += POINTS[cat];
      else if (cmp < 0) total -= POINTS[cat];
    }
  }
  return total;
}

function fmtHand(h) { return h.join(' '); }
function fmtAssignment(a) { return `1:[${fmtHand(a.one)}]  2:[${fmtHand(a.two)}]  4:[${fmtHand(a.four)}]`; }

function runForHand(testHand, label) {
  const deck = P.freshDeck().filter((c) => !testHand.includes(c));

  const trials = [];
  for (let t = 0; t < N_TRIALS; t++) {
    const shuffled = P.shuffle(deck);
    const opp = shuffled.slice(0, 7);
    const boardA = shuffled.slice(7, 12);
    const boardB = shuffled.slice(12, 17);
    const oppEvals = evalAssignment(naiveSplit(opp), [boardA, boardB]);
    trials.push({ boardA, boardB, oppEvals });
  }

  const mySplitNaive = naiveSplit(testHand);
  let baselineTotal = 0;
  for (const trial of trials) {
    baselineTotal += pointsFromEvals(evalAssignment(mySplitNaive, [trial.boardA, trial.boardB]), trial.oppEvals);
  }
  const baselineEV = baselineTotal / N_TRIALS;

  let best = { ev: -Infinity, split: null };
  for (const part of allPartitions(testHand)) {
    let total = 0;
    for (const trial of trials) {
      total += pointsFromEvals(evalAssignment(part, [trial.boardA, trial.boardB]), trial.oppEvals);
    }
    const ev = total / N_TRIALS;
    if (ev > best.ev) best = { ev, split: part };
  }

  console.log(`\n=== ${label}: ${fmtHand(testHand)} ===`);
  console.log(`naive split:      ${fmtAssignment(mySplitNaive)}   EV = ${baselineEV.toFixed(3)}`);
  console.log(`best-found split: ${fmtAssignment(best.split)}   EV = ${best.ev.toFixed(3)}  (vs field playing naive)`);
  console.log(`EV gain from optimizing: ${(best.ev - baselineEV).toFixed(3)} points/hand`);
}

const start = Date.now();

// A hand with an obvious "pair vs kicker" tension.
runForHand(['Ah', 'As', 'Kh', 'Kd', '7c', '4d', '2s'], 'Two pairs (AA, KK) + junk');

// A hand with a suited-connector-heavy 4-card potential.
runForHand(['Ah', '9h', '8h', '7h', 'Qs', '5c', '2d'], 'Flush-heavy hand');

// A fairly balanced, unremarkable hand.
runForHand(['Kd', 'Jc', '9s', '7h', '6d', '4c', '3s'], 'Rag hand, no pairs');

console.log(`\n(${((Date.now() - start) / 1000).toFixed(1)}s, ${N_TRIALS} trials per hand)`);
