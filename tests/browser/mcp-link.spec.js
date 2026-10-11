// The viewer reads links made by the MCP link tool (mcp/src/tools/link.js).
// The tool runs here in-process on the same fixture the page is built from,
// and its hash goes on the single-file page.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'netdaq-small.json');
const TOOL = pathToFileURL(path.join(__dirname, '..', '..', 'mcp', 'src', 'tools', 'link.js')).href;

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const bb = fixture.pcbdata.edges_bbox;
const P1 = [+(bb.minx + 0.2 * (bb.maxx - bb.minx)).toFixed(2), +(bb.miny + 0.3 * (bb.maxy - bb.miny)).toFixed(2)];
const P2 = [+(bb.minx + 0.7 * (bb.maxx - bb.minx)).toFixed(2), +(bb.miny + 0.6 * (bb.maxy - bb.miny)).toFixed(2)];

// The hash the tool makes for args, from a store that holds the fixture.
async function toolHash(args) {
  const { default: link } = await import(TOOL);
  const run = link.handler({ store: { readJson: async () => fixture.pcbdata } });
  const { url } = await run({ board: 'netdaq.json', ...args });
  return url.slice(url.indexOf('#'));
}

async function load(page, hash) {
  await page.goto('about:blank');
  await page.goto(PAGE + hash);
  await page.waitForFunction(() => window.__pcbaTest && window.__pcbaTest.ready(), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function state(page) {
  return page.evaluate(() => window.__pcbaTest.state());
}

async function viewBox(page, side) {
  return page.evaluate((side) => window.__pcbaTest.viewBox(side), side);
}

async function markers(page) {
  return page.evaluate(() => window.__pcbaTest.markers());
}

test('a tool link selects its parts and nets and shows its marker', async ({ page }) => {
  // Lower case on purpose: the tool writes the board names.
  const hash = await toolHash({ refs: ['u24'], nets: ['+3.3v'], marks: [{ side: 'F', x: P1[0], y: P1[1] }] });
  await load(page, hash);
  const s = await state(page);
  expect(s.selection.map(({ type, value }) => ({ type, value }))).toEqual([
    { type: 'comp', value: 'U24' },
    { type: 'net', value: '+3.3V' },
  ]);
  expect(s.selectedNet).toBe('+3.3V');
  expect(await markers(page)).toEqual([{ side: 'F', x: P1[0], y: P1[1] }]);
});

test('a tool link keeps a back view when its marker is on the front', async ({ page }) => {
  const want = { minx: P2[0] - 10, miny: P2[1] - 6, maxx: P2[0] + 10, maxy: P2[1] + 6 };
  const args = { marks: [{ side: 'F', x: P1[0], y: P1[1] }], view_b: want };

  // The same link without side= (as a hand-written one would be) loses the
  // view: the viewer shows only the marker's side.
  const bare = (await toolHash(args)).replace(/side=FB&?/, '');
  expect(bare).not.toContain('side=');
  await load(page, bare);
  expect((await state(page)).canvasLayout).toBe('F');

  await load(page, await toolHash(args));
  expect((await state(page)).canvasLayout).toBe('FB');
  const v = await viewBox(page, 'B');
  expect(v.cx).toBeCloseTo(P2[0], 1);
  expect(v.cy).toBeCloseTo(P2[1], 1);
  // The box is fitted to the canvas, so at least the asked area is shown.
  expect(v.w).toBeGreaterThanOrEqual(20 - 0.01);
  expect(v.h).toBeGreaterThanOrEqual(12 - 0.01);
  expect(Math.min(v.w - 20, v.h - 12)).toBeLessThan(0.1);
  expect(await markers(page)).toEqual([{ side: 'F', x: P1[0], y: P1[1] }]);
});

test('a tool link with a front view sets that view', async ({ page }) => {
  const want = { minx: P1[0] - 5, miny: P1[1] - 5, maxx: P1[0] + 5, maxy: P1[1] + 5 };
  await load(page, await toolHash({ refs: ['U24'], view_f: want }));
  expect((await state(page)).canvasLayout).toBe('F');
  const v = await viewBox(page, 'F');
  expect(v.cx).toBeCloseTo(P1[0], 1);
  expect(v.cy).toBeCloseTo(P1[1], 1);
});
