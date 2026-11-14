// Same job as solve_fixed_hr.js — best-response for NEW focal hands against an
// already-converged, FIXED opponent table, scored with the homerun rule — but it delegates
// the inner loop to lib/bot.js's table-based solver instead of re-evaluating every
// partition's hands directly.
//
// That solver was written for live bot seats and is ~15x faster for the same answer: across
// the 105 partitions of one hand there are only 7 distinct 1-card hands, 21 distinct 2-card
// hands and 21 distinct hole pairs (and a PLO hand is just the best of its 6 pairs), so it
// builds three small per-board tables and looks everything up. tests/bot.test.js
// cross-checks it against naive scoring partition by partition.
//
// Usage: node solve_fixed_hr_fast.js <startIdx> <endIdx> <focalPoolFile> <oppPoolFile> <oppTableFile> <M> <outFile>
const fs = require('fs');
const path = require('path');
const B = require(path.join(__dirname, '..', '..', 'lib', 'bot.js'));
const { canonicalKey } = require('./common.js');

const [startIdx, endIdx, focalPoolFile, oppPoolFile, oppTableFile, MStr, outFile] = process.argv.slice(2);
const M = Number(MStr);

const focalPool = JSON.parse(fs.readFileSync(focalPoolFile, 'utf8'));
const oppPool = JSON.parse(fs.readFileSync(oppPoolFile, 'utf8'));
const oppTable = JSON.parse(fs.readFileSync(oppTableFile, 'utf8'));

// lib/bot.js samples opponents from a flat array of partitions, so flatten the
// pool+table pair into that shape once.
const field = oppPool
  .map((entry) => oppTable[entry.id] && oppTable[entry.id].partition)
  .filter(Boolean);

const start = Date.now();
const table = {};
const from = Number(startIdx);
const to = Number(endIdx);

for (let i = from; i < to; i++) {
  const entry = focalPool[i];
  const trials = B.buildTrials(entry.cards, field, M);
  const totals = B.scoreAllPartitions(entry.cards, trials);
  let best = 0;
  for (let k = 1; k < totals.length; k++) if (totals[k] > totals[best]) best = k;
  const partition = B.partitionToAssignment(entry.cards, B.PARTITIONS[best]);
  table[entry.id] = { partition, ev: totals[best] / trials.length, key: canonicalKey(partition) };

  if ((i - from + 1) % 200 === 0 || i === to - 1) {
    console.log(`HR-fast [${from}-${to}] ${i - from + 1}/${to - from} done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
}

fs.writeFileSync(outFile, JSON.stringify(table));
console.log(`HR-fast chunk [${from},${to}) done in ${((Date.now() - start) / 1000).toFixed(1)}s -> ${outFile}`);
