// Layer order with ten or more inner layers. The page is the fixture plus
// In3.Cu to In12.Cu, built by global-setup.js. A plain string sort puts In10
// before In2.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'many-layers.html');

const INNER = Array.from({ length: 12 }, (_, i) => `In${i + 1}.Cu`);

async function load(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await page.locator('#comp-tbody .comp-row').first().waitFor();
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

test('layers sort by number, F first and B last, for both CAD name styles', async ({ page }) => {
  await load(page);
  const sorted = await page.evaluate(() => [
    ['B', 'In10.Cu', 'In2.Cu', 'F', 'In1.Cu'].sort(compareLayers),
    ['LAY10', 'B', 'LAY2', 'F', 'LAY1'].sort(compareLayers),
  ]);
  expect(sorted[0]).toEqual(['F', 'In1.Cu', 'In2.Cu', 'In10.Cu', 'B']);
  expect(sorted[1]).toEqual(['F', 'LAY1', 'LAY2', 'LAY10', 'B']);
});

test('inner layer list is in number order', async ({ page }) => {
  await load(page);
  expect((await page.evaluate(() => window.__pcbaTest.state())).innerLayers).toEqual(INNER);
  const labels = await page.locator('#inner-layer-toggles label').allTextContents();
  expect(labels.map((l) => l.trim())).toEqual(INNER);
});

test('layer filter buttons are in stack order', async ({ page }) => {
  await load(page);
  const layers = await page.locator('#layer-filter-bar .layer-filter-btn')
    .evaluateAll((bs) => bs.map((b) => b.dataset.layer));
  expect(layers).toEqual(['ALL', 'F', ...INNER, 'B']);
});

test('net layer badges are in stack order', async ({ page }) => {
  await load(page);
  const net = await page.evaluate(() => {
    for (const n of Object.keys(netToLayers)) if (netToLayers[n].has('In12.Cu')) return n;
  });
  expect(net).toBeDefined();
  await page.evaluate((n) => selectNet(n), net);
  const titles = await page.locator('#net-layer-badges button')
    .evaluateAll((bs) => bs.map((b) => b.title));
  const expected = ['F', ...INNER, 'B'].filter((l) => titles.includes(l));
  expect(titles).toEqual(expected);
  expect(titles).toEqual(expect.arrayContaining(INNER.slice(1)));
});
