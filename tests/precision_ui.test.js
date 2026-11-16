// End-to-end test for the EV precision presets (Standard / Deep / Max) and the delta-table
// engine behind them. Run with: node tests/precision_ui.test.js
//
// Two things here are worth guarding:
//
//  1. The presets are a PROMISE about accuracy, not a board count. "Standard" means every
//     hand's EV is measured to a standard error of ±0.05 points, whatever that costs on
//     this particular hand. So the test checks the reported standard error against the
//     preset's target rather than checking a fixed number of boards.
//  2. The delta tables are an optimization. evalFromTables() must agree with the plain
//     per-trial scorer (evalAssignmentAcrossTrials) to the last bit on all 105 splits,
//     otherwise the speedup is just a different, wrong answer arriving sooner.
//
// Needs `playwright` with Chromium; skips itself cleanly if that's missing.
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PORT_TEST || 3994);
const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}
const sig = (t) => t.replace(/\s+/g, ' ').trim();

async function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch (e) { /* not up yet */ }
    if (Date.now() - started > timeoutMs) throw new Error('server did not start: ' + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Fill all seven cards into the first open slot each time (the ⌘/Ctrl+click shortcut).
async function arrangeAll(page, traySelector) {
  for (let i = 0; i < 7; i++) {
    await page.click(`${traySelector} .playing-card`, { modifiers: ['Control'] });
  }
}

(async () => {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.log('SKIP: playwright not installed'); process.exit(0); }

  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  process.on('exit', () => { try { server.kill(); } catch (_) {} });

  const browser = await playwright.chromium.launch();
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await page.goto(`http://localhost:${PORT}/`);
    await page.click('.tab-btn[data-tab="practice"]');

    // --- the control itself ---
    const btnText = await page.$$eval('#precisionRow .precision-btn',
      (bs) => bs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
    assert(btnText.length === 3, 'there are exactly three precision presets');
    assert(/Standard/.test(btnText[0]) && /±0\.05/.test(btnText[0]), 'Standard is labelled with its ±0.05 target');
    assert(/Deep/.test(btnText[1]) && /±0\.03/.test(btnText[1]), 'Deep is labelled with its ±0.03 target');
    assert(/Max/.test(btnText[2]) && /±0\.02/.test(btnText[2]), 'Max is labelled with its ±0.02 target');
    assert(await page.locator('#precisionRow input[type="range"]').count() === 0,
      'the old boards-per-split and ideal-search sliders are gone');
    assert(await page.locator('.precision-btn.active').count() === 1, 'exactly one preset is active');
    assert(await page.$eval('#precisionRow .precision-btn.active', (b) => b.dataset.precision) === 'standard',
      'Standard is the default');

    await page.click('#btnPracticeStart');
    await page.waitForSelector('#pTray .playing-card');

    // --- Standard actually hits ±0.05 ---
    const targets = { standard: 0.05, deep: 0.03, max: 0.02 };
    for (const preset of ['standard', 'deep', 'max']) {
      await page.click(`#precisionRow [data-precision="${preset}"]`);
      await page.waitForSelector('#pTray .playing-card');
      await arrangeAll(page, '#pTray');
      await page.waitForSelector('#practiceEvPanel:not(.hidden)', { timeout: 30000 });

      // a reading appears before the full board budget is spent, and says so with a "+"
      const firstReading = sig(await page.textContent('#practiceTrialCount'));
      assert(/\d/.test(firstReading), `${preset}: an EV reading is on screen as soon as the split is complete`);

      // then it tightens until the target is met
      let line = '';
      for (let i = 0; i < 200; i++) {
        await page.waitForTimeout(250);
        if (!(await page.textContent('#practiceTrialCount')).includes('+')) break;
      }
      line = sig(await page.textContent('#practiceVarianceLine'));
      const se = Number(/accurate to ±([\d.]+)/.exec(line)[1]);
      const boards = Number(sig(await page.textContent('#practiceTrialCount')).replace(/[^\d]/g, ''));
      assert(se <= targets[preset] + 1e-9,
        `${preset}: the finished estimate is accurate to ±${se} — at or inside its ±${targets[preset]} target`);
      assert(boards > 1000, `${preset}: reaching that target took a real board budget (${boards.toLocaleString()})`);
      assert(line.includes(`target of ±${targets[preset].toFixed(2)}`),
        `${preset}: the panel names the target it is holding itself to`);

      // the ideal-split search reads straight off the finished tables, so it is ~instant
      const t0 = Date.now();
      await page.click('#btnPracticeIdeal');
      await page.waitForSelector('#practiceIdealPanel:not(.hidden)', { timeout: 20000 });
      const idealMs = Date.now() - t0;
      assert(idealMs < 3000, `${preset}: all 105 splits ranked in ${idealMs}ms off the same tables`);
      assert(sig(await page.textContent('#practiceIdealPanel')).includes(boards.toLocaleString()),
        `${preset}: the ideal split is checked against the same boards as the EV panel, not a separate sample`);

      if (preset !== 'max') await page.click('#btnPracticeNewHand');
    }

    // --- the choice sticks ---
    await page.reload();
    await page.click('.tab-btn[data-tab="practice"]');
    assert(await page.$eval('#precisionRow .precision-btn.active', (b) => b.dataset.precision) === 'max',
      'the chosen preset survives a reload');

    // --- the tables agree with the plain scorer, exactly, on all 105 splits ---
    await page.click('#btnPracticeStart');
    await page.waitForSelector('#pTray .playing-card');
    await page.click('#precisionRow [data-precision="standard"]');
    const equiv = await page.evaluate(async () => {
      const I = window.__practiceInternals;
      const entries = await (await fetch('/opponent-pool.json')).json();
      const out = [];
      for (const idx of [7, 1234, 9000]) {
        const seed = entries[idx];
        const hand = [...seed.one, ...seed.two, ...seed.four];
        const trials = I.buildPracticeTrials(hand, entries, 400);
        const tables = I.newTables(hand, 400, seed);
        for (const t of trials) I.addTrialToTables(tables, t);
        let worst = 0;
        let n = 0;
        for (const part of I.allPartitions(hand)) {
          const ref = I.evalAssignmentAcrossTrials(part, trials, true);
          const fast = I.evalFromTables(tables, part);
          worst = Math.max(worst,
            Math.abs(ref.avgTotal - fast.avgTotal),
            Math.abs(ref.sdTotal - fast.sdTotal),
            Math.abs(ref.homerunWins - fast.homerunWins),
            Math.abs(ref.homerunLosses - fast.homerunLosses));
          for (const cat of ['one', 'two', 'four']) {
            for (let b = 0; b < 2; b++) {
              worst = Math.max(worst, Math.abs(ref.avgCells[cat][b] - fast.avgCells[cat][b]));
            }
          }
          n++;
        }
        out.push({ partitions: n, worst });
      }
      return out;
    });
    assert(equiv.every((r) => r.partitions === 105), 'the equivalence check covers all 105 splits of each hand');
    assert(equiv.every((r) => r.worst === 0),
      'the delta tables reproduce the plain scorer exactly — EV, per-hand cells, SD and homerun counts');

    assert(errors.length === 0, 'no console/page errors while the presets ran' + (errors.length ? ': ' + errors[0] : ''));
  } catch (e) {
    console.error('FAILED:', e.message);
    failures++;
  } finally {
    await browser.close();
    try { server.kill(); } catch (_) {}
  }

  console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
