const fs = require('fs');
const path = require('path');
const { P } = require('./common.js');

const POOL_SIZE = Number(process.argv[2] || 120);
const OUT = process.argv[3] || path.join(__dirname, 'pool.json');

const pool = [];
for (let i = 0; i < POOL_SIZE; i++) {
  pool.push({ id: i, cards: P.shuffle(P.freshDeck()).slice(0, 7) });
}

fs.writeFileSync(OUT, JSON.stringify(pool));
console.log(`Wrote pool of ${POOL_SIZE} hands to ${OUT}`);
