// measure_pool_ev.js — attaches a trustworthy "what does GTO get with this hand" number to
// every entry in the shipped opponent pool, so Practice Mode can deal hands by difficulty.
//
// Each pool entry is a hand plus the split the solver chose for it. The EV recorded during
// solving came from only 60 boards (standard error around ±0.95), which is far too noisy to
// filter on — a hand whose true best is -1.6 would land anywhere near -0.7..-2.5. So this
// re-measures the EV of each entry's ALREADY-CHOSEN split over many more boards.
//
// Measuring the stored split rather than re-taking the max over all 105 is deliberate: the
// max of 105 noisy estimates is biased upward (winner's curse), whereas the EV of one fixed
// split is unbiased, which is what a threshold needs.
//
// Usage: node measure_pool_ev.js <startIdx> <endIdx> <boards> <outFile>
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'lib', 'poker.js'));

const [startStr, endStr, boardsStr, outFile] = process.argv.slice(2);
const FROM = Number(startStr);
const TO = Number(endStr);
const BOARDS = Number(boardsStr);

const POOL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'opponent-pool.json'), 'utf8'));
const POINTS = { one: 1, two: 2, four: 3 };
const MATCH_TOTAL = (POINTS.one + POINTS.two + POINTS.four) * 2;

const handOf = (e) => [...e.one, ...e.two, ...e.four];
const evalOn = (cards, board, cat) => (cat === 'four' ? P.bestPLO(cards, board) : P.bestGeneric(cards, board));

// Opponents are drawn from the pool itself — the same near-equilibrium field Practice Mode
// will pit the player against, so the number means "what this hand is worth at that table".
function measure(entry, boards) {
  const hand = handOf(entry);
  const handSet = new Set(hand);
  const deckMinusHand = P.freshDeck().filter((c) => !handSet.has(c));
  let total = 0;
  let tries = 0;
  let done = 0;
  while (done < boards && tries < boards * 40) {
    tries++;
    const opp = POOL[(Math.random() * POOL.length) | 0];
    const oppCards = handOf(opp);
    if (oppCards.some((c) => handSet.has(c))) continue;
    const used = new Set(oppCards);
    const rest = P.shuffle(deckMinusHand.filter((c) => !used.has(c)));
    const boardA = rest.slice(0, 5);
    const boardB = rest.slice(5, 10);
    let sum = 0;
    let allWon = true;
    let allLost = true;
    for (const cat of ['one', 'two', 'four']) {
      for (const board of [boardA, boardB]) {
        const cmp = P.compareScores(evalOn(entry[cat], board, cat).score, evalOn(opp[cat], board, cat).score);
        const d = cmp > 0 ? POINTS[cat] : cmp < 0 ? -POINTS[cat] : 0;
        sum += d;
        if (d <= 0) allWon = false;
        if (d >= 0) allLost = false;
      }
    }
    if (allWon) sum += MATCH_TOTAL;
    else if (allLost) sum -= MATCH_TOTAL;
    total += sum;
    done++;
  }
  return done ? total / done : 0;
}

const start = Date.now();
const out = {};
for (let i = FROM; i < TO; i++) {
  out[i] = Math.round(measure(POOL[i], BOARDS) * 100) / 100;
  if ((i - FROM + 1) % 500 === 0 || i === TO - 1) {
    console.log(`[${FROM}-${TO}] ${i - FROM + 1}/${TO - FROM} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
}
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`measured [${FROM},${TO}) in ${((Date.now() - start) / 1000).toFixed(1)}s -> ${outFile}`);
