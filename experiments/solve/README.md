# Strategy solver / equilibrium research

Standalone Node scripts (only dependency: `../../lib/poker.js`) used to research optimal
hand-splitting strategy for this game. Nothing here is required to run the actual site —
it's the research behind the strategy discussion in the main README and the chat that
produced this project. All scripts are plain `node <script>.js <args>`, no build step.

## Core files

- `common.js` — shared helpers: all 105 ways to partition a 7-card hand, uniform-random
  partitioning, hand evaluation against a board pair, standard scoring (`pointsFromEvals`)
  and homerun scoring (`pointsHomerun`). **`pointsHomerun` matches the live site's actual
  rule**: sweeping all 6 comparisons against an opponent — all 3 categories, on both
  boards, no ties anywhere — doubles the whole 12-point match total (12 → 24). It was
  fixed to this definition after an earlier version incorrectly doubled per-board (see
  "What's saved here" below) — any new solve should always go through this file's
  `pointsHomerun`, not a local reimplementation.
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
- `solve_fixed_hr.js` — the homerun-scored counterpart to `solve_fixed.js` (same fixed-
  opponent-table scale-up, but via `pointsHomerun`). This is what produced
  `round1000_hr.json` from the converged `round5_hr.json` field.
- `homerun.js` — for a batch of hands, computes BOTH the standard-optimal and
  homerun-optimal split from the *same* Monte Carlo trials (opponent fixed, from the
  120-hand pool's round-5 table), so the two are directly comparable. Uses the same
  corrected `pointsHomerun` definition as `common.js`.
- `top_partitions.js <poolId> <M> <tableFile>` — prints the top-6 (of 105) partitions by
  EV for one hand, useful for checking whether a round-to-round "flip" is a real strategy
  change or just noise between near-tied options.
- `analyze.js` — convergence report across `round1.json`...`round5.json` (% of hands that
  changed their chosen split each round, mean EV per round, sample trajectories).
  `analyze_hr.js` is the same report for `round1_hr.json`...`round5_hr.json`.
- `build_opponent_pool.js` — merges `round1000_standard.json` + `round5.json` (the
  STANDARD-rules solve) into a flat (hand, split) array. Superseded by
  `build_opponent_pool_hr.js` for what actually ships to the browser (see below); kept
  here in case you want a pure standard-rules pool for some other purpose.
- `build_opponent_pool_hr.js` — merges `round1000_hr.json` + `round5_hr.json` (the
  HOMERUN-rules solve) into the flat (hand, split) array that ships as
  `../../public/opponent-pool.json`, the one **Practice Mode** actually loads in-browser.
  Homerun scoring is a permanent base rule in the live game now, so the opponent pool is
  solved for an opponent who's adapted to it, not a standard-rules opponent with the bonus
  tacked onto the scoring after the fact. Re-run this (`node build_opponent_pool_hr.js >
  ../../public/opponent-pool.json`) any time `round1000_hr.json`/`round5_hr.json` are
  regenerated.

## What's saved here (from the actual runs)

- `pool.json` — 120-hand pool used for the main iterative bootstrap (shared by both the
  standard and homerun tracks, so the two are directly comparable hand-for-hand).
- `round1.json`...`round5.json` — 5 rounds of standard-scoring bootstrap on that pool.
  Mean EV per round: 2.30 / 0.61 / 0.52 / 0.59 / 0.63 — most convergence happens in the
  first iteration, then plateaus.
- `round1_hr.json`...`round5_hr.json` — 5 rounds of homerun-scoring bootstrap on the same
  pool, under the corrected full-match-sweep rule. Mean EV per round: 3.04 / 1.00 / 0.58 /
  0.64 / 0.72 — same overall shape as the standard-rules run (a big first-round drop, then
  settling into a similar-magnitude plateau), just converging to a different equilibrium
  split for a meaningful fraction of hands.
- `round1_hr_legacy_perboard.json`...`round3_hr_legacy_perboard.json` — the ORIGINAL 3
  rounds of homerun bootstrap, kept for history only. These used an incorrect per-board
  reading of the rule (double whichever single board you swept 3-for-3) rather than the
  live site's actual rule (sweep all 6 comparisons across both boards before doubling the
  whole match). Don't use these for anything live — they document a bug that's since been
  fixed in `common.js`.
- `pool1000.json`, `chunk_*.json`, `round1000_standard.json` — 1000 fresh hands solved
  against the (fixed) round-5 standard-rules field, for a larger example set.
- `pool1000_hr.json`, `chunk_hr_*.json`, `round1000_hr.json` — the same scale-up, 1000
  fresh hands solved against the (fixed) round-5 **homerun**-rules field. This is the pool
  `build_opponent_pool_hr.js` actually ships to the browser.
- `homerun_0_200.json` — 200 hands with both standard-optimal and homerun-optimal splits
  computed from shared trials, for the homerun-vs-standard strategy comparison. (Generated
  before the per-board rule was fixed — the comparison's qualitative shape, reinforcing
  the 1-card slot, still held after the fix in spot checks, but these specific numbers
  predate the correction; re-run `homerun.js` if you want fresh ones against the corrected
  rule.)

## Reproducing / extending

```bash
node build_pool.js 120 my_pool.json
node solve_round.js 1 60 my_pool.json none my_round1.json
node solve_round.js 2 60 my_pool.json my_round1.json my_round2.json
# ...repeat, then:
node analyze.js   # edit the file list at the top if you used different filenames
```

Same idea for the homerun track, just with `solve_round_hr.js` and `analyze_hr.js`.

Each round over a 120-hand pool at 60 trials/hand takes ~4-5 minutes on a single core.
Runtime scales roughly linearly in `pool size x M trials` — budget accordingly for bigger
runs (each 1000-hand scale-up, standard or homerun, took ~35-40 minutes total, chunked
into 200-hand pieces to stay under typical shell/tool timeouts).
