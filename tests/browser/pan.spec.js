// A right drag pans the view, like a left or middle drag. A right click
// without a drag does nothing.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function load(page) {
  await page.goto(PAGE + '#side=F');
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready() && window.__pcbaTest.idle(),
    null,
    { timeout: 30000 }
  );
}

async function center(page) {
  const box = await page.locator('#frontcanvas').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function transform(page) {
  return page.evaluate(() => {
    const t = allcanvas.front.transform;
    return { panx: t.panx, pany: t.pany, zoom: t.zoom };
  });
}

test('a right drag pans, and a right click leaves the view as it is', async ({ page }) => {
  await load(page);
  const c = await center(page);
  const before = await transform(page);

  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + 200, c.y + 100, { steps: 5 });
  await page.mouse.up({ button: 'right' });

  const panned = await transform(page);
  expect(panned.zoom).toBe(before.zoom);
  expect(panned.panx - before.panx).toBeCloseTo(200 / panned.zoom, 0);
  expect(panned.pany - before.pany).toBeCloseTo(100 / panned.zoom, 0);

  await page.mouse.click(c.x, c.y, { button: 'right' });
  expect(await transform(page)).toEqual(panned);
});
