// End-to-end UI test for Rapid Fire, driven through real Chromium against the real server.
// Run with: node tests/rapid_fire_ui.test.js
//
// Unlike tests/poker.test.js this one is NOT dependency-free: it needs `playwright` with a
// Chromium available (the environment this was developed in ships both). It starts its own
// server on PORT_TEST and shuts it down afterwards, so nothing needs to be running first.
// It exists because the quiz's grading, tier classification, stats and mistake-retry flow
// all live in the browser, where the dependency-free node tests can't reach them -- and
// because reusing the .tab-btn class for Rapid Fire's in-screen tabs silently broke the
// landing page's tab handler the first time, which only a real DOM catches.
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PORT_TEST || 3992);
const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}
const sig = (t) => t.replace(/\s+/g, ' ').trim();

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up at ' + url);
}

(async () => {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.log('SKIP: playwright not installed — skipping Rapid Fire UI test');
    process.exit(0);
  }

  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  const cleanup = () => { try { server.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  const browser = await playwright.chromium.launch();
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    await page.goto(`http://localhost:${PORT}/`);
    await page.click('.tab-btn[data-tab="rapid"]');
    await page.click('#btnRapidStart');
    await page.waitForSelector('#rapidOptions .rapid-option', { timeout: 60000 });

    assert(await page.locator('#rapidOptions .rapid-option').count() === 5, 'quiz shows 5 candidate splits');
    assert(await page.locator('#rapidHandRow .playing-card').count() === 7, 'quiz shows the full 7-card hand');
    assert(await page.locator('#rapidOptions .rapid-opt-ev').count() === 0, "option EVs stay hidden until you've answered");

    // Play a batch of hands, always answering option 1 by keyboard (rapid-fire input path).
    let best = 0, misses = 0;
    const HANDS = 8;
    for (let i = 0; i < HANDS; i++) {
      await page.waitForSelector('#rapidOptions .rapid-option:not([disabled])', { timeout: 60000 });
      await page.keyboard.press('1');
      await page.waitForSelector('#rapidFeedback:not(.hidden)', { timeout: 30000 });
      const wasBest = /Best split/.test(sig(await page.locator('#rapidFeedback').innerText()));
      if (wasBest) best++; else misses++;
      if (i === 0) {
        assert(await page.locator('#rapidOptions .rapid-opt-ev').count() === 5, 'answering reveals every option\'s EV');
        assert(await page.locator('#rapidOptions .rapid-option.is-best').count() === 1, 'exactly one option is flagged best');
      }
      if (wasBest) await page.waitForTimeout(1300); // correct answers auto-advance
      else await page.click('#btnRapidNext');
    }

    const handsShown = sig(await page.locator('#rapidStats').innerText());
    assert(new RegExp('HANDS ' + HANDS).test(handsShown.toUpperCase()), `stats counted all ${HANDS} hands`);
    const avg = (await page.locator('.rapid-stat.headline .rs-value').innerText()).trim();
    assert(/^\d+\.\d{3}$/.test(avg), 'running average EV loss renders as a number (' + avg + ')');
    assert(best + misses === HANDS, 'every hand was graded as best or a miss');
    assert(Number(await page.locator('#rapidMistakeCount').innerText()) === misses, 'mistake tab badge matches the miss count');

    if (misses > 0) {
      await page.click('.tab-btn[data-rapid-tab="mistakes"]');
      await page.waitForSelector('.rapid-mistake');
      assert(await page.locator('.rapid-mistake').count() === misses, 'every miss is listed in the Mistakes tab');

      const first = page.locator('.rapid-mistake').first();
      const bestSplitSig = sig(await first.locator('.rm-line.good .rapid-opt-cards').innerText());
      assert(bestSplitSig.length > 0, 'mistake entry shows what the best split was');

      await first.locator('button', { hasText: 'Retry' }).click();
      await page.waitForSelector('#rapidRetryBanner:not(.hidden)');
      const opts = page.locator('#rapidOptions .rapid-option');
      const n = await opts.count();
      let target = -1;
      for (let i = 0; i < n; i++) {
        if (sig(await opts.nth(i).locator('.rapid-opt-cards').innerText()) === bestSplitSig) { target = i; break; }
      }
      assert(target >= 0, 'the retry offers the same options as the original hand');
      await opts.nth(target).click();
      await page.waitForSelector('#rapidFeedback:not(.hidden)');
      assert(/Fixed/.test(sig(await page.locator('#rapidFeedback').innerText())), 'picking the best split on a retry reports it fixed');

      await page.click('#btnRapidNext');
      await page.waitForSelector('.rapid-mistake');
      const avgAfter = (await page.locator('.rapid-stat.headline .rs-value').innerText()).trim();
      assert(avgAfter === avg, 'a retry does not move the session average (' + avg + ')');
      assert(await page.locator('.rapid-mistake.resolved').count() >= 1, 'the drilled mistake is marked resolved');
    } else {
      console.log('note: no misses this run, mistake-tab assertions skipped');
    }

    assert(errors.length === 0, 'no console/page errors during the drill' + (errors.length ? ' — ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    cleanup();
  }

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
