// lib/poker.js
// Card representation: 2-char strings, e.g. "As" (Ace of spades), "Td" (Ten of diamonds).
// Ranks: 2 3 4 5 6 7 8 9 T J Q K A   Suits: s h d c
//
// This file is UMD-style so the exact same evaluator runs both server-side (via
// require()) and in the browser (served directly as a <script> at /lib/poker.js,
// used by Practice Mode) — no ports, no risk of client/server logic drift.

const RANKS = '23456789TJQKA';
const SUITS = 's h d c'.split(' ');

const CATEGORY_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Trips',
  'Straight',
  'Flush',
  'Full House',
  'Quads',
  'Straight Flush'
];

function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}
function suitOf(card) {
  return card[1];
}

// Generate all k-combinations of arr (arr of any items). Fine for small n (n<=7).
function combinations(arr, k) {
  const results = [];
  const n = arr.length;
  if (k > n) return results;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    results.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return results;
}

// Evaluate exactly 5 cards. Returns a score array; compare lexicographically.
// score[0] = category (0-8, higher is better), rest are tiebreakers (higher better).
function evaluate5(cards) {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ r: Number(r), c }))
    .sort((a, b) => b.c - a.c || b.r - a.r);

  const uniqueDesc = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) {
      isStraight = true;
      straightHigh = uniqueDesc[0];
    } else if (uniqueDesc.join(',') === '14,5,4,3,2') {
      // wheel: A-2-3-4-5, straight high is the 5
      isStraight = true;
      straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0].c === 4) return [7, groups[0].r, groups[1].r];
  if (groups[0].c === 3 && groups[1] && groups[1].c === 2) return [6, groups[0].r, groups[1].r];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0].c === 3) return [3, groups[0].r, ...groups.slice(1).map((g) => g.r)];
  if (groups[0].c === 2 && groups[1] && groups[1].c === 2) {
    const pairs = [groups[0].r, groups[1].r].sort((a, b) => b - a);
    return [2, ...pairs, groups[2].r];
  }
  if (groups[0].c === 2) return [1, groups[0].r, ...groups.slice(1).map((g) => g.r)];
  return [0, ...ranks];
}

// Lexicographic compare of two score arrays. Returns >0 if a>b, <0 if a<b, 0 if equal.
function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? -1 : a[i];
    const bv = b[i] === undefined ? -1 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Best 5-card hand out of an arbitrary pool of cards (no usage restriction).
function bestOfPool(pool) {
  const combos = combinations(pool, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (!best || compareScores(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

// 1-card hand: your 1 card + the 5-card board = 6 cards, best 5 of 6 (you may even "play the board").
// 2-card hand: your 2 cards + the 5-card board = 7 cards, best 5 of 7, no restriction (hold'em style).
function bestGeneric(handCards, board) {
  return bestOfPool([...handCards, ...board]);
}

// 4-card PLO hand: must use EXACTLY 2 of your 4 hand cards + EXACTLY 3 of the 5 board cards
// (standard Omaha/PLO hand construction rule).
function bestPLO(handCards4, board) {
  const handPairs = combinations(handCards4, 2);
  const boardTriples = combinations(board, 3);
  let best = null;
  for (const hp of handPairs) {
    for (const bt of boardTriples) {
      const combo = [...hp, ...bt];
      const score = evaluate5(combo);
      if (!best || compareScores(score, best.score) > 0) best = { score, cards: combo };
    }
  }
  return best;
}


// ---------------------------------------------------------------------------
// Integer-packed 5-card evaluator.
//
// evaluate5() above is the readable reference: it returns a score ARRAY and needs
// compareScores() to order two hands. That costs several allocations per call (a mapped
// rank array, a sort, a counts object, Object.entries, a Set, spread arrays), which is
// fine for scoring one hand and ruinous when Practice Mode scores tens of millions.
//
// eval5i() returns the SAME ordering as evaluate5()+compareScores() packed into one
// integer, so comparing is `a - b` and a call allocates nothing. Layout:
//
//   bits 20-23  category 0-8 (same numbering as evaluate5)
//   bits  0-19  up to five 4-bit tiebreakers, most significant first
//
// Cards are ints here, not strings: `rank * 4 + suit`, rank 0-12 for 2..A, suit 0-3.
// Internal rank 0-12 vs evaluate5's 2-14 doesn't matter — only the order does.
const CARD_INTS = (() => {
  const m = Object.create(null);
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) m[RANKS[r] + SUITS[s]] = r * 4 + s;
  return m;
})();

function cardToInt(card) {
  return CARD_INTS[card];
}

function cardsToInts(cards) {
  const out = new Int32Array(cards.length);
  for (let i = 0; i < cards.length; i++) out[i] = CARD_INTS[cards[i]];
  return out;
}

const RC_ = new Int8Array(13); // rank counts, reused across calls — eval5i is not reentrant
const WHEEL_MASK = (1 << 12) | (1 << 3) | (1 << 2) | (1 << 1) | (1 << 0); // A,5,4,3,2

function eval5i(c0, c1, c2, c3, c4) {
  RC_[0] = 0; RC_[1] = 0; RC_[2] = 0; RC_[3] = 0; RC_[4] = 0; RC_[5] = 0; RC_[6] = 0;
  RC_[7] = 0; RC_[8] = 0; RC_[9] = 0; RC_[10] = 0; RC_[11] = 0; RC_[12] = 0;
  RC_[c0 >> 2]++; RC_[c1 >> 2]++; RC_[c2 >> 2]++; RC_[c3 >> 2]++; RC_[c4 >> 2]++;

  const s = c0 & 3;
  const isFlush = (c1 & 3) === s && (c2 & 3) === s && (c3 & 3) === s && (c4 & 3) === s;

  // One descending pass over the ranks gives every group in evaluate5's sort order
  // (count desc, then rank desc) without building or sorting anything.
  let quad = -1, trip = -1, pair1 = -1, pair2 = -1;
  let kick = 0, distinct = 0, mask = 0;
  for (let r = 12; r >= 0; r--) {
    const c = RC_[r];
    if (c === 0) continue;
    distinct++;
    mask |= 1 << r;
    if (c === 4) quad = r;
    else if (c === 3) trip = r;
    else if (c === 2) { if (pair1 < 0) pair1 = r; else pair2 = r; }
    else kick = (kick << 4) | r;
  }

  let straightHigh = -1;
  if (distinct === 5) {
    const lo = mask & -mask;                 // lowest set bit
    if (mask === lo * 31) straightHigh = 31 - Math.clz32(mask); // 5 consecutive -> top rank
    else if (mask === WHEEL_MASK) straightHigh = 3;             // wheel: the 5 plays high
  }

  if (straightHigh >= 0 && isFlush) return (8 << 20) | straightHigh;
  if (quad >= 0) return (7 << 20) | (quad << 4) | kick;
  if (trip >= 0 && pair1 >= 0) return (6 << 20) | (trip << 4) | pair1;
  if (isFlush) return (5 << 20) | kick;
  if (straightHigh >= 0) return (4 << 20) | straightHigh;
  if (trip >= 0) return (3 << 20) | (trip << 8) | kick;
  if (pair2 >= 0) return (2 << 20) | (pair1 << 8) | (pair2 << 4) | kick;
  if (pair1 >= 0) return (1 << 20) | (pair1 << 12) | kick;
  return kick;
}

function categoryName(score) {
  return CATEGORY_NAMES[score[0]];
}

const PokerLib = {
  RANKS,
  SUITS,
  CATEGORY_NAMES,
  freshDeck,
  shuffle,
  rankValue,
  suitOf,
  combinations,
  evaluate5,
  compareScores,
  cardToInt,
  cardsToInts,
  eval5i,
  bestOfPool,
  bestGeneric,
  bestPLO,
  categoryName
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PokerLib;
} else {
  window.Poker = PokerLib;
}
