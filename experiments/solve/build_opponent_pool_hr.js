// build_opponent_pool_hr.js — merges the homerun-equilibrium-solved hand pools
// (round5000_hr.json + round5_hr.json, both scored with the corrected full-match-sweep
// homerun rule via solve_round_hr_chunked.js/solve_fixed_hr.js) into a single flat array
// of near-optimal (hand, split) pairs, shipped to the browser as
// public/opponent-pool.json to power Practice Mode's "perfect opponent."
//
// Homerun scoring is a permanent base rule (see the main README), so the opponent pool is
// solved for an opponent who's adapted to it, not a standard-rules opponent whose split
// just happens to get scored with the homerun modifier on top (that was this project's
// earlier approach).
//
// Two sources, both from the 400-hand homerun bootstrap:
//   round5_hr.json    — the 400 bootstrap hands at their converged round-5 splits
//   round5000_hr.json — 5000 further hands best-responding to that fixed round-5 field
// Pool size matters directly for Practice Mode: only the entries sharing no card with
// your dealt hand qualify as opponents (~1/3 of the pool), so 5400 entries gives roughly
// 1800 distinct opponents per practice hand before any repetition.
//
// Usage: node build_opponent_pool_hr.js > ../../public/opponent-pool.json
const fs = require('fs');
const path = require('path');

function loadPartitions(file) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  return Object.values(data).map((entry) => entry.partition);
}

const merged = [
  ...loadPartitions('round5000_hr.json'),
  ...loadPartitions('round5_hr.json')
];

// Sanity check: every partition should be a valid 7-card, no-duplicate hand.
let bad = 0;
for (const p of merged) {
  const cards = [...p.one, ...p.two, ...p.four];
  if (cards.length !== 7 || new Set(cards).size !== 7) bad++;
}
if (bad > 0) {
  console.error(`refusing to write: ${bad} malformed partitions found`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(merged));
console.error(`wrote ${merged.length} homerun-equilibrium opponent (hand, split) pairs`);
