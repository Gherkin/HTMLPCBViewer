// Smoke tests driven entirely through window.__pcbaTest.
//
// Deliberately no DOM selectors. The board draws to canvas so there is little
// in the DOM worth asserting on anyway, and selectors would encode assumptions
// about viewer.html's markup. Everything here is either the documented test
// API contract or a number derived from the fixture itself, so these stay
// correct regardless of how the page is laid out.
//
// Tests that click real controls are in interaction.spec.js.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'netdaq-small.json');

// Derive expectations from the fixture rather than hardcoding, so regenerating
// it with different caps does not silently invalidate these.
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const expectedFootprints = fixture.pcbdata.footprints.length;
const expectedNets = new Set(
  fixture.pcbdata.footprints.flatMap((fp) =>
    (fp.pads || []).map((p) => p.net).filter(Boolean)
  )
).size;

async function load(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  return errors;
}

test('test API is present at the expected version', async ({ page }) => {
  await load(page);
  const version = await page.evaluate(() => window.__pcbaTest.version);
  expect(version).toBe(2);
});

test('board loads with no page errors', async ({ page }) => {
  const errors = await load(page);
  expect(errors).toEqual([]);
});

test('counters match the fixture', async ({ page }) => {
  await load(page);
  const counters = await page.evaluate(() => window.__pcbaTest.counters());
  expect(counters.footprints).toBe(expectedFootprints);
  expect(counters.nets).toBe(expectedNets);
});

test('the board actually renders', async ({ page }) => {
  await load(page);
  // Rendering is async via the worker, so wait for a side to report samples
  // rather than reading immediately.
  await page.waitForFunction(
    () => window.__pcbaTest.sides().some(
      (s) => (window.__pcbaTest.renderStats(s) || {}).count > 0
    ),
    null,
    { timeout: 30000 }
  );

  const sides = await page.evaluate(() => window.__pcbaTest.sides());
  expect(sides.length).toBeGreaterThan(0);

  const stats = await page.evaluate(
    (s) => window.__pcbaTest.renderStats(s),
    sides[0]
  );
  expect(stats).not.toBeNull();
  expect(stats.count).toBeGreaterThan(0);
  expect(stats.total.p50).toBeGreaterThanOrEqual(0);
});

test('load timings are recorded', async ({ page }) => {
  await load(page);
  await page.waitForFunction(
    () => window.__pcbaTest.timings().boardVisible !== undefined,
    null,
    { timeout: 30000 }
  );
  const timings = await page.evaluate(() => window.__pcbaTest.timings());
  expect(timings.pcbdataReady).toBeGreaterThan(0);
  expect(timings.boardVisible).toBeGreaterThan(0);
  // Nothing can become visible before the data is parsed.
  expect(timings.boardVisible).toBeGreaterThanOrEqual(timings.pcbdataReady);
});

test('initial state is unselected', async ({ page }) => {
  await load(page);
  const state = await page.evaluate(() => window.__pcbaTest.state());
  expect(state.selectedNet).toBeNull();
  expect(state.selectedFootprintIdx).toBeNull();
  expect(state.highlightedFootprints).toEqual([]);
});

test('net layer lookup returns real layers', async ({ page }) => {
  await load(page);
  const someNet = fixture.pcbdata.footprints
    .flatMap((fp) => (fp.pads || []).map((p) => p.net))
    .find(Boolean);
  const layers = await page.evaluate(
    (n) => window.__pcbaTest.netLayers(n),
    someNet
  );
  expect(Array.isArray(layers)).toBe(true);
  expect(layers.length).toBeGreaterThan(0);
});

// Inner copper comes from tools/make_fixture.py, not from ibom, so check it
// actually reaches the viewer. Layer names are KiCad style (In1.Cu).
const innerLayerNames = [...new Set(
  ['tracks', 'zones'].flatMap((s) => Object.keys(fixture.pcbdata[s] || {}))
)].filter((l) => l !== 'F' && l !== 'B').sort();

test('fixture has inner copper layers', () => {
  expect(innerLayerNames.length).toBeGreaterThan(0);
});

test('viewer reports the fixture inner layers', async ({ page }) => {
  await load(page);
  const state = await page.evaluate(() => window.__pcbaTest.state());
  expect(state.innerLayers.slice().sort()).toEqual(innerLayerNames);
});

test('a net routed on an inner layer lists that layer', async ({ page }) => {
  await load(page);
  const layer = innerLayerNames[0];
  // Vias are zero-length segments and do not count as routing.
  const routed = (fixture.pcbdata.tracks[layer] || []).find(
    (t) => t.net && !(t.start && t.start[0] === t.end[0] && t.start[1] === t.end[1])
  );
  expect(routed).toBeDefined();
  const layers = await page.evaluate(
    (n) => window.__pcbaTest.netLayers(n),
    routed.net
  );
  expect(layers).toContain(layer);
});
