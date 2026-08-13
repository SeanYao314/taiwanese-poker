// For a given focal hand, print the top-K partitions by EV (not just the argmax) against
// a given opponent table, to see whether round-to-round "flip flopping" is genuine
// instability or just noise among near-tied options.
const fs = require('fs');
const path = require('path');
const { P, allPartitions, evalAssignment, pointsFromEvals, fmtAssignment } = require('./common.js');

const poolId = Number(process.argv[2]);
const M = Number(process.argv[3] || 200); // more trials here since we just want precision for ONE hand
const tableFile = process.argv[4];

const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'pool.json'), 'utf8'));
const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
const entry = pool[poolId];

function overlaps(a, b) { const s = new Set(a); return b.some((c) => s.has(c)); }
function pickPoolOpponent(focalCards) {
  for (let tries = 0; tries < 40; tries++) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!overlaps(focalCards, cand.cards)) return cand;
  }
  return null;
}

const trials = [];
while (trials.length < M) {
  const oppEntry = pickPoolOpponent(entry.cards);
  if (!oppEntry) continue;
  const oppPartition = table[oppEntry.id].partition;
  const used = new Set([...entry.cards, ...oppEntry.cards]);
  const remaining = P.shuffle(P.freshDeck().filter((c) => !used.has(c)));
  const boardA = remaining.slice(0, 5);
  const boardB = remaining.slice(5, 10);
  trials.push({ boards: [boardA, boardB], oppEvals: evalAssignment(oppPartition, [boardA, boardB]) });
}

const results = allPartitions(entry.cards).map((part) => {
  let total = 0;
  for (const trial of trials) total += pointsFromEvals(evalAssignment(part, trial.boards), trial.oppEvals);
  return { part, ev: total / trials.length };
});
results.sort((a, b) => b.ev - a.ev);

console.log(`Hand: ${entry.cards.join(' ')}  (${M} trials)\n`);
results.slice(0, 6).forEach((r, i) => {
  console.log(`#${i + 1}  EV=${r.ev.toFixed(3)}   ${fmtAssignment(r.part)}`);
});
console.log(`...\n#${results.length}  EV=${results[results.length - 1].ev.toFixed(3)}   (worst of 105)`);
