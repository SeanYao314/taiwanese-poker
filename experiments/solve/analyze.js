const fs = require('fs');
const path = require('path');
const { fmtAssignment } = require('./common.js');

const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'pool.json'), 'utf8'));
const rounds = [1, 2, 3, 4, 5].map((r) => JSON.parse(fs.readFileSync(path.join(__dirname, `round${r}.json`), 'utf8')));

console.log('=== Population-level convergence across rounds ===\n');
for (let r = 1; r < rounds.length; r++) {
  const prev = rounds[r - 1];
  const cur = rounds[r];
  let changed = 0;
  let evDeltaSum = 0;
  let evDeltaAbsSum = 0;
  for (const entry of pool) {
    const id = entry.id;
    if (prev[id].key !== cur[id].key) changed++;
    evDeltaSum += cur[id].ev - prev[id].ev;
    evDeltaAbsSum += Math.abs(cur[id].ev - prev[id].ev);
  }
  const pct = ((changed / pool.length) * 100).toFixed(1);
  console.log(`round ${r} -> round ${r + 1}: ${changed}/${pool.length} hands (${pct}%) changed their chosen split; ` +
    `mean EV change = ${(evDeltaSum / pool.length).toFixed(3)}, mean |EV change| = ${(evDeltaAbsSum / pool.length).toFixed(3)}`);
}

console.log('\n=== Mean EV per round (avg over the whole pool, vs that round\'s opponent model) ===');
rounds.forEach((table, idx) => {
  const mean = pool.reduce((s, e) => s + table[e.id].ev, 0) / pool.length;
  console.log(`round ${idx + 1}: mean EV = ${mean.toFixed(3)}`);
});

console.log('\n=== How often does each hand land on the SAME split as round 1 by round 5? ===');
let backToRound1 = 0;
for (const entry of pool) {
  if (rounds[0][entry.id].key === rounds[4][entry.id].key) backToRound1++;
}
console.log(`${backToRound1}/${pool.length} hands (${((backToRound1 / pool.length) * 100).toFixed(1)}%) have round-5 split identical to round-1 split`);

console.log('\n=== How often is a hand STABLE across the last 3 rounds (3,4,5 all identical)? ===');
let stableLast3 = 0;
for (const entry of pool) {
  const id = entry.id;
  if (rounds[2][id].key === rounds[3][id].key && rounds[3][id].key === rounds[4][id].key) stableLast3++;
}
console.log(`${stableLast3}/${pool.length} hands (${((stableLast3 / pool.length) * 100).toFixed(1)}%) unchanged across rounds 3-4-5`);

console.log('\n=== Sample trajectories (first 8 pool hands) ===');
for (let i = 0; i < 8; i++) {
  const entry = pool[i];
  console.log(`\nHand ${i}: ${entry.cards.join(' ')}`);
  rounds.forEach((table, idx) => {
    console.log(`  round ${idx + 1}: ${fmtAssignment(table[entry.id].partition)}  EV=${table[entry.id].ev.toFixed(2)}`);
  });
}
