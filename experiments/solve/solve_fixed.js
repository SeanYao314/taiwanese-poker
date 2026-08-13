// Solve STANDARD best-response for focal hands [startIdx, endIdx) against a FIXED,
// already-converged opponent pool+table (doesn't get updated — just used as the field).
// Usage: node solve_fixed.js <startIdx> <endIdx> <focalPoolFile> <oppPoolFile> <oppTableFile> <M> <outFile>
const fs = require('fs');
const { P, allPartitions, evalAssignment, pointsFromEvals, canonicalKey, fmtAssignment } = require('./common.js');

const [startIdx, endIdx, focalPoolFile, oppPoolFile, oppTableFile, MStr, outFile] = process.argv.slice(2);
const M = Number(MStr);

const focalPool = JSON.parse(fs.readFileSync(focalPoolFile, 'utf8'));
const oppPool = JSON.parse(fs.readFileSync(oppPoolFile, 'utf8'));
const oppTable = JSON.parse(fs.readFileSync(oppTableFile, 'utf8'));

function overlaps(a, b) { const s = new Set(a); return b.some((c) => s.has(c)); }
function pickOpponent(focalCards) {
  for (let tries = 0; tries < 40; tries++) {
    const cand = oppPool[Math.floor(Math.random() * oppPool.length)];
    if (!overlaps(focalCards, cand.cards)) return cand;
  }
  return null;
}

function makeTrials(focalCards) {
  const trials = [];
  let attempts = 0;
  while (trials.length < M && attempts < M * 3) {
    attempts++;
    const oppEntry = pickOpponent(focalCards);
    if (!oppEntry) continue;
    const oppPartition = oppTable[oppEntry.id].partition;
    const used = new Set([...focalCards, ...oppEntry.cards]);
    const remaining = P.shuffle(P.freshDeck().filter((c) => !used.has(c)));
    const boardA = remaining.slice(0, 5);
    const boardB = remaining.slice(5, 10);
    trials.push({ boards: [boardA, boardB], oppEvals: evalAssignment(oppPartition, [boardA, boardB]) });
  }
  return trials;
}

const start = Date.now();
const table = {};
const from = Number(startIdx);
const to = Number(endIdx);

for (let i = from; i < to; i++) {
  const entry = focalPool[i];
  const trials = makeTrials(entry.cards);

  let best = { ev: -Infinity, partition: null };
  for (const part of allPartitions(entry.cards)) {
    let total = 0;
    for (const trial of trials) total += pointsFromEvals(evalAssignment(part, trial.boards), trial.oppEvals);
    const ev = total / trials.length;
    if (ev > best.ev) best = { ev, partition: part };
  }
  table[entry.id] = { partition: best.partition, ev: best.ev, key: canonicalKey(best.partition) };

  if ((i - from + 1) % 25 === 0 || i === to - 1) {
    console.log(`[${from}-${to}] ${i - from + 1}/${to - from} done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
}

fs.writeFileSync(outFile, JSON.stringify(table));
console.log(`chunk [${from},${to}) done in ${((Date.now() - start) / 1000).toFixed(1)}s -> ${outFile}`);
