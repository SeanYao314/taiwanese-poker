const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'lib', 'poker.js'));

const POINTS = { one: 1, two: 2, four: 3 };

// All 105 ways to partition a 7-card hand into (1-card, 2-card, 4-card) groups.
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

// Uniformly random partition (shuffle the 7 cards, slice 1/2/4 — this is a uniform
// distribution over the 105 unordered partitions; see derivation in chat).
function randomSplit(hand) {
  const s = P.shuffle(hand);
  return { one: [s[0]], two: [s[1], s[2]], four: [s[3], s[4], s[5], s[6]] };
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

const STANDARD_TOTAL = POINTS.one + POINTS.two + POINTS.four; // 6

// Homerun scoring: a board where you beat the opponent in all 3 categories (no ties)
// doubles that board's points (6 -> 12); losing all 3 costs you -12 instead of -6.
// Anything mixed scores normally.
function pointsHomerun(myEvals, oppEvals) {
  let total = 0;
  for (let b = 0; b < 2; b++) {
    const cmps = ['one', 'two', 'four'].map((cat) => P.compareScores(myEvals[cat][b], oppEvals[cat][b]));
    if (cmps.every((c) => c > 0)) total += STANDARD_TOTAL * 2;
    else if (cmps.every((c) => c < 0)) total -= STANDARD_TOTAL * 2;
    else {
      cmps.forEach((c, idx) => {
        const cat = ['one', 'two', 'four'][idx];
        if (c > 0) total += POINTS[cat];
        else if (c < 0) total -= POINTS[cat];
      });
    }
  }
  return total;
}

function canonicalKey(assignment) {
  // stable string key so we can diff partitions across rounds
  const sortCards = (arr) => [...arr].sort().join(',');
  return `1[${sortCards(assignment.one)}]2[${sortCards(assignment.two)}]4[${sortCards(assignment.four)}]`;
}

function fmtAssignment(a) {
  return `1:[${a.one.join(' ')}]  2:[${a.two.join(' ')}]  4:[${a.four.join(' ')}]`;
}

module.exports = { P, POINTS, allPartitions, randomSplit, evalAssignment, pointsFromEvals, pointsHomerun, canonicalKey, fmtAssignment };
