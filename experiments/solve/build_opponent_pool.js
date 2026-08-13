// build_opponent_pool.js — merges the already-solved standard-rules hand pools
// (round1000_standard.json + round5.json) into a single flat array of
// near-optimal (hand, split) pairs, shipped to the browser as
// public/opponent-pool.json to power Practice Mode's "perfect opponent."
//
// Each entry is just a partition object { one, two, four } — the opponent's
// full 7-card hand is implicit as the union of those three arrays, and the
// partition itself IS the empirically-solved near-equilibrium split for that
// hand (from the iterative best-response bootstrap documented in this
// folder's README). No live solving happens in the browser; this file is the
// only artifact Practice Mode needs from all that offline research.
//
// Usage: node build_opponent_pool.js > ../../public/opponent-pool.json

const fs = require('fs');
const path = require('path');

function loadPartitions(file) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  return Object.values(data).map((entry) => entry.partition);
}

const merged = [
  ...loadPartitions('round1000_standard.json'),
  ...loadPartitions('round5.json')
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
console.error(`wrote ${merged.length} opponent (hand, split) pairs`);
