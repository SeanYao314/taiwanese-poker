// Same bootstrap round as solve_round_hr.js (best-response under the HOMERUN rule,
// round 1 vs. random splitting, round N>=2 vs. round N-1's table), but restricted to a
// SLICE of the pool's hand indices [startIdx, endIdx) for the focal side -- so one round
// over a bigger pool can be split into several chunks that each finish inside a
// reasonable command timeout, the same way solve_fixed.js/solve_fixed_hr.js already chunk
// the 1000-hand scale-up.
//
// Important: `poolFile` is always the FULL pool (not just this chunk's slice) -- the
// opponent side (pickPoolOpponent, used for round >= 2) samples from the entire pool,
// exactly as the unchunked solve_round_hr.js does, so a chunk's results are identical to
// what the unchunked script would have produced for those same indices. Only the outer
// loop (which hands get solved in THIS invocation) is restricted to the slice; merge the
// chunk outputs for all slices of a round into one file before using it as the next
// round's prevTableFile.
//
// Usage: node solve_round_hr_chunked.js <round> <M> <poolFile> <prevTableFile|none> <startIdx> <endIdx> <outFile>
const fs = require('fs');
const { P, allPartitions, randomSplit, evalAssignment, pointsHomerun, canonicalKey, fmtAssignment } = require('./common.js');

const round = Number(process.argv[2]);
const M = Number(process.argv[3]);
const poolFile = process.argv[4];
const prevTableFile = process.argv[5];
const startIdx = Number(process.argv[6]);
const endIdx = Number(process.argv[7]);
const outFile = process.argv[8];

const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
let prevTable = null;
if (prevTableFile && prevTableFile !== 'none') {
  prevTable = JSON.parse(fs.readFileSync(prevTableFile, 'utf8'));
}

function overlaps(a, b) { const s = new Set(a); return b.some((c) => s.has(c)); }
function pickPoolOpponent(focalCards) {
  for (let tries = 0; tries < 40; tries++) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!overlaps(focalCards, cand.cards)) return cand;
  }
  return null;
}

function makeTrialsRound1(focalCards) {
  const deck = P.freshDeck().filter((c) => !focalCards.includes(c));
  const trials = [];
  for (let t = 0; t < M; t++) {
    const shuffled = P.shuffle(deck);
    const opp = shuffled.slice(0, 7);
    const boardA = shuffled.slice(7, 12);
    const boardB = shuffled.slice(12, 17);
    const oppSplit = randomSplit(opp);
    trials.push({ boards: [boardA, boardB], oppEvals: evalAssignment(oppSplit, [boardA, boardB]) });
  }
  return trials;
}

function makeTrialsLaterRound(focalCards) {
  const trials = [];
  let attempts = 0;
  while (trials.length < M && attempts < M * 3) {
    attempts++;
    const oppEntry = pickPoolOpponent(focalCards);
    if (!oppEntry) continue;
    const oppPartition = prevTable[oppEntry.id].partition;
    const usedCards = new Set([...focalCards, ...oppEntry.cards]);
    const remaining = P.freshDeck().filter((c) => !usedCards.has(c));
    const shuffled = P.shuffle(remaining);
    const boardA = shuffled.slice(0, 5);
    const boardB = shuffled.slice(5, 10);
    trials.push({ boards: [boardA, boardB], oppEvals: evalAssignment(oppPartition, [boardA, boardB]) });
  }
  return trials;
}

const startTime = Date.now();
const table = {};
const from = startIdx;
const to = endIdx;

for (let i = from; i < to; i++) {
  const entry = pool[i];
  const trials = round === 1 ? makeTrialsRound1(entry.cards) : makeTrialsLaterRound(entry.cards);

  let best = { ev: -Infinity, partition: null };
  for (const part of allPartitions(entry.cards)) {
    let total = 0;
    for (const trial of trials) {
      total += pointsHomerun(evalAssignment(part, trial.boards), trial.oppEvals);
    }
    const ev = total / trials.length;
    if (ev > best.ev) best = { ev, partition: part };
  }

  table[entry.id] = { partition: best.partition, ev: best.ev, key: canonicalKey(best.partition) };

  if ((i - from + 1) % 25 === 0 || i === to - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`HR round ${round} [${from}-${to}]: ${i - from + 1}/${to - from} hands solved (${elapsed}s elapsed)`);
  }
}

fs.writeFileSync(outFile, JSON.stringify(table));
console.log(`HR round ${round} chunk [${from},${to}) done in ${((Date.now() - startTime) / 1000).toFixed(1)}s -> ${outFile}`);
