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
node tests/poker.test.js
```

## How the game works

1. One player creates a room (picks a max player count, 2–4) and gets a 4-character room code plus a shareable link.
2. Others join with that code from the landing page's "Join Room" tab.
3. Once at least 2 players have joined, the host clicks **Start Game** — everyone is privately dealt 7 cards.
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

## Practice Mode (solo, no room needed)

The landing page's **Practice** tab drops you straight into a single-player training screen — no room, no other players. You're dealt one random 7-card hand and try different ways to split it; each split is scored against a batch of independent board runouts — **100 to 10,000, adjustable with a logarithmic slider** on the practice screen (defaults to 150) — every one against an opponent hand pulled from a pool that was pre-solved offline via the iterative best-response bootstrap in `experiments/solve/` (see below) — a strong, empirically near-equilibrium opponent, not a random one. The slider is logarithmic rather than linear because 100–10,000 spans two orders of magnitude — a linear slider would waste almost all of its travel on the 1000+ end and make it nearly impossible to land on smaller values like 200. Changing the slider takes effect on your next **New Hand**, not retroactively, so a hand's comparisons always stay apples-to-apples.

Rearranging your cards and re-running is instant regardless of the board count: the same evaluator that scores live games (`lib/poker.js`) is served straight to the browser at `/lib/poker.js` and runs entirely client-side, so there's no server round-trip per attempt. Critically, every split you try during a session is scored against the exact same trial set — generated once when the hand is dealt — so the EV numbers are directly comparable to each other; the difference between two splits' EV isn't muddied by fresh Monte Carlo noise each time. Save a split to build up a leaderboard of your attempts on that hand, sorted by EV, with one-click reload to keep tweaking a promising one.

Alongside the average EV, the results panel also reports the **variance and standard deviation** of that split's outcome (how swingy it is trial to trial) and the **standard error of the EV estimate itself** — a rough sense of how far the displayed average might still be from the true long-run EV given only `n` boards. Pushing the slider up shrinks that standard error (it scales with 1/√n), which is the actual reason to reach for more boards than the 150 default: at 150 boards the estimate is fairly noisy, at 10,000 it's tight.

Note on board count and opponent diversity: the pre-solved opponent pool has ~5400 hands total, of which roughly a third qualify (don't share a card with yours) for any given practice hand — about 1800 distinct opponents, so the default 150 boards, and even the ideal-split search's default of 1000, draw a fresh opponent on every trial. Past ~1800 boards opponents start repeating across trials (always with fresh boards each time, never a duplicate card within a single trial). More boards still means less noise in the EV estimate; it just doesn't buy more opponent variety past that point.

Stuck, or just want to check your work? **Show Ideal Split** scores the 105 ways to split your 7 cards against your trial set and shows you the best one, with a "Load Ideal Split" button to drop it straight into your slots. It has its own separate **Ideal split search boards** slider — also logarithmic, 100–10,000 — independent from the EV panel's slider above it, since the search is much more expensive per board (up to 105 partitions vs. 1); defaults to 1,000 but you're free to push it higher for a slower, more precise search, or lower for a quicker (noisier) one. It's clamped down to however many boards this hand actually has (set by the EV slider at deal time), and the panel says so explicitly whenever that clamp kicks in, so the ideal split's EV and your own arrangement's EV aren't silently being compared across different-sized samples.

Under the hood, this isn't a flat exhaustive search anymore — it's a successive-halving/racing search: all 105 partitions get scored for the first 200 boards, only the top 10 continue on to 1,000 boards, and only the top 3 of those continue on to the rest of the requested count (everything is cumulative — a survivor's final score reflects every board from 0 onward, nothing is re-run). Eliminated partitions just stop accumulating once they're cut, on the reasoning that 200-1000 boards is already plenty to see when a split is clearly out of contention. That turns what used to be flat `boards × 105` work into roughly `200×105 + 800×10 + (rest)×3` — at 10,000 boards, about a 12x reduction in raw work (and a 6x-ish reduction in wall-clock time after browser overhead), which is what makes the higher end of the search slider actually usable instead of taking minutes. Checkpoints beyond your requested board count are simply skipped, so at 100-200 boards this is identical to the old flat search. Verified against a full exhaustive search on a 5,000-board case: the staged search picked the exact same #1, #2, and #3 partitions a brute-force scoring of all 105 would have. That said, it's a heuristic, not a hard guarantee — a partition could in principle get unlucky in its first 200 boards and fall out of contention before it had a chance to catch up, so on rare hands the reported "ideal" might not be the literal global optimum, just very likely to be.

Cost scales with however many boards the search slider asks for — a few seconds at 150, up to roughly half a minute at 1,000, up to around 30-40 seconds even at the full 10,000 (versus minutes with the old flat search) — so it runs in small batches with a live progress readout on the button instead of freezing the tab for the whole computation. Changing the search slider invalidates any cached answer for the current hand (asking again recomputes at the new count); leaving it alone means asking again is instant.

Underneath "Load Ideal Split," a collapsed **"Show next 2 runner-up splits"** section (open it to expand) reveals the 2nd- and 3rd-best partitions from that same search, each with its own EV and a "Load This Split" button — useful for seeing whether the top split is a clear standout or basically tied with a couple of close alternatives.

The opponent pool itself ships as `public/opponent-pool.json`, built by `experiments/solve/build_opponent_pool_hr.js` from `round5000_hr.json` + `round5_hr.json` (5400 pre-solved hands total, all solved under homerun scoring).

Homerun scoring is always included here too, the same as in live games — there's no toggle for it. Every EV number on the practice screen already factors in the sweep bonus (sweep all 6 comparisons against this opponent, both boards, no ties, and the match total doubles 12→24), and a "swept X/N boards" line shows how often a given split actually connects for it. **Show Ideal Split** is homerun-aware too: the search itself optimizes for homerun-inclusive EV, not just raw comparison points, since a split that sets up more sweeps can beat a higher-raw-EV split once the bonus is in play.

The opponent itself is homerun-aware too, not just the scoring: `public/opponent-pool.json` is solved by `experiments/solve/solve_round_hr.js` + `solve_fixed_hr.js` under the exact same full-match-sweep homerun rule the live game uses, so the opponent you're practicing against has actually adapted its splits to the sweep bonus, not just a standard-optimal opponent with the bonus tacked onto the scoring. See "Strategy research" below for how that pool was solved.

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
                         (UMD-wrapped — also served directly to the browser for Practice Mode)
lib/game.js              Dealing, assignment validation, scoring across all players
public/index.html        App shell (landing / lobby / arranging / results / practice screens)
public/style.css         Styling
public/client.js         Client logic: fetch() for actions, EventSource for live updates,
                         plus Practice Mode's client-side EV engine
public/opponent-pool.json Pre-solved (hand, split) pairs powering Practice Mode's opponent
tests/poker.test.js      Dependency-free sanity tests (run with `node tests/poker.test.js`)
```
