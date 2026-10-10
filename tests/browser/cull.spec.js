// Drawing a small part of a large board must cost less than drawing all of
// it. The worker keeps a grid index per item list, so a render only looks at
// the items in the cells under the buffer.
//
// The gate is itemsVisited: the board items the culling looked at, drawn or
// not. It does not depend on machine speed. The render times are attached to
// the result for reading, and never asserted.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'ciaa-acc.html');

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

// One step of deltaY 100 zooms about 1.27x, so 12 steps is about 17x.
const ZOOM_STEPS = 12;

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

test('a render zoomed in on a large board looks at a small part of it', async ({ page }, testInfo) => {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await waitIdle(page);
  const fit = await page.evaluate(() => window.__pcbaTest.lastRender('F'));

  const box = await page.locator('#frontcanvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < ZOOM_STEPS; i++) {
    await page.mouse.wheel(0, -100);
    await waitIdle(page);
  }
  const deep = await page.evaluate(() => window.__pcbaTest.lastRender('F'));

  await testInfo.attach('renders.json', {
    body: JSON.stringify({ fit, deep }, null, 2),
    contentType: 'application/json',
  });

  expect(fit.itemsVisited).toBeGreaterThan(0);
  expect(deep.itemsVisited).toBeLessThan(fit.itemsVisited / 10);
});
