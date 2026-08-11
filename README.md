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

### Optional: Homerun scoring

When creating a room, the host can check **Homerun scoring**. With it on: if you beat a given opponent in **all 6 comparisons** against them — all 3 hand categories, on **both** boards, with no ties anywhere — the entire match total against that opponent doubles: 12 points becomes 24 (or −24 if they sweep you instead). Sweeping just one board isn't enough on its own; anything short of the full 6-for-6 sweep scores normally, with no bonus. The results screen shows a banner and a badge on any player who hits one.

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
4. Each player clicks a card to select it, then clicks the 1-card / 2-card / 4-card hand box to place it there (click a placed card to send it back). **Lock Hand** becomes available once all 7 cards are assigned.
5. Once everyone has locked, both boards are revealed automatically along with every comparison, points for the hand, and a running scoreboard.
6. The host clicks **Deal Next Hand** to continue; cumulative scores persist for the room's session.

Rooms and scores live in server memory only — restarting the server clears everything. That's fine for a casual game night; see below if you want persistence.

Cards render with a **4-color deck** (♠ black, ♥ red, ♦ blue, ♣ green) so all four suits are easy to tell apart at a glance — colors are defined in `public/style.css` (`--suit-spade`/`--suit-heart`/`--suit-diamond`/`--suit-club`) if you'd rather use the traditional red/black 2-color scheme.

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

This folder has a set of standalone Node scripts (no dependencies beyond `lib/poker.js`) that try to answer "what's the optimal way to split your 7 cards?" via iterative best-response simulation — build a pool of hands, solve each hand's best split against a field playing randomly, then use that as the new field and resolve, repeating until it stabilizes. See the scripts' comments for details; `analyze.js` compares rounds for convergence. This isn't needed to run the game — it's the research behind the strategy notes in this README and the chat that produced this project.

## Project structure

```
server.js            HTTP server: static file hosting + room/game API + SSE push
lib/poker.js          5-card hand evaluator, deck/shuffle, hand-construction rules
lib/game.js            Dealing, assignment validation, scoring across all players
public/index.html      App shell (landing / lobby / arranging / results screens)
public/style.css       Styling
public/client.js       Client logic: fetch() for actions, EventSource for live updates
tests/poker.test.js    Dependency-free sanity tests (run with `node tests/poker.test.js`)
```
