// The far side seen through the board (x-ray) is kept in tiles fixed to the
// board. A pan only draws the tiles it brings in, and what it shows is the
// same as a far side drawn from scratch.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function load(page) {
  await page.goto(PAGE + '#side=F&xray=back-on-front');
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await waitIdle(page);
}

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function center(page) {
  const box = await page.locator('#frontcanvas').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function xrayTiles(page) {
  return page.evaluate(() => window.__pcbaTest.lastRender('F').phases.xrayTiles);
}

// The viewport part of the front bg canvas, as RGBA bytes.
async function viewportPixels(page) {
  return page.evaluate(() => {
    const os = allcanvas.front._overscan;
    const c = allcanvas.front.bg;
    const x = Math.ceil(os.x), y = Math.ceil(os.y);
    const d = c.getContext('2d').getImageData(x, y, c.width - 2 * x, c.height - 2 * y).data;
    return Array.from(d);
  });
}

test('a pan does not redraw the far side, and shows it as a fresh draw does', async ({ page }) => {
  await load(page);
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -100);
    await waitIdle(page);
  }
  // A new zoom draws the far side again, so the check below means something.
  expect(await xrayTiles(page)).toBeGreaterThan(0);

  await page.mouse.down();
  await page.mouse.move(c.x + 200, c.y + 100, { steps: 5 });
  await page.mouse.up();
  // A short pan stays in the overscan and does not render. Render as a pan
  // near the overscan edge would.
  await page.evaluate(() => renderBuffers(allcanvas.front));
  await waitIdle(page);
  expect(await xrayTiles(page)).toBe(0);
  const panned = await viewportPixels(page);

  // Drop the cache and render the same view again.
  await page.evaluate(() => {
    _worker.postMessage({ type: 'updateSettings', settings: gatherSettings(), styleCache: _styleCache });
    renderBuffers(allcanvas.front);
  });
  await waitIdle(page);
  expect(await xrayTiles(page)).toBeGreaterThan(0);
  const fresh = await viewportPixels(page);

  expect(panned.length).toBe(fresh.length);
  let off = 0;
  for (let i = 0; i < fresh.length; i++) if (Math.abs(panned[i] - fresh[i]) > 2) off++;
  expect(off / fresh.length).toBeLessThan(0.001);
});
