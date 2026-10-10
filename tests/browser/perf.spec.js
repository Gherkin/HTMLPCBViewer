// Performance regression gate (#10).
//
// Runs a fixed pan and zoom script over each board and compares counters that
// do not depend on machine speed against tests/perf/<board>.json: renders,
// worker posts, canvas draw calls and the board JSON size. Any difference
// fails, improvements included, so the baseline stays honest. To accept a
// change, run
//
//   npm run perf:baseline
//
// and commit the new baselines with the change that caused them.
//
// The boards are the small netdaq fixture and the large CIAA-ACC one, which
// is where render changes show up.
//
// Wall-clock numbers (render p50/p90/p99, droppedFrames, load timings) are
// attached to the test result for reading, and never asserted here.
// GitHub-hosted runners are too noisy for them. With PERF_WALLCLOCK_OUT set
// the netdaq numbers are also written to that path, and CI tracks them per
// commit with tools/perf_trend.js (#18).
//
// The script waits for the renderer to go idle after every input step. Render
// requests that arrive while one is in flight are merged, so without the wait
// a slow machine would do fewer renders for the same input.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// page is built by global-setup.js. trend marks the board whose wall-clock
// numbers go to PERF_WALLCLOCK_OUT, so the history stays comparable.
const BOARDS = [
  { name: 'netdaq-small', page: 'board.html', trend: true },
  { name: 'ciaa-acc', page: 'ciaa-acc.html', trend: false },
];
const UPDATE = !!process.env.PERF_UPDATE_BASELINE;
const WALLCLOCK_OUT = process.env.PERF_WALLCLOCK_OUT;

// Draw call culling depends on the canvas size, so pin it rather than
// inheriting whatever the device preset says.
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const PAN_STEPS = 20;
const PAN_STEP_PX = 40;
const ZOOM_STEPS = 6;
const WHEEL_DELTA = 100;

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function counters(page) {
  return page.evaluate(() => window.__pcbaTest.counters());
}

function delta(after, before) {
  return {
    renders: after.renders - before.renders,
    workerPosts: after.workerPosts - before.workerPosts,
    drawCalls: after.drawCalls - before.drawCalls,
  };
}

for (const board of BOARDS) {
  test(`${board.name}: interaction counters match the baseline`, async ({ page }, testInfo) => {
    await runScript(page, testInfo, board);
  });
}

async function runScript(page, testInfo, board) {
  const url = 'file://' + path.join(__dirname, board.page);
  const baselineFile = path.join(__dirname, '..', 'perf', `${board.name}.json`);
  // The top bar is sized by its text, so its height follows the installed
  // fonts and the canvas height with it. Pin it so CI and local runs draw the
  // same canvas. The canvas size is part of the baseline, so if this stops
  // working the diff says so directly.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '#topbar { height: 40px; box-sizing: border-box; flex-wrap: nowrap; overflow: hidden; }';
      document.head.appendChild(s);
    });
  });
  await page.goto(url);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await waitIdle(page);
  const afterLoad = await counters(page);

  const box = await page.locator('#frontcanvas').boundingBox();
  expect(box).not.toBeNull();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Drag right, then back left, one step at a time. The cursor must stay on
  // the canvas: leaving it fires pointerleave, which ends the drag.
  const left = box.x + 40;
  const right = left + PAN_STEPS * PAN_STEP_PX;
  expect(right).toBeLessThan(box.x + box.width);
  for (const [from, dir] of [[left, 1], [right, -1]]) {
    await page.mouse.move(from, cy);
    await page.mouse.down();
    for (let i = 1; i <= PAN_STEPS; i++) {
      await page.mouse.move(from + dir * i * PAN_STEP_PX, cy);
      await waitIdle(page);
    }
    await page.mouse.up();
    await waitIdle(page);
  }
  const afterPan = await counters(page);

  // Zoom in, then back out by the same amount.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < ZOOM_STEPS; i++) {
    await page.mouse.wheel(0, -WHEEL_DELTA);
    await waitIdle(page);
  }
  for (let i = 0; i < ZOOM_STEPS; i++) {
    await page.mouse.wheel(0, WHEEL_DELTA);
    await waitIdle(page);
  }
  const afterZoom = await counters(page);

  const actual = {
    canvas: { width: box.width, height: box.height },
    data: {
      pcbdataBytes: afterLoad.pcbdataBytes,
      footprints: afterLoad.footprints,
      nets: afterLoad.nets,
      innerLayers: afterLoad.innerLayers,
    },
    load: {
      renders: afterLoad.renders,
      workerPosts: afterLoad.workerPosts,
      drawCalls: afterLoad.drawCalls,
    },
    pan: delta(afterPan, afterLoad),
    zoom: delta(afterZoom, afterPan),
  };

  // Trend material only. Read it from the report, do not assert on it.
  const wallClock = await page.evaluate(() => {
    const t = window.__pcbaTest;
    const stats = {};
    for (const s of t.sides()) stats[s] = t.renderStats(s);
    return { timings: t.timings(), renderStats: stats };
  });
  await testInfo.attach('counters.json', {
    body: JSON.stringify(actual, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('wall-clock.json', {
    body: JSON.stringify(wallClock, null, 2),
    contentType: 'application/json',
  });
  // The script waits for idle after each wheel step, so every step gives one
  // zoom-to-sharp sample. The value is wall-clock, the count is not.
  expect(wallClock.renderStats.F.zoomToSharp.count).toBe(2 * ZOOM_STEPS);

  if (WALLCLOCK_OUT && board.trend) {
    fs.mkdirSync(path.dirname(WALLCLOCK_OUT), { recursive: true });
    fs.writeFileSync(WALLCLOCK_OUT, JSON.stringify(wallClock, null, 2) + '\n');
  }

  if (UPDATE) {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(actual, null, 2) + '\n');
    return;
  }

  expect(fs.existsSync(baselineFile), 'no baseline, run: npm run perf:baseline').toBe(true);
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  expect(
    actual,
    'perf counters changed. If intended, run: npm run perf:baseline'
  ).toEqual(baseline);
}
