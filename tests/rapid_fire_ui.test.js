// End-to-end UI test for Rapid Fire's three drills, driven through real Chromium against
// the real server. Run with: node tests/rapid_fire_ui.test.js
//
// Unlike tests/poker.test.js this one is NOT dependency-free: it needs `playwright` with a
// Chromium available (it skips itself cleanly if that's missing). It starts its own server
// on PORT_TEST and shuts it down afterwards.
//
// It exists because the grading, tier classification, stats and mistake-retry flow all live
// in the browser, where the dependency-free node tests can't reach them -- and because
// reusing the .tab-btn class for Rapid Fire's in-screen tabs silently broke the landing
// page's tab handler once, which only a real DOM catches.
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PORT_TEST || 3992);
const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}
const sig = (t) => t.replace(/\s+/g, ' ').trim();

const TIER_SELECTOR = '#rapidFeedback.tier-best, #rapidFeedback.tier-inaccuracy, #rapidFeedback.tier-mistake, #rapidFeedback.tier-blunder';
async function gradedTier(page) {
  const cls = await page.locator('#rapidFeedback').getAttribute('class');
  const m = /tier-(\w+)/.exec(cls || '');
  return m ? m[1] : null;
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up at ' + url);
}

// Fill the three slots from the tray by pressing the number key on each remaining card.
async function arrangeAllByKeyboard(page) {
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('1');
    await page.waitForTimeout(30);
  }
}

(async () => {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.log('SKIP: playwright not installed — skipping Rapid Fire UI test'); process.exit(0); }

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
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.error('  [browser error]', m.text()); } });
    page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.error('  [browser pageerror]', e.message, e.stack ? '\n' + e.stack.split('\n').slice(0,3).join('\n') : ''); });

    await page.goto(`http://localhost:${PORT}/`);
    await page.click('.tab-btn[data-tab="rapid"]');
    await page.click('#btnRapidStart');

    // ---- arrange mode ----
    await page.waitForSelector('#rapidArrange:not(.hidden)', { timeout: 60000 });
    await page.waitForSelector('#rTray .playing-card', { timeout: 60000 });
    assert(await page.locator('#rTray .playing-card').count() === 7, 'arrange deals 7 cards into the tray');
    assert(await page.locator('#btnRapidSubmit').isDisabled(), 'submit is disabled until all 7 cards are placed');

    // place one card into the 1-card slot by clicking, then the rest by keyboard
    await page.locator('#rTray .playing-card').first().click();
    await page.locator('#rapidSlots .slot[data-rslot="one"]').click();
    assert(await page.locator('#rSlotOne .playing-card').count() === 1, 'click-card-then-click-slot places a card');
    await page.keyboard.press('Backspace');
    assert(await page.locator('#rSlotOne .playing-card').count() === 0, 'Backspace undoes the last placement');

    await arrangeAllByKeyboard(page);
    const placed = await page.locator('#rapidSlots .playing-card').count();
    assert(placed === 7, 'number keys fill every slot (placed ' + placed + ')');
    assert(await page.locator('#rSlotOne .playing-card').count() === 1
      && await page.locator('#rSlotTwo .playing-card').count() === 2
      && await page.locator('#rSlotFour .playing-card').count() === 4, 'slots fill to the 1/2/4 shape');
    assert(!(await page.locator('#btnRapidSubmit').isDisabled()), 'submit unlocks once the split is complete');

    await page.keyboard.press('Enter');
    await page.waitForSelector(TIER_SELECTOR, { timeout: 90000 });
    const aFb = sig(await page.locator('#rapidFeedback').innerText());
    assert(/ranked #\d+ of 105/.test(aFb), 'arrange grades against all 105 partitions (' + aFb.slice(0, 80) + ')');
    const firstTier = await gradedTier(page);
    assert(['best', 'inaccuracy', 'mistake', 'blunder'].includes(firstTier), 'arrange reports a tier (' + firstTier + ')');
    const arrangeWasBest = firstTier === 'best';

    // play a few more hands to accumulate stats and (very likely) a mistake
    let misses = arrangeWasBest ? 0 : 1;
    if (arrangeWasBest) await page.waitForTimeout(1300); else await page.click('#btnRapidNext');
    for (let i = 0; i < 4; i++) {
      await page.waitForSelector('#rTray .playing-card', { timeout: 90000 });
      await arrangeAllByKeyboard(page);
      await page.keyboard.press('Enter');
      await page.waitForSelector(TIER_SELECTOR, { timeout: 90000 });
      const best = (await gradedTier(page)) === 'best';
      if (!best) misses++;
      if (best) await page.waitForTimeout(1300); else await page.click('#btnRapidNext');
    }
    const statsTxt = sig(await page.locator('#rapidStats').innerText()).toUpperCase();
    assert(/HANDS 5/.test(statsTxt), 'arrange stats counted all 5 hands');
    assert(/AVG EV LOST \/ HAND/.test(statsTxt), 'arrange shows a running average EV loss');
    const avgArrange = (await page.locator('.rapid-stat.headline .rs-value').innerText()).trim();
    assert(/^\d+\.\d{3}$/.test(avgArrange), 'average EV loss is numeric (' + avgArrange + ')');

    // ---- mistakes tab + retry (arrange) ----
    if (misses > 0) {
      await page.click('.tab-btn[data-rapid-tab="mistakes"]');
      await page.waitForSelector('.rapid-mistake');
      assert(await page.locator('.rapid-mistake').count() === misses, 'every arrange miss is listed in Mistakes');
      const first = page.locator('.rapid-mistake').first();
      assert(/Arrange|Locked NLH/.test(sig(await first.locator('.rm-mode').innerText())), 'mistake entry records which drill it came from');
      await first.locator('button', { hasText: 'Retry' }).click();
      await page.waitForSelector('#rapidRetryBanner:not(.hidden)');
      assert(await page.locator('#rapidSlots .playing-card').count() === 0, 'retry clears the arrangement so it has to be rebuilt');
      await page.waitForSelector('#rTray .playing-card');
      await arrangeAllByKeyboard(page);
      await page.keyboard.press('Enter');
      await page.waitForSelector(TIER_SELECTOR, { timeout: 90000 });
      await page.click('#btnRapidNext');
      await page.waitForSelector('.rapid-mistake');
      const avgAfter = (await page.locator('.rapid-stat.headline .rs-value').innerText()).trim();
      assert(avgAfter === avgArrange, 'a retry does not move the session average (' + avgArrange + ')');
      await page.click('.tab-btn[data-rapid-tab="drill"]');
    } else {
      console.log('note: no arrange misses this run, mistake-tab assertions skipped');
    }

    // ---- estimate mode: arrange it yourself, then price each hand ----
    await page.click('.rapid-mode-btn[data-rapid-mode="estimate"]');
    await page.waitForSelector('#rapidEstimate:not(.hidden)', { timeout: 60000 });
    await page.waitForSelector('#rTray .playing-card', { timeout: 60000 });
    assert(await page.locator('#rapidArrange:not(.hidden)').count() === 1, 'estimate mode lets you arrange the hand yourself');
    assert(await page.locator('#rapidEstGate:not(.hidden)').count() === 1, 'estimate inputs are gated until the split is built');
    assert(await page.locator('#rapidEstOne').isDisabled(), 'per-hand inputs are disabled before the split is complete');

    await arrangeAllByKeyboard(page);
    await page.waitForSelector('#rapidEstFields:not(.hidden)', { timeout: 15000 });
    assert(!(await page.locator('#rapidEstOne').isDisabled()), 'per-hand inputs unlock once all 7 cards are placed');
    for (const id of ['rapidEstOne', 'rapidEstTwo', 'rapidEstFour']) {
      assert(await page.locator('#' + id).count() === 1, 'there is an estimate input for ' + id.replace('rapidEst', ''));
    }
    await page.fill('#rapidEstOne', '-0.5');
    await page.fill('#rapidEstTwo', '-1.0');
    assert(/2\/3 priced/.test(await page.locator('#rapidEstTotal').innerText()), 'running total reports how many hands are priced so far');
    await page.fill('#rapidEstFour', '1.5');
    assert(/^[+-]?0\.00$/.test((await page.locator('#rapidEstTotal').innerText()).trim()), 'running total sums the three estimates (' + (await page.locator('#rapidEstTotal').innerText()) + ')');

    await page.keyboard.press('Enter');
    await page.waitForSelector('#rapidEstReveal:not(.hidden)', { timeout: 60000 });
    const estReveal = sig(await page.locator('#rapidEstReveal').innerText());
    assert(/1-Card Hand/.test(estReveal) && /2-Card Hand/.test(estReveal) && /4-Card PLO Hand/.test(estReveal), 'reveal grades all three hands separately');
    assert(/you said -0\.50/.test(estReveal), 'reveal echoes each per-hand estimate');
    assert(/Homerun bonus/.test(estReveal), 'reveal breaks the homerun bonus out separately from the three hands');
    assert(/Whole split is worth/.test(estReveal), 'reveal reports the whole split\'s EV');
    const estStats = sig(await page.locator('#rapidStats').innerText()).toUpperCase();
    assert(/AVG TOTAL EV ERROR/.test(estStats), 'estimate mode tracks average total EV error');
    assert(/PER-HAND ERR/.test(estStats), 'estimate mode tracks average per-hand error');
    assert(/BIAS/.test(estStats), 'estimate mode reports calibration bias');

    // ---- live EV assist ----
    await page.click('#btnRapidNext');
    await page.waitForSelector('#rTray .playing-card', { timeout: 60000 });
    assert(await page.locator('#rapidLiveEv.hidden').count() === 1, 'live EV panel is off by default');
    await page.check('#rapidAssist');
    await page.waitForSelector('#rapidLiveEv:not(.hidden)', { timeout: 15000 });
    const emptyLive = sig(await page.locator('#rapidLiveEv').innerText());
    assert(/1-card/.test(emptyLive) && /4-card PLO/.test(emptyLive) && /Total/.test(emptyLive),
      'live EV panel prices each hand plus the total');
    assert((emptyLive.match(/—/g) || []).length >= 4, 'unpriced hands show a dash rather than a misleading number');
    await page.keyboard.press('1');
    await page.waitForTimeout(150);
    assert(/1-card [+-]\d/.test(sig(await page.locator('#rapidLiveEv').innerText())), 'a hand prices itself as soon as it is full');
    await arrangeAllByKeyboard(page);
    await page.waitForTimeout(250);
    const fullLive = sig(await page.locator('#rapidLiveEv').innerText());
    assert(/Homerun [+-]?\d/.test(fullLive), 'the homerun bonus appears once the whole split exists');
    assert(/not scored/.test(fullLive), 'the panel says assisted hands are not scored');
    const beforeAssisted = sig(await page.locator('#rapidStats').innerText());
    await page.fill('#rapidEstOne', '0');
    await page.fill('#rapidEstTwo', '0');
    await page.fill('#rapidEstFour', '0');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#rapidEstReveal:not(.hidden)', { timeout: 60000 });
    assert(/assisted, not scored/.test(sig(await page.locator('#rapidFeedback').innerText())), 'an assisted hand is flagged in the feedback');
    assert(sig(await page.locator('#rapidStats').innerText()) === beforeAssisted, 'an assisted hand does not move the session stats');
    // ---- a sharp estimate must NOT auto-advance: the reveal is the lesson ----
    // Copying the live-EV numbers exactly is a deterministic way to force a "Sharp" grade,
    // which is the case that used to get yanked off screen after 1.6s.
    await page.click('#btnRapidNext');
    await page.waitForSelector('#rTray .playing-card', { timeout: 60000 });
    await arrangeAllByKeyboard(page);
    await page.waitForTimeout(400);
    const live = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('#rapidLiveEv .rle-item').forEach((it) => {
        out[it.querySelector('.rle-label').textContent.trim()] = it.querySelector('.rle-val').textContent.trim();
      });
      return out;
    });
    await page.fill('#rapidEstOne', live['1-card'].replace('+', ''));
    await page.fill('#rapidEstTwo', live['2-card'].replace('+', ''));
    await page.fill('#rapidEstFour', live['4-card PLO'].replace('+', ''));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#rapidEstReveal:not(.hidden)', { timeout: 60000 });
    assert((await gradedTier(page)) === 'best', 'copying the live EVs exactly grades as a sharp estimate');
    await page.waitForTimeout(2600); // well past the 1.6s this mode used to auto-advance on
    assert(await page.locator('#rapidEstReveal:not(.hidden)').count() === 1,
      'a sharp estimate keeps its reveal on screen instead of auto-advancing');
    assert(await page.locator('#btnRapidNext').isVisible(),
      'you advance from an estimate yourself, once you have finished reading it');

    await page.uncheck('#rapidAssist');

    // ---- locked NLH mode ----
    await page.click('#btnRapidNext');
    await page.click('.rapid-mode-btn[data-rapid-mode="locked"]');
    await page.waitForSelector('#rapidLocked:not(.hidden)', { timeout: 60000 });
    await page.waitForSelector('.rapid-locked-choice', { timeout: 60000 });
    assert(await page.locator('#rapidLockedTwo .playing-card').count() === 2, 'locked mode shows the fixed 2-card NLH hand');
    assert(await page.locator('.rapid-locked-choice').count() === 5, 'locked mode offers the 5 ways to finish the hand');
    const firstChoice = page.locator('.rapid-locked-choice').first();
    assert(await firstChoice.locator('.rlc-part').count() === 2, 'each completion shows its 1-card and PLO hands');
    await page.keyboard.press('1');
    await page.waitForSelector(TIER_SELECTOR, { timeout: 90000 });
    const lFb = sig(await page.locator('#rapidFeedback').innerText());
    assert(/of 5 completions/.test(lFb), 'locked mode ranks the choice among the 5 completions (' + lFb.slice(0, 70) + ')');
    assert(await page.locator('.rapid-locked-choice .rapid-opt-ev').count() === 5, 'answering reveals every completion\'s EV');
    assert(await page.locator('.rapid-locked-choice.is-best').count() === 1, 'exactly one completion is flagged best');

    assert(errors.length === 0, 'no console/page errors during the drills' + (errors.length ? ' — ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    cleanup();
  }

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
