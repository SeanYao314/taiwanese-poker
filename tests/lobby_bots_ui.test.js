// UI test for the bot controls on the create form and in the lobby, in real Chromium.
// Run with: node tests/lobby_bots_ui.test.js
//
// Needs `playwright` (skips itself cleanly otherwise) and starts its own server.
// The rename field is the fiddly part worth covering: the lobby rebuilds itself on every
// room_state broadcast, so an unguarded render would yank the host's half-typed name away.
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PORT_TEST || 4001);
const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}
const sig = (t) => t.replace(/\s+/g, ' ').trim();

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}

(async () => {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.log('SKIP: playwright not installed'); process.exit(0); }

  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  const cleanup = () => { try { server.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  const browser = await playwright.chromium.launch();
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`http://localhost:${PORT}/`);
    assert(await page.locator('#createBots').count() === 1, 'the create form offers GTO bots');

    await page.fill('#createName', 'Sean');
    await page.selectOption('#createMax', '4');
    await page.selectOption('#createBots', '2');
    await page.click('#btnCreate');
    await page.waitForSelector('#screen-lobby:not(.hidden)', { timeout: 20000 });
    await page.waitForSelector('.player-list li');

    assert(await page.locator('.player-list li').count() === 3, 'the lobby seats the host plus the requested bots');
    assert(await page.locator('.player-list li.is-bot').count() === 2, 'bot seats are marked as bots');
    assert(await page.locator('.bot-tag').count() === 2, 'each bot shows a GTO BOT tag');
    assert(sig(await page.locator('#lobbyCount').innerText()) === '3', 'the player count includes bots');

    // --- rename ---
    const first = page.locator('.bot-name-input').first();
    assert(await page.locator('.bot-name-input').count() === 2, 'the host gets an editable name field per bot');
    await first.click();
    await first.fill('Deep Stack');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert((await page.locator('.bot-name-input').first().inputValue()) === 'Deep Stack', 'a renamed bot keeps its new name');

    // a broadcast landing mid-edit must not clobber what the host is typing
    const second = page.locator('.bot-name-input').nth(1);
    await second.click();
    await second.fill('Half Typed');
    await page.evaluate(() => {
      // force a re-render the way an unrelated room_state broadcast would
      document.getElementById('btnAddBot').click();
    });
    await page.waitForTimeout(500);
    assert((await page.locator('.bot-name-input').nth(1).inputValue()) === 'Half Typed',
      'a lobby re-render does not wipe a half-typed bot name');
    assert(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('bot-name-input')),
      'focus stays in the name field across a re-render');

    // --- add / full / remove ---
    await page.waitForTimeout(300);
    assert(await page.locator('.player-list li').count() === 4, 'the host can add another bot from the lobby');
    assert(await page.locator('#btnAddBot').isDisabled(), 'the add button disables when the table is full');
    assert(/Table full/.test(sig(await page.locator('#btnAddBot').innerText())), 'the add button says why it is disabled');

    await page.locator('.bot-remove').first().click();
    await page.waitForTimeout(400);
    assert(await page.locator('.player-list li').count() === 3, 'the host can remove a bot');
    assert(!(await page.locator('#btnAddBot').isDisabled()), 'the add button re-enables once a seat frees up');

    // --- a solo host can start against bots alone ---
    assert(await page.locator('#btnStart').isVisible(), 'the host can start the game with only bots to play against');
    await page.click('#btnStart');
    await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 20000 });
    await page.waitForSelector('#tray .playing-card', { timeout: 20000 });
    assert(await page.locator('#tray .playing-card').count() === 7, 'the host is dealt a hand against the bots');

    // bots solve and lock themselves; the lock counter must move without anyone else acting
    await page.waitForFunction(() => {
      const t = document.getElementById('lockStatus').textContent || '';
      const m = /^(\d+)\//.exec(t.trim());
      return m && Number(m[1]) >= 2;
    }, null, { timeout: 30000 });
    assert(true, 'bots lock their own hands with no human action');

    for (let i = 0; i < 7; i++) {
      await page.locator('#tray .playing-card').first().click({ modifiers: ['Control'] });
    }
    await page.click('#btnLock');
    await page.waitForSelector('#screen-results:not(.hidden)', { timeout: 30000 });
    await page.waitForSelector('#scoreboard tr', { timeout: 40000 });
    // "Deep Stack" was the bot removed above, so the surviving custom name is "Half Typed"
    const board = sig(await page.locator('#scoreboard').innerText());
    assert(/Half Typed/.test(board), 'a renamed bot carries its name onto the scoreboard (' + board.slice(0, 70) + ')');
    assert(!/Deep Stack/.test(board), 'a removed bot does not play or appear in the results');

    assert(errors.length === 0, 'no page errors' + (errors.length ? ' — ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    cleanup();
  }

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
