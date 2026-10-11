// Link markers: mark=F:x,y and mark=B:x,y draw a marker at a board point.
// The board is drawn to canvas, so these read the highlight canvas pixels at
// the spot the view says the point is on.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'netdaq-small.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const bb = fixture.pcbdata.edges_bbox;

// Points well off the board centre, so a mirrored marker lands elsewhere.
const P1 = [+(bb.minx + 0.2 * (bb.maxx - bb.minx)).toFixed(2), +(bb.miny + 0.3 * (bb.maxy - bb.miny)).toFixed(2)];
const P2 = [+(bb.minx + 0.7 * (bb.maxx - bb.minx)).toFixed(2), +(bb.miny + 0.6 * (bb.maxy - bb.miny)).toFixed(2)];

function hashOf(pairs) {
  return '#' + pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

async function load(page, hash = '') {
  await page.goto('about:blank');
  await page.goto(PAGE + hash);
  await page.waitForFunction(() => window.__pcbaTest && window.__pcbaTest.ready(), null, { timeout: 30000 });
  await waitIdle(page);
}

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function state(page) {
  return page.evaluate(() => window.__pcbaTest.state());
}

async function viewBox(page, side) {
  return page.evaluate((side) => window.__pcbaTest.viewBox(side), side);
}

// Where a board point is on a side's canvas, as a fraction of the canvas box.
// Side B is seen from below, so x runs the other way.
async function screenFraction(page, side, [x, y]) {
  const v = await viewBox(page, side);
  const fx = side === 'B' ? 0.5 - (x - v.cx) / v.w : 0.5 + (x - v.cx) / v.w;
  return [fx, 0.5 + (y - v.cy) / v.h];
}

async function pixel(page, side, [fx, fy]) {
  return page.evaluate(([side, fx, fy]) => window.__pcbaTest.highlightPixel(side, fx, fy), [side, fx, fy]);
}

// The marker centre is an opaque white dot.
async function expectMarkerAt(page, side, point) {
  const px = await pixel(page, side, await screenFraction(page, side, point));
  expect(px[3]).toBe(255);
  expect(px[0]).toBeGreaterThan(200);
  expect(px[1]).toBeGreaterThan(200);
  expect(px[2]).toBeGreaterThan(200);
}

async function expectNoMarkerAt(page, side, point) {
  const px = await pixel(page, side, await screenFraction(page, side, point));
  expect(px[3]).toBe(0);
}

// The same spot reflected across the canvas centre line.
async function mirroredAt(page, side, point) {
  const [fx, fy] = await screenFraction(page, side, point);
  return page.evaluate(([side, fx, fy]) => window.__pcbaTest.highlightPixel(side, fx, fy), [side, 1 - fx, fy]);
}

test('fixture points are apart', () => {
  expect(Math.abs(P1[0] - P2[0])).toBeGreaterThan(10);
});

test('a front marker is drawn at its point and does not select anything', async ({ page }) => {
  await load(page, hashOf([['mark', `F:${P1[0]},${P1[1]}`]]));
  expect(await page.evaluate(() => window.__pcbaTest.markers())).toEqual([{ side: 'F', x: P1[0], y: P1[1] }]);
  const s = await state(page);
  expect(s.selection).toEqual([]);
  expect(s.canvasLayout).toBe('F');
  await expectMarkerAt(page, 'F', P1);
  await expectNoMarkerAt(page, 'F', P2);
  expect((await mirroredAt(page, 'F', P1))[3]).toBe(0);
  // A marker alone does not shade the board like a selection does.
  expect(await page.locator('#F_bg').evaluate((c) => c.style.filter)).toBe('');
});

test('a back marker lands on the mirrored spot, also after pan and zoom', async ({ page }) => {
  await load(page, hashOf([['mark', `B:${P1[0]},${P1[1]}`]]));
  // No side in the link: it shows the side the marker is on.
  expect((await state(page)).canvasLayout).toBe('B');
  await expectMarkerAt(page, 'B', P1);
  expect((await mirroredAt(page, 'B', P1))[3]).toBe(0);

  const box = await page.locator('#backcanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await page.mouse.wheel(0, -300);
  await waitIdle(page);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await waitIdle(page);
  await expectMarkerAt(page, 'B', P1);
});

test('markers show only on their own side', async ({ page }) => {
  await load(page, hashOf([['mark', `F:${P1[0]},${P1[1]}`], ['mark', `B:${P2[0]},${P2[1]}`]]));
  expect((await state(page)).canvasLayout).toBe('FB');
  await expectMarkerAt(page, 'F', P1);
  await expectMarkerAt(page, 'B', P2);
  await expectNoMarkerAt(page, 'F', P2);
  await expectNoMarkerAt(page, 'B', P1);
});

test('a given side wins over the marker sides', async ({ page }) => {
  await load(page, hashOf([['mark', `B:${P1[0]},${P1[1]}`], ['side', 'F']]));
  expect((await state(page)).canvasLayout).toBe('F');
});

test('zoom=selected fits the markers', async ({ page }) => {
  await load(page);
  const board = await viewBox(page, 'F');
  await load(page, hashOf([['mark', `F:${P1[0]},${P1[1]}`], ['mark', `F:${P2[0]},${P2[1]}`], ['zoom', 'selected']]));
  const v = await viewBox(page, 'F');
  expect(v.w).toBeLessThan(board.w);
  for (const [x, y] of [P1, P2]) {
    expect(Math.abs(x - v.cx)).toBeLessThan(v.w / 2);
    expect(Math.abs(y - v.cy)).toBeLessThan(v.h / 2);
  }
  await expectMarkerAt(page, 'F', P1);
  await expectMarkerAt(page, 'F', P2);

  // One marker: zoomed in around it.
  await load(page, hashOf([['mark', `F:${P1[0]},${P1[1]}`], ['zoom', 'selected']]));
  const one = await viewBox(page, 'F');
  expect(one.w).toBeLessThan(board.w / 2);
  expect(one.cx).toBeCloseTo(P1[0], 1);
  expect(one.cy).toBeCloseTo(P1[1], 1);
});

test('markers stay in the address bar, bad ones are skipped, Esc removes them', async ({ page }) => {
  await load(page, '#mark=F:1,2&mark=X:1,2&mark=F:1&mark=F:a,b&mark=f:3.5,-4');
  expect(await page.evaluate(() => window.__pcbaTest.markers())).toEqual([
    { side: 'F', x: 1, y: 2 }, { side: 'F', x: 3.5, y: -4 },
  ]);

  // A selection rewrites the hash and keeps the markers.
  await page.locator('#tab-components').click();
  await page.locator('#comp-tbody .comp-row').first().click();
  await waitIdle(page);
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#comp=[^&]+&mark=F:1,2&mark=F:3\.5,-4$/);

  await page.locator('#meta-title').click();
  await page.keyboard.press('Escape');
  await waitIdle(page);
  expect(await page.evaluate(() => window.__pcbaTest.markers())).toEqual([]);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
});
