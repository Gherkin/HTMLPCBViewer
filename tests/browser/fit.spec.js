// E (zoom=selected) fits the highlighted nets as the layer table draws them:
// a layer counts when it is on, or off with Net ticked, and only for the
// kinds ticked on its row. These read the points E fits, fitPoints(side), and
// compare their bounds with the net's copper in the fixture.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'netdaq-small.json');

const pcbdata = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).pcbdata;

// Nets whose copper on one layer reaches well outside their copper on F.
const INNER_NET = '/ADCIN28';                     // In2.Cu tracks
const BACK_NET = '/Ethernet PHY/MODE0_RXD0';      // B tracks
const ZONE_NET = '+5V_USB';                       // a zone on F

function hashOf(pairs) {
  return '#' + pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

async function load(page, hash) {
  await page.goto('about:blank');
  await page.goto(PAGE + hash);
  await page.waitForFunction(() => window.__pcbaTest && window.__pcbaTest.ready(), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

function boxOf(points) {
  const b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (const [x, y] of points) {
    b.minx = Math.min(b.minx, x); b.maxx = Math.max(b.maxx, x);
    b.miny = Math.min(b.miny, y); b.maxy = Math.max(b.maxy, y);
  }
  return b;
}

// Track ends of a net on a layer, vias left out.
function trackBox(net, layer) {
  const pts = [];
  for (const t of pcbdata.tracks[layer]) {
    if (t.net !== net || !t.start) continue;
    if (t.start[0] === t.end[0] && t.start[1] === t.end[1]) continue;
    pts.push(t.start, t.end);
  }
  return boxOf(pts);
}

function zoneBox(net, layer) {
  const pts = [];
  for (const z of pcbdata.zones[layer]) if (z.net === net) for (const poly of z.polygons) pts.push(...poly);
  return boxOf(pts);
}

function contains(outer, inner) {
  const eps = 1e-6;
  return outer.minx <= inner.minx + eps && outer.miny <= inner.miny + eps &&
         outer.maxx >= inner.maxx - eps && outer.maxy >= inner.maxy - eps;
}

async function fitBox(page, side) {
  return boxOf(await page.evaluate((side) => fitPoints(side), side));
}

async function fitBoxWith(page, pairs, side = 'F') {
  await load(page, hashOf(pairs));
  return fitBox(page, side);
}

test('the fixture nets reach outside their copper on F', async ({ page }) => {
  for (const [net, box] of [[INNER_NET, trackBox(INNER_NET, 'In2.Cu')],
                            [BACK_NET, trackBox(BACK_NET, 'B')],
                            [ZONE_NET, zoneBox(ZONE_NET, 'F')]]) {
    const onF = await fitBoxWith(page, [['side', 'F'], ['copper', 'F:tv'], ['net', net]]);
    expect(contains(onF, box), net).toBe(false);
  }
});

test('E leaves out an inner layer that is off, and counts it when on', async ({ page }) => {
  const inner = trackBox(INNER_NET, 'In2.Cu');
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['net', INNER_NET]]), inner)).toBe(false);
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['copper', 'In2.Cu'], ['net', INNER_NET]]), inner)).toBe(true);
  // Tracks off on the row: its tracks do not count.
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['copper', 'In2.Cu:zv'], ['net', INNER_NET]]), inner)).toBe(false);
});

test('E leaves out the side in view when that layer is off', async ({ page }) => {
  // Only the tracks on In2.Cu are on: the net's pad on F, left of them, does
  // not count. Nor does its via, which is further left still.
  const fit = await fitBoxWith(page, [['side', 'F'], ['copper', 'In2.Cu:t'], ['net', INNER_NET]]);
  const inner = trackBox(INNER_NET, 'In2.Cu');
  expect(contains(fit, inner)).toBe(true);
  const slack = 1;
  expect(fit.minx).toBeGreaterThan(inner.minx - slack);
  expect(fit.miny).toBeGreaterThan(inner.miny - slack);
  expect(fit.maxx).toBeLessThan(inner.maxx + slack);
  expect(fit.maxy).toBeLessThan(inner.maxy + slack);
});

test('E counts a layer that is off with Net ticked', async ({ page }) => {
  const inner = trackBox(INNER_NET, 'In2.Cu');
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['netcopper', 'In2.Cu'], ['net', INNER_NET]]), inner)).toBe(true);
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['netcopper', 'In2.Cu:zv'], ['net', INNER_NET]]), inner)).toBe(false);

  // The far side.
  const back = trackBox(BACK_NET, 'B');
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['net', BACK_NET]]), back)).toBe(false);
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['netcopper', 'B'], ['net', BACK_NET]]), back)).toBe(true);

  // An inner layer seen from the back.
  expect(contains(await fitBoxWith(page, [['side', 'B'], ['copper', 'B'], ['netcopper', 'In2.Cu'], ['net', INNER_NET]], 'B'), inner)).toBe(true);
});

test('E fits zones', async ({ page }) => {
  const zone = zoneBox(ZONE_NET, 'F');
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F'], ['net', ZONE_NET]]), zone)).toBe(true);
  expect(contains(await fitBoxWith(page, [['side', 'F'], ['copper', 'F:tv'], ['net', ZONE_NET]]), zone)).toBe(false);
});

test('pressing E zooms to the inner layer copper', async ({ page }) => {
  await load(page, hashOf([['side', 'F'], ['copper', 'F'], ['netcopper', 'In2.Cu'], ['net', INNER_NET]]));
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
  const v = await page.evaluate(() => window.__pcbaTest.viewBox('F'));
  const inner = trackBox(INNER_NET, 'In2.Cu');
  expect(v.cx - v.w / 2).toBeLessThanOrEqual(inner.minx);
  expect(v.cx + v.w / 2).toBeGreaterThanOrEqual(inner.maxx);
  expect(v.cy - v.h / 2).toBeLessThanOrEqual(inner.miny);
  expect(v.cy + v.h / 2).toBeGreaterThanOrEqual(inner.maxy);
});
