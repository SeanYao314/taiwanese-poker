// Usage: node solve_round.js <round> <M trials> <poolFile> <prevTableFile|none> <outFile>
// round 1: opponents are TRUE random hands from the full deck, split UNIFORMLY at random
//          (strategy_0). This is "best response to random."
// round N>=2: opponents are drawn from the pool and split according to the table
//          produced in round N-1 (strategy_{N-1}). This is "best response to strategy_{N-1}."
const fs = require('fs');
const path = require('path');
const { P, allPartitions, randomSplit, evalAssignment, pointsFromEvals, canonicalKey, fmtAssignment } = require('./common.js');

const round = Number(process.argv[2]);
const M = Number(process.argv[3]);
const poolFile = process.argv[4];
const prevTableFile = process.argv[5];
const outFile = process.argv[6];

const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
let prevTable = null;
if (prevTableFile && prevTableFile !== 'none') {
  prevTable = JSON.parse(fs.readFileSync(prevTableFile, 'utf8')); // { id: { partition, ev } }
}

function overlaps(a, b) {
  const s = new Set(a);
  return b.some((c) => s.has(c));
}

function pickPoolOpponent(focalCards) {
  // rejection sample a pool entry that shares no cards with the focal hand
  for (let tries = 0; tries < 40; tries++) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!overlaps(focalCards, cand.cards)) return cand;
  }
  return null; // give up (pool too small / bad luck) — caller should handle
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

for (let i = 0; i < pool.length; i++) {
  const entry = pool[i];
  const trials = round === 1 ? makeTrialsRound1(entry.cards) : makeTrialsLaterRound(entry.cards);

  let best = { ev: -Infinity, partition: null };
  for (const part of allPartitions(entry.cards)) {
    let total = 0;
    for (const trial of trials) {
      total += pointsFromEvals(evalAssignment(part, trial.boards), trial.oppEvals);
    }
    const ev = total / trials.length;
    if (ev > best.ev) best = { ev, partition: part };
  }

  table[entry.id] = { partition: best.partition, ev: best.ev, key: canonicalKey(best.partition) };

  if ((i + 1) % 20 === 0 || i === pool.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`round ${round}: ${i + 1}/${pool.length} hands solved (${elapsed}s elapsed)`);
  }
}

fs.writeFileSync(outFile, JSON.stringify(table));
console.log(`round ${round} done in ${((Date.now() - startTime) / 1000).toFixed(1)}s -> ${outFile}`);

// quick peek at hand 0
const h0 = pool[0];
console.log(`\nsample (pool id 0, cards ${h0.cards.join(' ')}):`);
console.log(`  chosen split: ${fmtAssignment(table[0].partition)}   EV=${table[0].ev.toFixed(3)}`);
