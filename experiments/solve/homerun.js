// "Homerun" modifier, matching the live site's actual rule (lib/game.js's
// computeResults): sweeping ALL 6 comparisons against this opponent -- all 3
// categories, on BOTH boards, with no ties anywhere -- doubles the WHOLE match total
// (12 -> 24). Sweeping just one board is NOT enough on its own and scores normally.
// This script computes, for the SAME hand + SAME trial data, both the standard-optimal
// and homerun-optimal partition, so the comparison is apples-to-apples.
const fs = require('fs');
const { P, allPartitions, evalAssignment, pointsFromEvals, canonicalKey, fmtAssignment } = require('./common.js');

const [startIdx, endIdx, focalPoolFile, oppPoolFile, oppTableFile, MStr, outFile] = process.argv.slice(2);
const M = Number(MStr);

const focalPool = JSON.parse(fs.readFileSync(focalPoolFile, 'utf8'));
const oppPool = JSON.parse(fs.readFileSync(oppPoolFile, 'utf8'));
const oppTable = JSON.parse(fs.readFileSync(oppTableFile, 'utf8'));

const POINTS = { one: 1, two: 2, four: 3 };
const STANDARD_TOTAL = POINTS.one + POINTS.two + POINTS.four; // 6
const MATCH_TOTAL = STANDARD_TOTAL * 2; // 12

function pointsHomerun(myEvals, oppEvals) {
  let total = 0;
  let allWon = true;
  let allLost = true;
  for (const cat of ['one', 'two', 'four']) {
    for (let b = 0; b < 2; b++) {
      const cmp = P.compareScores(myEvals[cat][b], oppEvals[cat][b]);
      const pts = POINTS[cat];
      if (cmp > 0) total += pts;
      else if (cmp < 0) total -= pts;
      if (cmp <= 0) allWon = false;
      if (cmp >= 0) allLost = false;
    }
  }
  const homeruns = allWon ? 1 : 0; // I swept this match (both boards)
  const gotHomeruned = allLost ? 1 : 0; // opponent swept this match
  if (allWon) total += MATCH_TOTAL;
  else if (allLost) total -= MATCH_TOTAL;
  return { total, homeruns, gotHomeruned };
}

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
const results = {};
const from = Number(startIdx);
const to = Number(endIdx);

for (let i = from; i < to; i++) {
  const entry = focalPool[i];
  const trials = makeTrials(entry.cards);

  let bestStd = { ev: -Infinity, partition: null };
  let bestHR = { ev: -Infinity, partition: null, homerunRate: 0 };
  const perPartitionHR = []; // for computing homerun-rate of the standard-optimal choice too

  for (const part of allPartitions(entry.cards)) {
    let stdTotal = 0;
    let hrTotal = 0;
    let hrCount = 0;
    let hrAgainstCount = 0;
    for (const trial of trials) {
      const myEvals = evalAssignment(part, trial.boards);
      stdTotal += pointsFromEvals(myEvals, trial.oppEvals);
      const hr = pointsHomerun(myEvals, trial.oppEvals);
      hrTotal += hr.total;
      hrCount += hr.homeruns;
      hrAgainstCount += hr.gotHomeruned;
    }
    const stdEv = stdTotal / trials.length;
    const hrEv = hrTotal / trials.length;
    const homerunRate = hrCount / trials.length; // per match (at most 1 per trial now)
    perPartitionHR.push({ key: canonicalKey(part), homerunRate });

    if (stdEv > bestStd.ev) bestStd = { ev: stdEv, partition: part, key: canonicalKey(part) };
    if (hrEv > bestHR.ev) bestHR = { ev: hrEv, partition: part, key: canonicalKey(part), homerunRate };
  }

  // also: what's the homerun-EV AND homerun-rate of playing the standard-optimal partition?
  let stdPartitionHrTotal = 0;
  let stdPartitionHrCount = 0;
  for (const trial of trials) {
    const myEvals = evalAssignment(bestStd.partition, trial.boards);
    const hr = pointsHomerun(myEvals, trial.oppEvals);
    stdPartitionHrTotal += hr.total;
    stdPartitionHrCount += hr.homeruns;
  }

  results[entry.id] = {
    cards: entry.cards,
    standardBest: { partition: bestStd.partition, ev: bestStd.ev, key: bestStd.key },
    homerunBest: { partition: bestHR.partition, ev: bestHR.ev, key: bestHR.key, homerunRate: bestHR.homerunRate },
    standardPartitionUnderHomerunRule: {
      ev: stdPartitionHrTotal / trials.length,
      homerunRate: stdPartitionHrCount / trials.length
    }
  };

  if ((i - from + 1) % 25 === 0 || i === to - 1) {
    console.log(`[${from}-${to}] ${i - from + 1}/${to - from} done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
}

fs.writeFileSync(outFile, JSON.stringify(results));
console.log(`homerun chunk [${from},${to}) done in ${((Date.now() - start) / 1000).toFixed(1)}s -> ${outFile}`);
