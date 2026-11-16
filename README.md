# Taiwanese Poker

Real-time multiplayer web app for the "Taiwanese" poker variant: 7 cards split into a 1-card, 2-card, and 4-card PLO hand, run against two 5-card boards, scored head-to-head against every other player at the table.

No external dependencies — it's built entirely on Node's built-in `http` module (no npm install required), which also makes it trivial to deploy anywhere that runs Node.

## Rules implemented

- Each player gets 7 cards and splits them into a **1-card hand**, a **2-card hand**, and a **4-card hand**, using all 7 cards.
- Two independent 5-card boards ("Board A" and "Board B") are dealt.
- Each hand combines with each board to make the best possible 5-card poker hand:
  - **1-card hand**: best 5 of your 1 card + the 5-card board (you can even "play the board" if it's already better without your card).
  - **2-card hand**: best 5 of your 2 cards + the 5-card board, hold'em style — any combination of 0, 1, or 2 of your cards.
  - **4-card hand**: standard PLO/Omaha construction — you must use **exactly 2** of your 4 cards plus **exactly 3** board cards.
- Every player is compared against every other player, per board, per hand type. Winning the 1-card comparison is worth **1 point**, the 2-card comparison **2 points**, the 4-card (PLO) comparison **3 points** — each is scored separately on both boards, so max swing per opponent per hand is 12 points.
- An exact tie is a **push** — no points change hands for that comparison.
- Scoring is zero-sum: add up your result against every other player at the table.

If your house rules differ (e.g. you use a scoop bonus, or suits break exact ties instead of pushing), the scoring logic all lives in `lib/game.js` and `lib/poker.js` — see "Customizing the rules" below.

### Homerun scoring

Homerun scoring is a permanent part of the base rules, not an option anyone picks: if you beat a given opponent in **all 6 comparisons** against them — all 3 hand categories, on **both** boards, with no ties anywhere — the entire match total against that opponent doubles: 12 points becomes 24 (or −24 if they sweep you instead). Sweeping just one board isn't enough on its own; anything short of the full 6-for-6 sweep scores normally, with no bonus. The results screen shows a banner and a badge on any player who hits one. There's no way to turn it off — it applies to every hand, in every room, and in Practice Mode (see below).

Note: `experiments/solve/` (below) was researched under an earlier, per-board version of this rule (sweep one board, double that board's 6 points). The homerun-vs-standard strategy notes there are illustrative of the general effect — reinforcing the 1-card slot instead of dumping your weakest card there — but haven't been re-run against the current full-match-sweep definition; treat those specific numbers as approximate if you want to lean on them precisely.

## Running it locally

Requires Node.js 18+ (no other dependencies).

```bash
node server.js
```

Then open `http://localhost:3000` in a browser. Open it in a couple more tabs (or have friends on the same network hit `http://<your-local-ip>:3000`) to test a multiplayer game.

Run the sanity test suite any time with:

```bash
node tests/poker.test.js          # dependency-free: evaluator + scoring engine
node tests/eval5i.test.js         # dependency-free: all 2,598,960 hands, both evaluators
node tests/bot.test.js            # dependency-free: GTO bot split quality
node tests/bots_api.test.js       # dependency-free: bot seats over real HTTP + SSE
node tests/practice_ui.test.js    # drives the practice drills in real Chromium (needs playwright)
node tests/precision_ui.test.js   # EV precision presets + delta-table equivalence (Chromium)
node tests/lobby_bots_ui.test.js  # drives the lobby bot controls in Chromium (needs playwright)
```

That's 184 assertions across the seven suites. The first four have no dependencies at all
(`bots_api.test.js` starts its own server and plays a full hand against bots over real HTTP).
The three UI tests need `playwright` with a Chromium available and also start/stop their own
server; if playwright isn't installed they skip themselves rather than failing.

## How the game works

1. One player creates a room (picks a max player count, 2–4, and optionally some GTO bots to fill seats) and gets a 4-character room code plus a shareable link.
2. Others join with that code from the landing page's "Join Room" tab.
3. Once at least 2 seats are filled — humans, bots, or a mix — the host clicks **Start Game** and everyone is privately dealt 7 cards.
4. Each player clicks a card to select it, then clicks the hand box to place it there (click a placed card to send it back). **Lock Hand** becomes available once every card is assigned.
5. Once everyone has locked, both boards are revealed automatically along with every comparison, points for the hand (homerun scoring always included), and a running scoreboard.
6. The host clicks **Deal Next Hand** to continue; cumulative scores persist for the room's session.

Rooms and scores live in server memory only — restarting the server clears everything. That's fine for a casual game night; see below if you want persistence.

Cards render with a **4-color deck** (♠ black, ♥ red, ♦ blue, ♣ green) so all four suits are easy to tell apart at a glance — colors are defined in `public/style.css` (`--suit-spade`/`--suit-heart`/`--suit-diamond`/`--suit-club`) if you'd rather use the traditional red/black 2-color scheme.

### Win sounds

Live games (not Practice Mode) play a short chime when you win a hand — a quick ascending arpeggio right as the final scoreboard locks in. A homerun gets its own bigger fanfare instead (extra note, sparklier tail), timed to the ⚾ banner instead of the end of the reveal, and doesn't also trigger the plain win chime on top of it. Losing a hand or pushing stays silent — no "you lost" sound.

The sounds are synthesized in-browser with the Web Audio API (a couple of short oscillator tones per cue) rather than shipped as audio files, so there's nothing extra to host. The 🔊 button in the top-right of the header mutes/unmutes and remembers your preference (via `localStorage`) across visits. First-load autoplay restrictions mean the very first cue of a session needs at least one prior click/tap on the page to be audible — by the time you've clicked through creating or joining a room and locking a hand, that's already satisfied.

### Sorting your cards

Above "Your Cards," a small **Sort: Dealt / Rank / Suit** control lets you reorder the cards still in your hand — **Dealt** is the original deal order, **Rank** sorts high-to-low (ties broken by suit), and **Suit** groups cards by suit and then sorts high-to-low within each group. It's one shared, persisted preference (via `localStorage`) — pick a mode once and it applies everywhere this control appears: the live game's tray and Practice Mode's tray. It only reorders cards still waiting to be placed — cards you've already dropped into a 1/2/4-card slot keep whatever order you placed them in.

## GTO bots

Rooms can be filled with **GTO bot** seats, so you can start a game without waiting for
anyone — pick how many on the Create Room form (they're capped to leave you a seat), then
add, remove or rename them in the lobby. **Click a bot's name to rename it**; the name
sticks for the session and follows the bot into the results and the scoreboard. Only the
host manages bots, and only in the lobby (renaming works any time, since it's cosmetic).

A bot can't just look its hand up: `public/opponent-pool.json` holds 5,400 specific hands,
and a freshly dealt 7-card hand essentially never appears in it. So each bot **solves its
own hand every deal** (`lib/bot.js`), scoring all 105 ways to split it against a sample of
board runouts — where the opponents it samples are drawn from the solved pool, so it's
best-responding to near-equilibrium play rather than to random splitting. Homerun scoring is
included, since it's always on.

### Why it's fast

Done naively that's ~10,000 five-card evaluations per trial and takes about 100ms *per
trial*, which made a 4-seat table genuinely painful. Almost all of it is repeated work,
because across all 105 partitions of the same seven cards there are only 7 distinct 1-card
hands, 21 distinct 2-card hands, and 21 distinct hole *pairs* — and a PLO hand is by
definition exactly 2 hole cards plus exactly 3 board cards, so the best PLO hand for a
4-card group is just the best of its 6 pairs. The 4-card groups never need evaluating at
all.

So per board the bot builds three small tables once — the board on its own, each single card
with 4 board cards, each pair with 3 board cards — and every hand any partition could hold
becomes a max over a couple of table entries. That's a few hundred evaluations per board
instead of ~5,000, and scoring a partition afterwards is array lookups and integer adds.

The second layer is the evaluator itself. `evaluate5()` in `lib/poker.js` returns a score
*array* that `compareScores()` walks lexicographically — readable, and the definition of the
rules, but it allocates a mapped rank array, a sort, a counts object, a Set and several
spread arrays on every single call. `eval5i()` returns the same ordering packed into one
integer (4 bits of category, five 4-bit tiebreakers), so a call allocates nothing and
comparing two hands is `a - b`. That alone is **~15× faster**, and
`tests/eval5i.test.js` proves the two agree by evaluating **all 2,598,960 five-card hands**
and checking the orderings are identical, down to which hands tie — including that both
evaluators distinguish exactly 7,462 hand classes.

Together, with the bots now solving **300** trials each rather than 60:

| | before (60 trials) | after (300 trials) |
|---|---|---|
| one bot | 1,694 ms | **22–51 ms** |
| three bots (a full table) | 6,347 ms | **66 ms** |
| worst event-loop stall | 696 ms | **22 ms** |

The bots got five times deeper *and* roughly eight times faster, so the extra depth is free.

That last row is the one that made the game feel buggy rather than merely slow: the server
is a single-threaded Node process holding every player's SSE stream, so a bot that blocks
for 696ms freezes *everyone* — clicks ignored, updates stuck. The solve is now time-sliced,
yielding back to the event loop every few milliseconds, so the table stays responsive even
with three bots solving at once. `tests/bot.test.js` cross-checks the fast path against a
naive evaluation partition by partition: it's the same answers, just without the repeated
work.

While a bot is solving, the arranging screen shows a **seat strip** across the top — one
chip per seat, with pulsing dots next to any bot that's thinking, a checkmark once a seat
has locked, and "arranging…" for humans still deciding. Without it a solving bot looks
exactly like a human who wandered off, which is precisely when a game feels hung.

Two things worth knowing about how they play. A bot only knows its own seven cards — it
samples hypothetical opponents from the pool rather than peeking at what anyone actually
holds, so it isn't cheating with hidden information. And it's best-responding to the
*equilibrium field*, which means against that field it hovers around break-even rather than
printing money; `tests/bot.test.js` checks it beats a random split by a clear margin on
boards it never solved against, which is the honest version of "is it actually solving?"

## Practice (solo, no room needed)

The landing page's **Practice** tab drops you straight into a single-player training screen —
no room, no other players. You're dealt one random 7-card hand and try different ways to
split it; each split is scored against a batch of independent board runouts, every one
against an opponent hand pulled from a pool that was pre-solved offline via the iterative
best-response bootstrap in `experiments/solve/` (see below) — a strong, empirically
near-equilibrium opponent, not a random one.

Rearranging your cards and re-running is instant: the same evaluator that scores live games
(`lib/poker.js`) is served straight to the browser at `/lib/poker.js` and runs entirely
client-side, so there's no server round-trip per attempt. Critically, every split you try
during a session is scored against the exact same board set, so the EV numbers are directly
comparable to each other; the difference between two splits' EV isn't muddied by fresh Monte
Carlo noise each time. Save a split to build up a leaderboard of your attempts on that hand,
sorted by EV, with one-click reload to keep tweaking a promising one.

### EV precision: Standard, Deep, Max

There used to be two logarithmic sliders here — "boards per split" and a separate "ideal
split search boards" — plus the opponent sampling they implied. Sliders were the wrong
control, because the number you actually care about isn't a board count, it's **how wrong
the EV number might be**. The same 500 boards is plenty on one hand and badly noisy on
another, since how swingy a hand is varies a lot.

So the sliders are gone, replaced by three presets that name an accuracy target and then
spend whatever boards that hand needs to hit it:

| preset | target standard error, per individual hand | typical boards | typical wait |
|---|---|---|---|
| **Standard** (default) | ±0.05 pts | ~16,000 | ~1.5 s |
| **Deep** | ±0.03 pts | ~43,000 | ~4 s |
| **Max** | ±0.02 pts | ~75,000–100,000 | ~8 s |

The board counts are *outcomes*, not settings. The practice screen deals a hand, seeds 400
boards for an immediate reading, then keeps adding boards in the background until the
reported standard error reaches the target (or a hard cap stops a pathological hand running
forever). The EV panel shows a live number from the first moment with a `+` next to the board
count while it's still tightening, and the variance line says which it is:

```
SD ±6.44 pts/hand · this estimate is accurate to ±0.050 over 16,900 boards
                   · at the Standard target of ±0.05
```

One preset drives everything — the EV panel, the ideal-split search and all three drills — so
nothing on the screen is ever measured against a different sample than anything else. The
choice is remembered between sessions.

### What made ±0.05 affordable

±0.05 per individual hand is a tight promise. With a per-hand outcome SD around 6.4 points,
`SE = SD/√n` means roughly **16,000 boards per hand** — and under the old scorer, which took
about 700µs per board, that was 11.8 seconds of frozen tab per hand, with the 105-partition
ideal search costing a further 24 seconds. Not usable.

Candidate optimizations, and why each did or didn't make the cut:

| # | idea | verdict |
|---|---|---|
| 1 | **Per-trial delta tables** — store each board's *point deltas* vs that trial's opponent (`Int8Array`, 126 bytes/trial) instead of re-evaluating hands | **shipped** — re-scoring stops costing anything per board |
| 2 | **Integer-packed evaluator** (`eval5i`) — one int per hand instead of a score array, no allocation, compare by subtraction | **shipped** — ~15× on the dominant cost |
| 3 | Balanced opponent cycling — reshuffle and cycle the qualifying pool so every opponent is used equally | shipped earlier; 44% tighter at 14,000 boards, but it tightens the *true* error below the reported `SD/√n`, so it makes the promise conservative rather than cheaper |
| 4 | Web Worker (or several) to move the work off the main thread | not needed once 1+2 landed — 16,000 boards is now under a second of work, and 12ms time slices keep the tab fully responsive |
| 5 | Antithetic / stratified board sampling | rejected — board runouts are already shared across every split you compare, which is where the variance reduction that matters comes from |
| 6 | Server-side precompute of common hands | rejected — 2.3 billion hand/opponent pairs, and it moves work to the one place that's shared between all players |
| 7 | WASM evaluator | rejected — a real speedup, but a build step and a second implementation of the rules to keep in sync, for a cost that's no longer the bottleneck |
| 8 | Cache tables across hands | rejected — tables are per-hand by construction; nothing to reuse |

**The two that shipped**, measured on the same hand at 16,800 boards:

| | before | after |
|---|---|---|
| per board | 702 µs | **48 µs** (14.7× faster) |
| build 16,800 boards | 11,800 ms | **801 ms** |
| re-score one arrangement | 5,955 ms | **0.4 ms** |
| rank all 105 splits | ~24,000 ms | **40 ms** |
| arranging 7 cards (felt latency) | 15,300 ms | **1,175 ms** |
| deal a graded drill | 7,939 ms | **103 ms** |

Both are pure optimizations, and both are tested as such rather than trusted:
`tests/eval5i.test.js` checks the integer evaluator against the reference one over all
2,598,960 five-card hands, and `tests/precision_ui.test.js` checks the delta tables
reproduce the plain per-trial scorer **exactly** — EV, per-hand cells, SD and homerun counts,
on all 105 splits of several hands, worst absolute difference 0.

### How accurate is the EV number?

The panel tells you directly: alongside the average it prints the standard deviation of the
per-hand outcome and the **standard error of the estimate itself**, plus whether that has
reached the preset's target yet. Error falls with the square root of the board count, which
is exactly what the presets are budgeting against.

The absolute EV is the noisy part. What you usually want to know — *is this split better
than that one?* — is measured much more sharply, because every split you try is scored
against the **same** boards. That makes two splits a paired sample, so most of the board
luck cancels and what matters is the spread of their per-board difference. The Saved Splits
list uses exactly that: each split below the leader shows its gap and that gap's own
standard error (`#1 by 1.37 ± 0.28`), and when the gap doesn't clear two standard errors it
says **too close to call** instead, because at that point the boards you've run genuinely
cannot separate them. In practice the paired comparison is about twice as precise as
comparing the two averages independently.

A note on opponent diversity. The pre-solved pool has **15,000 hands**, of which roughly a
third qualify (don't share a card with yours) for any given practice hand — about **5,100
distinct opponents**. Past that, opponents necessarily repeat across boards (always with
fresh boards, never a duplicate card within a single trial), so Standard's ~16,000 boards
cycles each qualifying opponent about three times. Rather than sampling with replacement and
letting some opponents land five times while others land once, the trial builder reshuffles
the whole qualifying list and walks it, repeatedly — so every opponent is used an equal
number of times. At 14,000 boards that balanced cycling measures **44% tighter** than
independent sampling. It isn't claimed on screen: the reported standard error is the plain
`SD/√n`, which ignores the gain, so the real error is a little better than advertised rather
than worse.

Stuck, or just want to check your work? **Show Ideal Split** scores all 105 ways to split
your 7 cards and shows you the best one, with a "Load Ideal Split" button to drop it straight
into your slots. It no longer has a slider of its own, and no longer needs one: because every
split reads off the same delta tables the EV panel already built, ranking all 105 takes
**40–290ms** at any preset, against exactly the boards your own arrangement was scored on.
The panel says which board count that was, so the ideal split's EV and yours are never
silently compared across different-sized samples.

Under the hood this is an exhaustive search: all 105 partitions, every board, no shortcuts.
It used to be a successive-halving race (score everything for 200 boards, keep the top 10,
then the top 3) because a flat search was far too slow — which made it a heuristic that could
in principle eliminate a split that got unlucky early. The honest version is now cheaper than
the heuristic was.

Underneath "Load Ideal Split," a collapsed **"Show next 2 runner-up splits"** section (open it
to expand) reveals the 2nd- and 3rd-best partitions from that same search, each with its own
EV and a "Load This Split" button — useful for seeing whether the top split is a clear
standout or basically tied with a couple of close alternatives.

The opponent pool itself ships as `public/opponent-pool.json`, built by
`experiments/solve/build_opponent_pool_hr.js` from `round14600_hr.json` + `round5_hr.json`
(15,000 pre-solved hands total, all solved under homerun scoring). It's about 1.1MB of
repetitive card strings, so the server gzips it on the way out — roughly 195KB over the wire.

Homerun scoring is always included here too, the same as in live games — there's no toggle
for it. Every EV number on the practice screen already factors in the sweep bonus (sweep all
6 comparisons against this opponent, both boards, no ties, and the match total doubles 12→24),
and a "swept X/N boards" line shows how often a given split actually connects for it. **Show
Ideal Split** is homerun-aware too: the search itself optimizes for homerun-inclusive EV, not
just raw comparison points, since a split that sets up more sweeps can beat a higher-raw-EV
split once the bonus is in play.

The opponent itself is homerun-aware too, not just the scoring: `public/opponent-pool.json`
is solved by `experiments/solve/solve_round_hr.js` + `solve_fixed_hr.js` under the exact same
full-match-sweep homerun rule the live game uses, so the opponent you're practicing against
has actually adapted its splits to the sweep bonus, not just a standard-optimal opponent with
the bonus tacked onto the scoring. See "Strategy research" below for how that pool was solved.

### Every mode uses the same boards

Free play and all three drills run on the **same preset**, so they reach the same accuracy on
the same kind of opponents. That matters because the modes used to disagree: the drills ran
120 boards as a speed compromise, where the standard error on a single split is around ±0.6 —
so the same split could read 0.0 in one place and −0.5 in another purely from board luck,
with nothing wrong anywhere. Measured over 40 repeats of one fixed split, 120 boards produced
readings spanning 2.85 points; 500 boards cut that spread to 1.14 and 2,000 to 0.58. At
Standard's ±0.05 the question doesn't arise.

The compromise is gone because the scorer is no longer slow — see "What made ±0.05
affordable" above.

### Choosing which hands you get

Every pool entry carries the EV of the solver's own split for that hand, measured offline
over 300 boards (`experiments/solve/measure_pool_ev.js`). That turns "only deal me hands GTO
can't win with" into a lookup instead of something that would have to be solved for at deal
time, and it powers the **hand filter** at the top of the practice screen.

Pick a preset — a rough spot (bottom 20%), a losing hand (below 0), around average, a
premium hand (top 20%) — or set a custom range, e.g. max `-1.5` to drill only hands where
even perfect play is losing ground. The percentile cut points are computed from the pool
itself rather than hardcoded, so they stay honest if the pool is regenerated. The filter
applies to every mode, free play and drills alike, and the line beside it says how many hands
match; if a range matches too few to practise with, it falls back to the whole pool and says
so rather than silently failing to deal.

Two honest caveats. The number is the EV of the *stored* split, not a proof of the true
optimum — it's measured rather than re-solved, which is deliberate, because taking the best
of 105 noisy estimates biases the figure upward while measuring one fixed split does not. And
at 300 boards it carries a standard error around ±0.4, so hands sitting within roughly half a
point of your threshold are classified with some noise; the bulk of a filtered set is firmly
inside the range you asked for.

### The drills

The same screen holds four modes plus a shared Mistakes list. **Explore** is the free-play
mode described above — arrange, price it, hunt the ideal split, save and compare. The other
three are graded drills on the same decision, scored against the same opponents, and they
were previously a separate "Rapid Fire" menu entry. They're modes here because they are
genuinely the same activity: the same pool, the same scoring, the same hand filter.

### Arrange

You're dealt 7 cards and build the 1/2/4 split yourself — the same click-a-card-then-click-a-hand
interaction as Practice Mode, plus number keys to drop the next card into the first open
slot and Backspace to undo, which is what makes it fast. Submit and it's graded against
**all 105 ways to split that hand**, so you get a true rank (`#12 of 105`) rather than a
comparison against a handful of alternatives. The full 105-partition solve runs in the
background from the moment the hand is dealt, so by the time anyone has placed seven cards
the answer is already waiting.

### Estimate EV

You build a split exactly as in Arrange, then **price each hand separately**: what is the
1-card hand worth per hand played, what is the 2-card hand worth, what is the PLO hand
worth? This is the drill that builds a repeatable read, because it forces the question of
*where* a split's points actually come from rather than just whether it feels right.

The reveal grades each hand against its real EV and names your biggest miss, so you find out
you're systematically overrating your PLO hand or underrating a lone ace. One wrinkle is
made explicit rather than hidden: the homerun bonus can't be attributed to any single hand —
it only exists when all six comparisons sweep — so it's reported on its own line, and the
whole split's EV is your three hands *plus* that bonus. You're graded on how well the three
estimates price the hand as a whole, with the average per-hand error tracked separately,
since three estimates that are each wrong but cancel out is a different problem from being
wrong about the total. It also tracks **bias** — whether you're systematically optimistic or
pessimistic — which is usually more fixable than being noisy.

### Live EV assist

A **Show live EV** tick box prices each hand as you build it — the 1-card, 2-card and PLO
hands plus the homerun bonus and total — updating on every card you place. A hand shows a
dash until it's actually full, rather than a misleading partial number, and the homerun line
only appears once the whole split exists. It works in every drill: in Arrange and Estimate
it prices your split as you go, and in Locked NLH it prices all five completions up front.

It's a training wheel, so hands played with it on are deliberately **not scored** and don't
enter the mistakes list — the averages are only meaningful if they measure unaided
judgement. Turn it on to calibrate, off to test yourself. Switching it on mid-hand marks that
hand assisted, since you can't un-see the answer.

### Locked NLH

The 2-card NLH hand is fixed for you (the solver's own choice for that holding), and you pick
which of the five remaining cards plays alone, with the other four becoming the PLO hand. It
isolates the back-end decision: given a reasonable NLH hand, can you maximize what's left?
Five completions means it grades exhaustively and instantly.

### Grading

**Close counts.** Anything within 0.15 pts/hand of the best counts as correct. This used to
be a concession to noise — at 120 boards the standard error was around ±0.6, so demanding the
exact argmax would have been grading Monte Carlo noise rather than your decision. At
Standard's ±0.05 that's no longer the reason: 0.15 is now about three standard errors, so a
split inside the window is genuinely close and not merely indistinguishable. The threshold
stays because a 0.1-point concession is not a poker mistake worth flagging. Everything else
is graded by the EV it cost, chess-style:

| | Arrange / Locked NLH — EV lost | Estimate EV — total error |
|---|---|---|
| **Best** / **Sharp** (`!`) | ≤ 0.15 | ≤ 0.75 |
| **Inaccuracy** / **Close** (`?!`) | 0.15 – 0.75 | 0.75 – 2.0 |
| **Mistake** / **Off** (`?`) | 0.75 – 2.0 | 2.0 – 4.0 |
| **Blunder** / **Way off** (`??`) | > 2.0 | > 4.0 |

A correct answer chimes. In Arrange and Locked NLH it then deals the next hand by itself,
since there's nothing left to look at; a miss waits, so you can study the better split before
it disappears. **Estimate EV never auto-advances** — its reveal is the whole lesson, so every
hand waits for you to click Next (or press Enter) whether you nailed it or not. The header tracks a **running average EV loss per
hand** — the number worth watching, since it's the rate you'd actually bleed chips at — plus
how often you found the best, your streak, and a count of each tier. Stats are kept per drill,
since "average EV lost" and "average estimate error" aren't the same measurement.

### Mistakes tab

Misses from Arrange and Locked NLH collect in a **Mistakes tab**, each showing the hand with
what you played next to what was best. **Retry this hand** replays that exact hand and the
exact same boards, graded against the same solve, with your arrangement cleared so you have to
rebuild it rather than recognize a position. Retries deliberately do **not** move the session
average — otherwise you could grind it down by redrilling hands you've already memorized —
they just mark the mistake fixed. Estimate EV is intentionally not retryable: once you've been
told the answer, re-guessing the same hand tests memory, not calibration.

## Deploying so friends can join over the internet

Because there's nothing to `npm install`, deployment is about as simple as it gets. A few good free/cheap options:

### Option A: Render.com (free tier, easiest)

1. Push this project to a GitHub repo.
2. On [render.com](https://render.com), click **New > Web Service**, connect the repo.
3. Build command: leave blank (or `echo "no build needed"`).
4. Start command: `node server.js`.
5. Render sets `PORT` automatically — the server already reads `process.env.PORT`, so no config needed.
6. Deploy; you'll get a public URL like `https://your-app.onrender.com` to share.

(Free-tier Render services spin down after inactivity and take ~30s to wake back up on the next request — fine for a casual game, just give it a moment after sharing the link.)

### Option B: Fly.io / Railway

Both work the same way — point them at this repo, set the start command to `node server.js`, and they handle the rest. No Dockerfile is required for Railway; Fly.io can use its Node buildpack (`fly launch` will detect it automatically).

### Option C: Your own VPS

```bash
git clone <your-repo-url>
cd taiwanese-poker
PORT=3000 node server.js
# or keep it running with: nohup node server.js &   (or use pm2/systemd)
```

Put it behind nginx/Caddy for HTTPS and a real domain if you want, or just share `http://<server-ip>:3000` directly for casual use.

### Option D: Quick temporary link from your own laptop

If you just want to host a single game night without deploying anywhere:

```bash
node server.js
```

then use a tunneling tool like `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`) to get a temporary public URL to share with friends.

## Customizing the rules

- **Point values / category rules**: `lib/game.js` — `POINTS = { one: 1, two: 2, four: 3 }` and the `evaluatePlayer` function (which construction rule each hand type uses).
- **Hand ranking / ties**: `lib/poker.js` — `evaluate5` computes standard poker hand rankings; `compareScores` does lexicographic comparison. Exact ties currently push (see `computeResults` in `lib/game.js` — a `cmp === 0` from `compareScores` results in no point change).
- **Homerun bonus size / definition**: `computeResults` in `lib/game.js` — currently a clean sweep doubles the board (`STANDARD_BOARD_TOTAL` bonus); change the multiplier or the sweep condition there.
- **Scoop bonuses, different point values, suit-based tiebreaks, more players**: all straightforward to add in those two files; the rest of the app (server + client) just consumes whatever `computeResults` returns.

## Strategy research (experiments/solve/)

This folder has a set of standalone Node scripts (no dependencies beyond `lib/poker.js`) that try to answer "what's the optimal way to split your 7 cards?" via iterative best-response simulation — build a pool of hands, solve each hand's best split against a field playing randomly, then use that as the new field and resolve, repeating until it stabilizes. See the scripts' comments for details; `analyze.js` compares rounds for convergence. This isn't needed to run the game — it's the research behind the strategy notes in this README, the Practice Mode opponent (see below), and the chat that produced this project.

There are two parallel tracks here: a **standard-rules** solve (`solve_round.js`/`solve_fixed.js`, scored with `pointsFromEvals`) and a **homerun-rules** solve (`solve_round_hr.js`/`solve_fixed_hr.js`, scored with `pointsHomerun`) — since homerun scoring changes the best split for a meaningful chunk of hands (a split that sets up more clean sweeps can beat a higher-raw-EV split once the bonus is live), these aren't the same equilibrium and are kept as separate pipelines/files throughout. `public/opponent-pool.json` — the pool Practice Mode actually plays against — is built exclusively from the **homerun-rules** solve (`round5000_hr.json` + `round5_hr.json`, merged by `build_opponent_pool_hr.js`), since homerun scoring is always on in the live game now.

The homerun-rules pipeline went through one correction worth knowing about: `round1_hr_legacy_perboard.json` through `round3_hr_legacy_perboard.json` were solved under an earlier, incorrect per-board reading of the rule (doubling whichever single board you swept 3-for-3, rather than requiring a sweep of all 6 comparisons across both boards before doubling the whole 12-point match total). `common.js`'s `pointsHomerun` has since been fixed to match `lib/game.js`'s actual `computeResults` logic exactly, and `round1_hr.json` through `round5_hr.json` are a full 5-round re-solve under the corrected rule, on a dedicated **400-hand** pool (`pool400_hr.json`) at `M=60` trials/round — a bigger field than the standard track's 120-hand `pool.json`, so the round-5 population that the scale-up below best-responds to is better sampled. `analyze_hr.js` reports the same convergence metrics as `analyze.js` for this corrected run: mean EV per round settles out around 0.60–0.73 (rounds 3–5), broadly the same shape and magnitude as the standard solve's 0.52–0.63 — the homerun modifier doesn't make the game converge any less cleanly than standard scoring does, it just lands on a different (and, for a meaningful fraction of hands, different-looking) equilibrium split. From there, `round5000_hr.json` scales that converged round-5 field out to **5000** fresh example hands (via `solve_fixed_hr.js`, chunked into 200-hand pieces — see `chunk_hr_*.json`), drawn from a 10,000-hand focal pool (`pool10000_hr.json`) so the set can be extended further later without re-solving any of it. An earlier, smaller corrected-rule run — 120-hand pool with a 1000-hand scale-up — is kept alongside as the `*_pool120.json` files for comparison.

## Project structure

```
server.js               HTTP server: static file hosting + room/game API + SSE push
lib/poker.js             5-card hand evaluator, deck/shuffle, hand-construction rules
                         (UMD-wrapped — also served directly to the browser for Practice Mode).
                         evaluate5() is the readable reference; eval5i() is the integer-packed
                         hot path that Practice Mode and the bots actually run.
lib/game.js              Dealing, assignment validation, scoring across all players
lib/bot.js               GTO bot seats: solves its own 1/2/4 split each hand, chunked
public/index.html        App shell (landing / lobby / arranging / results / practice screens)
public/style.css         Styling
public/client.js         Client logic: fetch() for actions, EventSource for live updates,
                         plus Practice Mode's client-side EV engine
public/opponent-pool.json Pre-solved (hand, split) pairs powering every Practice mode
tests/poker.test.js      Dependency-free sanity tests (run with `node tests/poker.test.js`)
tests/bot.test.js        Dependency-free bot split-quality tests
tests/bots_api.test.js   Dependency-free bot-seat tests over real HTTP + SSE
tests/eval5i.test.js     Exhaustive proof that eval5i matches evaluate5 over all 2,598,960
                         five-card hands (dependency-free, ~20s)
tests/practice_ui.test.js    Practice drills end-to-end UI test (real Chromium via playwright)
tests/precision_ui.test.js   EV precision presets + delta-table equivalence (real Chromium)
tests/lobby_bots_ui.test.js  Lobby bot controls UI test (real Chromium via playwright)
```
