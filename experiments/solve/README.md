# Strategy solver / equilibrium research

Standalone Node scripts (only dependency: `../../lib/poker.js`) used to research optimal
hand-splitting strategy for this game. Nothing here is required to run the actual site —
it's the research behind the strategy discussion in the main README and the chat that
produced this project. All scripts are plain `node <script>.js <args>`, no build step.

## Core files

- `common.js` — shared helpers: all 105 ways to partition a 7-card hand, uniform-random
  partitioning, hand evaluation against a board pair, standard scoring (`pointsFromEvals`)
  and homerun scoring (`pointsHomerun`).
- `build_pool.js <size> <outFile>` — generates a pool of random 7-card hands.
- `solve_round.js <round> <M> <poolFile> <prevTableFile|none> <outFile>` — iterative
  best-response bootstrap under STANDARD scoring. Round 1 best-responds to uniformly
  random splitting; round N best-responds to round N-1's table (opponents drawn from the
  same pool). This is how you approximate a Nash equilibrium for a game with no
  bluffing/signaling channel — see the chat for the full argument.
- `solve_round_hr.js` — identical bootstrap, but scored with the HOMERUN modifier
  throughout (both the cached opponent responses and your own argmax use `pointsHomerun`),
  so it converges toward an equilibrium where both sides have adapted to the modifier.
- `solve_fixed.js <startIdx> <endIdx> <focalPoolFile> <oppPoolFile> <oppTableFile> <M> <outFile>` —
  cheaper one-shot solve: best-response for NEW focal hands against an already-converged,
  FIXED opponent table (doesn't re-solve the opponent side). Used to scale up to 1000
  example hands without re-running the full bootstrap.
- `homerun.js` — for a batch of hands, computes BOTH the standard-optimal and
  homerun-optimal split from the *same* Monte Carlo trials (opponent fixed, from the
  120-hand pool's round-5 table), so the two are directly comparable.
- `top_partitions.js <poolId> <M> <tableFile>` — prints the top-6 (of 105) partitions by
  EV for one hand, useful for checking whether a round-to-round "flip" is a real strategy
  change or just noise between near-tied options.
- `analyze.js` — convergence report across `round1.json`...`round5.json` (% of hands that
  changed their chosen split each round, mean EV per round, sample trajectories).

## What's saved here (from the actual runs)

- `pool.json` — 120-hand pool used for the main iterative bootstrap.
- `round1.json`...`round5.json` — 5 rounds of standard-scoring bootstrap on that pool.
  Mean EV per round: 2.30 / 0.61 / 0.52 / 0.59 / 0.63 — most convergence happens in the
  first iteration, then plateaus.
- `round1_hr.json`, `round2_hr.json`, `round3_hr.json` — 3 rounds of homerun-scoring
  bootstrap on the same pool. Mean EV: 4.42 / 1.37 / 0.97 — converging more slowly than
  the standard-rules version; a 4th-5th round would tighten it further if you want that.
- `pool1000.json`, `chunk_*.json`, `round1000_standard.json` — 1000 fresh hands solved
  against the (fixed) round-5 standard-rules field, for a larger example set.
- `homerun_0_200.json` — 200 hands with both standard-optimal and homerun-optimal splits
  computed from shared trials, for the homerun-vs-standard strategy comparison.

## Reproducing / extending

```bash
node build_pool.js 120 my_pool.json
node solve_round.js 1 60 my_pool.json none my_round1.json
node solve_round.js 2 60 my_pool.json my_round1.json my_round2.json
# ...repeat, then:
node analyze.js   # edit the file list at the top if you used different filenames
```

Each round over a 120-hand pool at 60 trials/hand takes ~4 minutes on a single core.
Runtime scales roughly linearly in `pool size x M trials` — budget accordingly for bigger
runs (the 1000-hand solve took ~33 minutes total, chunked into 200-hand pieces to stay
under typical shell/tool timeouts).
