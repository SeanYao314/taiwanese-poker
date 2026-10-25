# Strategy solver / equilibrium research

Standalone Node scripts (only dependency: `../../lib/poker.js`) used to research optimal
hand-splitting strategy for this game. Nothing here is required to run the actual site —
it's the research behind the strategy discussion in the main README and the chat that
produced this project. All scripts are plain `node <script>.js <args>`, no build step.

There are two parallel tracks: a **standard-rules** solve (`pointsFromEvals`) and a
**homerun-rules** solve (`pointsHomerun`). Homerun scoring changes the best split for a
meaningful fraction of hands, so these are genuinely different equilibria and are kept as
separate pipelines/files end to end. Only the **homerun** track ships to the browser, since
homerun scoring is always on in the live game now.

## Core files

- `common.js` — shared helpers: all 105 ways to partition a 7-card hand, uniform-random
  partitioning, hand evaluation against a board pair, standard scoring (`pointsFromEvals`)
  and homerun scoring (`pointsHomerun`). **`pointsHomerun` matches the live site's actual
  rule**: sweeping all 6 comparisons against an opponent — all 3 categories, on both
  boards, no ties anywhere — doubles the whole 12-point match total (12 → 24). It was fixed
  to this definition after an earlier version incorrectly doubled per-board (see "What's
  saved here"); any new solve should go through this function, not a local reimplementation.
- `build_pool.js <size> <outFile>` — generates a pool of random 7-card hands.
- `solve_round.js <round> <M> <poolFile> <prevTableFile|none> <outFile>` — iterative
  best-response bootstrap under STANDARD scoring. Round 1 best-responds to uniformly random
  splitting; round N best-responds to round N-1's table (opponents drawn from the same
  pool). This is how you approximate a Nash equilibrium for a game with no
  bluffing/signaling channel — see the chat for the full argument.
- `solve_round_hr.js` — identical bootstrap, but scored with the HOMERUN modifier
  throughout (both the cached opponent responses and your own argmax use `pointsHomerun`),
  so it converges toward an equilibrium where both sides have adapted to the modifier.
- `solve_round_hr_chunked.js <round> <M> <poolFile> <prevTableFile|none> <startIdx> <endIdx> <outFile>` —
  same as `solve_round_hr.js` but solves only the hand-index slice `[startIdx, endIdx)`, so
  one round over a larger pool can be split across several processes/commands. The opponent
  side still samples from the **whole** pool, so a chunk's output is identical to what the
  unchunked script would produce for those indices. Merge all of a round's chunks into one
  table file before using it as the next round's `prevTableFile`.
- `solve_fixed.js <startIdx> <endIdx> <focalPoolFile> <oppPoolFile> <oppTableFile> <M> <outFile>` —
  cheaper one-shot solve: best-response for NEW focal hands against an already-converged,
  FIXED opponent table (doesn't re-solve the opponent side). Used to scale up to many
  example hands without re-running the full bootstrap.
- `solve_fixed_hr.js` — the homerun-scored counterpart to `solve_fixed.js`. This is what
  produced `round5000_hr.json` from the converged `round5_hr.json` field.
- `homerun.js` — for a batch of hands, computes BOTH the standard-optimal and
  homerun-optimal split from the *same* Monte Carlo trials, so the two are directly
  comparable. Uses the same corrected `pointsHomerun` definition as `common.js`.
- `top_partitions.js <poolId> <M> <tableFile>` — prints the top-6 (of 105) partitions by EV
  for one hand, useful for checking whether a round-to-round "flip" is a real strategy
  change or just noise between near-tied options.
- `analyze.js` / `analyze_hr.js` — convergence reports (% of hands that changed their
  chosen split each round, mean EV per round, stability across the last 3 rounds, sample
  trajectories). `analyze.js` reads `pool.json` + `round1..5.json`; `analyze_hr.js` reads
  `pool400_hr.json` + `round1..5_hr.json`.
- `build_opponent_pool.js` — merges the STANDARD-rules solve into a flat (hand, split)
  array. Superseded by the homerun version below for what actually ships; kept in case you
  want a pure standard-rules pool.
- `build_opponent_pool_hr.js` — merges `round5000_hr.json` + `round5_hr.json` into the flat
  array that ships as `../../public/opponent-pool.json`, which **Practice Mode** loads
  in-browser. Re-run (`node build_opponent_pool_hr.js > ../../public/opponent-pool.json`)
  any time those sources are regenerated.

## What's saved here (from the actual runs)

### Standard-rules track
- `pool.json` — 120-hand pool for the standard bootstrap.
- `round1.json`...`round5.json` — 5 rounds of standard-scoring bootstrap on it. Mean EV per
  round: 2.30 / 0.61 / 0.52 / 0.59 / 0.63 — most movement in the first iteration, then a
  plateau.
- `pool1000.json`, `chunk_*.json`, `round1000_standard.json` — 1000 fresh hands solved
  against the fixed round-5 standard field.

### Homerun-rules track (what ships)
- `pool400_hr.json` — **400-hand pool** for the homerun bootstrap. Bigger than the standard
  track's 120 so each round's field is more diverse (and so the round-5 field the scale-up
  best-responds to is a better-sampled population).
- `round1_hr.json`...`round5_hr.json` — 5 rounds of corrected-rule homerun bootstrap on
  that 400-hand pool, `M=60` trials/hand. Mean EV per round: 2.97 / 0.74 / 0.60 / 0.70 /
  0.73 — same shape and magnitude as the standard track's run, so the homerun modifier
  doesn't make the game converge any less cleanly; it just lands on a different equilibrium.
  Per-round partition turnover stays high (~69-75%) and only ~10% of hands hold an
  identical split across rounds 3-4-5, because many of the 105 partitions sit within
  Monte Carlo noise of each other — the *population* EV stabilizes even while individual
  near-tied choices keep flipping. That's why the EV plateau, not per-hand stability, is
  the convergence signal here.
- `pool10000_hr.json` — 10,000 fresh focal hands for the scale-up. Only the first 5,000 are
  solved so far; the remaining indices are there so the pool can be extended later without
  regenerating or re-solving anything (each chunk is independent).
- `chunk_hr_*.json`, `round5000_hr.json` — the first **5,000** of those hands, solved
  against the fixed round-5 400-hand homerun field via `solve_fixed_hr.js`. Merged with
  `round5_hr.json` into the 5,400-entry shipped opponent pool.

### Superseded (kept for history — don't use these for anything live)
- `round1_hr_pool120.json`...`round5_hr_pool120.json`, `chunk_hr_pool120_*.json`,
  `round1000_hr_pool120.json` — the first corrected-rule homerun run, done on the 120-hand
  `pool.json` with a 1,000-hand scale-up. Same (correct) scoring rule as the current files,
  just a smaller field; superseded by the 400-hand/5,000-hand run above.
- `round1_hr_legacy_perboard.json`...`round3_hr_legacy_perboard.json` — the ORIGINAL
  homerun bootstrap, which used an incorrect per-board reading of the rule (double
  whichever single board you swept 3-for-3) rather than requiring a sweep of all 6
  comparisons across both boards. These document a bug since fixed in `common.js`.
- `homerun_0_200.json` — 200 hands with both standard-optimal and homerun-optimal splits
  from shared trials. Generated before the per-board rule was fixed; the qualitative
  finding (homerun scoring favors reinforcing the 1-card slot rather than dumping your
  weakest card there) held up in spot checks after the fix, but these specific numbers
  predate it. Re-run `homerun.js` if you want fresh ones.

## Reproducing / extending

Standard track:

```bash
node build_pool.js 120 my_pool.json
node solve_round.js 1 60 my_pool.json none my_round1.json
node solve_round.js 2 60 my_pool.json my_round1.json my_round2.json
# ...repeat, then:
node analyze.js   # edit the file list at the top if you used different filenames
```

Homerun track, one round at a time, two chunks in parallel (this box has 2 cores), merging
each round before starting the next:

```bash
node solve_round_hr_chunked.js 2 60 pool400_hr.json round1_hr.json   0 200 r2_a.json &
node solve_round_hr_chunked.js 2 60 pool400_hr.json round1_hr.json 200 400 r2_b.json &
wait
node -e "const fs=require('fs');const m={};for(const p of ['r2_a','r2_b'])Object.assign(m,JSON.parse(fs.readFileSync(p+'.json')));fs.writeFileSync('round2_hr.json',JSON.stringify(m))"
```

Then scale up against the converged field and rebuild the shipped pool:

```bash
node solve_fixed_hr.js 0 200 pool10000_hr.json pool400_hr.json round5_hr.json 60 chunk_hr_0_200.json
# ...repeat for each 200-hand slice, merge into round5000_hr.json, then:
node build_opponent_pool_hr.js > ../../public/opponent-pool.json
```

Cost, measured on this 2-core box: roughly **2 seconds per hand per core** at `M=60`
(that's 105 partitions x 60 trials of hand evaluation). So a 400-hand bootstrap round takes
~6-8 minutes with two parallel chunks, a full 5-round bootstrap ~35 minutes, and the
5,000-hand scale-up ~105 minutes. Runtime scales linearly in `hands x M`, and every chunk
is independent, so throwing more cores at it (or extending the scale-up later) is just more
parallel chunks.
