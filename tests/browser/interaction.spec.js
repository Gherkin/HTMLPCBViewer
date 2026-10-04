// Interaction tests (#9). These click real controls in viewer.html and then
// check state through window.__pcbaTest. The board is drawn to canvas, so a
// few tests also sample canvas pixels to check that a highlight was actually
// drawn. No screenshot diffs: they flake across GPUs and platforms.
//
// Known bugs are marked test.fail() with the issue number. When the bug is
// fixed the test starts passing, Playwright reports that as a failure, and the
// marker should be removed in the same change.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'netdaq-small.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const footprints = fixture.pcbdata.footprints;

// Same palette as render.js. Selections take colours from it in order.
const PALETTE = ['#b58900', '#2aa198', '#d33682', '#859900', '#6c71c4', '#cb4b16', '#dc322f', '#268bd2'];

// net -> indexes of footprints with a pad on it, same as buildIndexes().
const netToFootprints = {};
footprints.forEach((fp, i) => {
  for (const p of fp.pads || []) {
    if (!p.net) continue;
    (netToFootprints[p.net] = netToFootprints[p.net] || new Set()).add(i);
  }
});

// Nets with pads on the front, a few parts each, so the highlight is visible
// on the front canvas and the net results list is short.
const frontNets = Object.keys(netToFootprints)
  .filter((n) => {
    const fps = [...netToFootprints[n]];
    return fps.length >= 2 && fps.length <= 6 &&
      fps.some((i) => footprints[i].layer === 'F');
  })
  .sort();

const innerLayers = [...new Set(
  ['tracks', 'zones'].flatMap((s) => Object.keys(fixture.pcbdata[s] || {}))
)].filter((l) => l !== 'F' && l !== 'B');

async function load(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  // The lists are filled two frames after ready().
  await page.locator('#comp-tbody .comp-row').first().waitFor();
  await waitIdle(page);
}

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function state(page) {
  return page.evaluate(() => window.__pcbaTest.state());
}

// Hovering a list row adds a temporary highlight and fades the selection
// until the mouse leaves. A click leaves the cursor on a row, so move it to
// the title before reading state, the way a user moves on after clicking.
async function settle(page) {
  const box = await page.locator('#meta-title').boundingBox();
  await page.mouse.move(box.x + 2, box.y + 2);
  await waitIdle(page);
}

// Count pixels on a side's highlight canvas that are close to a colour.
// minAlpha 200 counts only full-strength pixels, not ones faded by a hover.
async function countColor(page, side, hex, minAlpha = 64) {
  await waitIdle(page);
  return page.evaluate(({ side, hex, minAlpha }) => {
    const c = document.getElementById(side + '_hl');
    if (!c || !c.width || !c.height) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < minAlpha) continue;
      if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30) n++;
    }
    return n;
  }, { side, hex, minAlpha });
}

// A hash of every visible canvas on a side, to tell whether a toggle changed
// what is shown. Inner layers have their own canvases, hidden when empty.
async function canvasHash(page, side) {
  await waitIdle(page);
  return page.evaluate((side) => {
    let h = 0;
    const stack = document.getElementById(side === 'F' ? 'frontcanvas' : 'backcanvas');
    for (const c of stack.querySelectorAll('canvas')) {
      if (!c.width || !c.height || getComputedStyle(c).display === 'none') continue;
      h = (h * 31 + c.id.length) | 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0;
    }
    return h;
  }, side);
}

// The Layers menu opens on hover.
async function openLayers(page) {
  await page.locator('#inner-layers-menu .menu-btn').hover();
}

// A checkbox in the layer table.
function layerBox(page, layer, kind) {
  return page.locator(`#layer-table tr[data-layer="${layer}"] input[data-kind="${kind}"]`);
}

// A routed track (not a via) on a layer, on a net with pads.
function innerTrack(layer) {
  const t = fixture.pcbdata.tracks[layer].find(
    (t) => t.net && netToFootprints[t.net] && t.start &&
      !(t.start[0] === t.end[0] && t.start[1] === t.end[1])
  );
  expect(t).toBeDefined();
  return t;
}

function netRow(page, net) {
  return page.locator('#net-search-list .net-search-row', {
    has: page.locator('.net-search-name', { hasText: new RegExp('^' + escapeRe(net) + '$') }),
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function selectNetFromList(page, net) {
  await page.locator('#tab-nets').click();
  if (await page.locator('#net-detail-panel').isVisible()) {
    await page.locator('#net-back-btn').click();
  }
  await page.locator('#net-search-input').fill(net);
  await netRow(page, net).click();
  await settle(page);
}

test('fixture has nets suitable for these tests', () => {
  expect(frontNets.length).toBeGreaterThanOrEqual(2);
  expect(innerLayers.length).toBeGreaterThan(0);
});

// ---- Net search and two-pane selection ----

test('net search filters the list', async ({ page }) => {
  await load(page);
  const net = frontNets[0];
  await page.locator('#tab-nets').click();
  await page.locator('#net-search-input').fill(net);

  const names = await page.locator('#net-search-list .net-search-name').allTextContents();
  expect(names).toContain(net);
  for (const n of names) expect(n.toLowerCase()).toContain(net.toLowerCase());
  expect((await state(page)).netFilter).toBe(net);

  await page.locator('#net-search-input').fill('no net has this name');
  await expect(page.locator('#net-search-list .empty-state')).toBeVisible();
});

test('selecting a net opens the detail pane and highlights it', async ({ page }) => {
  await load(page);
  const net = frontNets[0];
  const before = await countColor(page, 'F', PALETTE[0]);

  await selectNetFromList(page, net);

  const s = await state(page);
  expect(s.selectedNet).toBe(net);
  expect(s.highlightedNet).toBe(net);

  await expect(page.locator('#net-search-panel')).toBeHidden();
  await expect(page.locator('#net-detail-panel')).toBeVisible();
  await expect(page.locator('#net-detail-title')).toHaveText(net);

  const refs = await page.locator('#net-results .net-comp-ref').allTextContents();
  const expected = [...netToFootprints[net]].map((i) => footprints[i].ref);
  expect(refs.sort()).toEqual(expected.sort());

  // First selection takes the first palette colour.
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThan(before);
});

test('clicking a part in the net pane keeps the net selected', async ({ page }) => {
  await load(page);
  const net = frontNets[0];
  await selectNetFromList(page, net);

  const row = page.locator('#net-results .net-comp-row').first();
  const ref = await row.locator('.net-comp-ref').textContent();
  await row.click();
  await settle(page);

  const s = await state(page);
  expect(s.selectedNet).toBe(net);
  expect(s.netWalkHistory.filter((st) => st.type === 'net').map((st) => st.value)).toContain(net);
  await expect(page.locator('#net-comp-detail .detail-ref')).toHaveText(ref);
  await expect(page.locator('#net-detail-panel')).toBeVisible();
});

test('back button returns to the search list without deselecting', async ({ page }) => {
  await load(page);
  const net = frontNets[0];
  await selectNetFromList(page, net);

  await page.locator('#net-back-btn').click();
  await expect(page.locator('#net-search-panel')).toBeVisible();
  await expect(page.locator('#net-detail-panel')).toBeHidden();
  await expect(netRow(page, net)).toHaveClass(/selected/);
  expect((await state(page)).selectedNet).toBe(net);
});

test('walking to a second net keeps both highlighted', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);

  const s = await state(page);
  expect(s.selectedNet).toBe(b);
  expect(s.highlightedNetPath).toEqual([a, b]);
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThan(0);
  expect(await countColor(page, 'F', PALETTE[1])).toBeGreaterThan(0);
});

// #38: selecting the current net again cleared highlightedNetPath, and the
// repeat walk step did not rebuild it.
test('selecting the current net again keeps the walked nets highlighted (#38)', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  const aPx = await countColor(page, 'F', PALETTE[0]);
  expect(aPx).toBeGreaterThan(0);

  // From the net list.
  await selectNetFromList(page, b);
  let s = await state(page);
  expect(s.highlightedNetPath).toEqual([a, b]);
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThanOrEqual(aPx * 0.9);

  // From the last breadcrumb.
  await page.locator('#breadcrumb-bar .breadcrumb-item').last().click();
  await settle(page);
  s = await state(page);
  expect(s.highlightedNetPath).toEqual([a, b]);
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThanOrEqual(aPx * 0.9);
});

// #1: the nets stayed in the breadcrumbs, but the canvas showed only the
// component. Hovering a row did not stash highlightedNetPath, so leaving the
// row cleared it.
test('highlighting a component after nets keeps the nets highlighted (#1)', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  const aPx = await countColor(page, 'F', PALETTE[0]);
  const bPx = await countColor(page, 'F', PALETTE[1]);

  // A front part on neither net, so its own highlight does not cover them.
  const onNets = new Set([...netToFootprints[a], ...netToFootprints[b]]);
  const idx = footprints.findIndex((fp, i) => fp.layer === 'F' && !onNets.has(i));
  expect(idx).toBeGreaterThanOrEqual(0);

  await page.locator('#tab-components').click();
  await page.locator(`#comp-tbody .comp-row[data-idx="${idx}"]`).click();
  // Move off across another row, as a user does after clicking.
  await page.locator(`#comp-tbody .comp-row:not([data-idx="${idx}"])`).first().hover();
  await settle(page);

  const s = await state(page);
  expect(s.selectedFootprintIdx).toBe(idx);
  expect(s.highlightedNetPath).toEqual([a, b]);
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThanOrEqual(aPx * 0.9);
  expect(await countColor(page, 'F', PALETTE[1])).toBeGreaterThanOrEqual(bPx * 0.9);
});

// #1, from the net pane: hovering a part there replaces the path with one net,
// and the click used to keep that.
test('clicking a part in the net pane keeps the walked nets highlighted (#1)', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);

  await page.locator('#net-results .net-comp-row').first().click();
  await settle(page);

  const s = await state(page);
  expect(s.highlightedNetPath).toEqual([a, b]);
  expect(s.highlightedNet).toBe(b);
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThan(0);
});

// Clicking a net in the part's pad table removes the hovered button, so no
// mouseleave fires. Nothing may stay hovered after the click, and the selection
// must survive the next hover. This checks the end result only: selectNet()
// clears the hover too, so the click's own hoverClear() is not tested here.
test('a pad net link click does not leave a stale hover', async ({ page }) => {
  await load(page);
  const idx = footprints.findIndex((fp) => (fp.pads || []).some((p) => p.net));
  await page.locator(`#comp-tbody .comp-row[data-idx="${idx}"]`).click();
  await settle(page);

  const link = page.locator('#detail-pane .net-link-btn').first();
  const net = await link.textContent();
  await link.hover();
  await waitIdle(page);
  expect((await state(page)).hoverNets).toEqual([net]);
  expect((await state(page)).highlightedFootprints).toEqual([]);

  await link.click();
  await settle(page);
  expect((await state(page)).highlightedNet).toBe(net);
  expect((await state(page)).hoverNets).toEqual([]);

  await page.locator('#net-results .net-comp-row').first().hover();
  await settle(page);
  expect((await state(page)).highlightedNet).toBe(net);
});

// #40: clicking a part row pins the part and rebuilds the list, so the hovered
// row is gone and its mouseleave never fires. The click's hoverClear() is the
// only thing that clears the hover. With a real pointer Chromium sends the
// rebuilt row its own mouseenter and mouseleave, which hides a missing
// hoverClear(). So set the hover directly and click with the pointer elsewhere.
async function clickClearsHover(page, row, fpIdx) {
  await settle(page);
  await page.evaluate((i) => hoverFootprint(i), fpIdx);
  expect((await state(page)).highlightedFootprints).toEqual([fpIdx]);
  await row.dispatchEvent('click');
  await waitIdle(page);
  expect((await state(page)).highlightedFootprints).toEqual([]);
}

test('a part row click does not leave a stale hover (#40)', async ({ page }) => {
  await load(page);
  const idx = footprints.findIndex((fp) => fp.layer === 'F');
  await page.locator('#tab-components').click();
  await clickClearsHover(page, page.locator(`#comp-tbody .comp-row[data-idx="${idx}"]`), idx);

  const net = frontNets[0];
  await selectNetFromList(page, net);
  const onNet = [...netToFootprints[net]][0];
  const row = page.locator('#net-results .net-comp-row', {
    has: page.locator('.net-comp-ref', { hasText: new RegExp('^' + escapeRe(footprints[onNet].ref) + '$') }),
  });
  await clickClearsHover(page, row, onNet);
});

// #35: hovering a walk link replaced the walked nets with [current, other],
// and the other net took its colour from that list position. As the second
// walked net, both were drawn in PALETTE[1]. Now the hover adds to the walk
// and the other net shows the colour the click will give it.
test('hovering a walk link previews the colour the click gives (#35)', async ({ page }) => {
  await load(page);
  const a = frontNets[0];
  const fpNets = (i) => new Set((footprints[i].pads || []).map((p) => p.net).filter((n) => n));
  const hasFront = (n) => [...netToFootprints[n]].some((i) => footprints[i].layer === 'F');
  let b = null, c = null;
  for (const n of frontNets) {
    if (n === a) continue;
    for (const i of netToFootprints[n]) {
      const others = [...fpNets(i)].filter((o) => o !== n);
      const o = others.find((o) => o !== a && hasFront(o));
      if (others.length <= 3 && o) { c = o; break; }
    }
    if (c) { b = n; break; }
  }
  expect(c).not.toBeNull();

  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  const before = await countColor(page, 'F', PALETTE[2]);

  const link = page.locator('#net-results .walk-link', { hasText: new RegExp('^→ ' + escapeRe(c) + '$') }).first();
  await link.hover();
  await waitIdle(page);
  const s = await state(page);
  expect(s.highlightedNetPath).toEqual([a, b]);
  expect(s.hoverNets).toEqual([c]);
  // The click does not pin the part, so the hover does not show it either.
  expect(s.highlightedFootprints).toEqual([]);
  expect(await countColor(page, 'F', PALETTE[2])).toBeGreaterThan(before);

  await link.click();
  await settle(page);
  expect((await state(page)).highlightedNetPath).toEqual([a, b, c]);
  expect(await countColor(page, 'F', PALETTE[2])).toBeGreaterThan(before);
});

// #35: a hover keeps the walked nets, fades them, and draws the hovered item
// at full strength on top. Hovering a walked net shows it at full strength.
test('hover fades the walked nets and keeps them (#35)', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  const aFull = await countColor(page, 'F', PALETTE[0], 200);
  const bFull = await countColor(page, 'F', PALETTE[1], 200);
  expect(aFull).toBeGreaterThan(0);
  expect(bFull).toBeGreaterThan(0);

  // A front part on neither net.
  const onNets = new Set([...netToFootprints[a], ...netToFootprints[b]]);
  const idx = footprints.findIndex((fp, i) => fp.layer === 'F' && !onNets.has(i));
  await page.locator('#tab-components').click();
  await page.locator(`#comp-tbody .comp-row[data-idx="${idx}"]`).hover();
  await waitIdle(page);
  expect((await state(page)).highlightedNetPath).toEqual([a, b]);
  expect(await countColor(page, 'F', PALETTE[0], 200)).toBeLessThan(aFull * 0.2);
  expect(await countColor(page, 'F', PALETTE[0])).toBeGreaterThan(0);

  await settle(page);
  expect(await countColor(page, 'F', PALETTE[0], 200)).toBeGreaterThanOrEqual(aFull * 0.9);

  // Hovering walked net a in the search list draws it at full strength.
  await page.locator('#tab-nets').click();
  await page.locator('#net-back-btn').click();
  await page.locator('#net-search-input').fill(a);
  await netRow(page, a).hover();
  await waitIdle(page);
  expect(await countColor(page, 'F', PALETTE[0], 200)).toBeGreaterThanOrEqual(aFull * 0.9);
  expect(await countColor(page, 'F', PALETTE[1], 200)).toBeLessThan(bFull * 0.2);
});

// #35: hovers in the net pane also put the current net in the hover, so the
// last walked net stayed at full strength while the others faded.
test('net pane hovers fade the current net too (#35)', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  const bFull = await countColor(page, 'F', PALETTE[1], 200);
  expect(bFull).toBeGreaterThan(0);

  await page.locator('#net-results .net-comp-row').first().hover();
  await waitIdle(page);
  expect(await countColor(page, 'F', PALETTE[1], 200)).toBeLessThan(bFull * 0.2);
  await settle(page);

  const link = page.locator('#net-results .walk-link').first();
  expect(await link.count()).toBeGreaterThan(0);
  await link.hover();
  await waitIdle(page);
  expect(await countColor(page, 'F', PALETTE[1], 200)).toBeLessThan(bFull * 0.2);
});

test('deselect clears selection and returns to search', async ({ page }) => {
  await load(page);
  await selectNetFromList(page, frontNets[0]);
  await page.getByRole('button', { name: /Deselect/ }).click();

  const s = await state(page);
  expect(s.selectedNet).toBeNull();
  expect(s.highlightedNet).toBeNull();
  expect(s.highlightedNetPath).toEqual([]);
  expect(s.netFilter).toBe('');
  await expect(page.locator('#net-search-panel')).toBeVisible();
});

// ---- Canvas tooltip ----

// #36: the tooltip is only updated on mousemove over the canvas. Leaving the
// canvas straight from a part or net, with no move over empty board in between,
// left the tooltip up.
test('leaving the canvas from a tooltip spot hides the tooltip (#36)', async ({ page }) => {
  await load(page);
  await page.keyboard.press('f');
  await waitIdle(page);
  const tooltip = page.locator('#canvas-tooltip');
  const box = await page.locator('#frontcanvas').boundingBox();

  // Scan the canvas for a spot that shows the tooltip.
  let hit = false;
  for (let gy = 1; gy < 20 && !hit; gy++) {
    for (let gx = 1; gx < 20 && !hit; gx++) {
      await page.mouse.move(box.x + box.width * gx / 20, box.y + box.height * gy / 20);
      hit = await tooltip.isVisible();
    }
  }
  expect(hit).toBe(true);

  // One step, so the last move on the canvas is the one that showed the tooltip.
  const panel = await page.locator('#left-panel').boundingBox();
  await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
  await expect(tooltip).toBeHidden();
});

// ---- Layers ----

// #3: with F off, the inner layers under it can be clicked.
test('outer copper layers can be turned off (#3)', async ({ page }) => {
  await load(page);
  const layer = innerLayers[0];
  const routed = innerTrack(layer);
  const mid = [(routed.start[0] + routed.end[0]) / 2, (routed.start[1] + routed.end[1]) / 2];
  const hit = () => page.evaluate((m) => netHitScan('F', m[0], m[1]), mid);
  const f = await canvasHash(page, 'F');

  await openLayers(page);
  await layerBox(page, layer, 'all').check();
  await layerBox(page, 'F', 'all').uncheck();
  expect((await state(page)).layers.F.all).toBe(false);
  expect(await canvasHash(page, 'F')).not.toBe(f);
  expect(await hit()).toBe(routed.net);

  await layerBox(page, layer, 'all').uncheck();
  expect(await hit()).toBeNull();
});

// Routed tracks (not vias) on a layer.
function routed(layer) {
  return fixture.pcbdata.tracks[layer].filter(
    (t) => t.net && t.start && !(t.start[0] === t.end[0] && t.start[1] === t.end[1])
  );
}

// A B track can be clicked from the front view, even under a zone on a
// layer nearer the viewed side. Clicks try tracks and pads before zones.
test('far side tracks can be clicked through the board', async ({ page }) => {
  await load(page);
  const fill = innerLayers[0];
  await openLayers(page);
  await layerBox(page, 'F', 'all').uncheck();
  await layerBox(page, fill, 'all').check();

  const spots = routed('B').flatMap((t) => [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => ({
    net: t.net,
    at: [t.start[0] + (t.end[0] - t.start[0]) * f, t.start[1] + (t.end[1] - t.start[1]) * f],
  })));
  const pick = await page.evaluate((spots) => spots.find(
    (s) => netHitScan('F', ...s.at) === null && zoneHitScan('F', ...s.at) !== null
  ), spots);
  expect(pick).toBeDefined();

  await layerBox(page, 'B', 'all').check();
  expect(await page.evaluate((s) => netHitScan('F', ...s.at), pick)).toBe(pick.net);
});

// Where tracks on two inner layers cross, the one nearer the viewed side wins.
test('stacked tracks are picked nearest the viewed side first', async ({ page }) => {
  await load(page);
  expect(innerLayers.length).toBeGreaterThanOrEqual(2);
  const [near, far] = await page.evaluate(() => getInnerLayers().slice(0, 2));
  let cross = null;
  for (const a of routed(near)) {
    for (const b of routed(far)) {
      if (a.net === b.net) continue;
      const [x1, y1] = a.start, [x2, y2] = a.end, [x3, y3] = b.start, [x4, y4] = b.end;
      const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(d) < 1e-9) continue;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
      const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
      if (t < 0.2 || t > 0.8 || u < 0.2 || u > 0.8) continue;
      cross = { at: [x1 + t * (x2 - x1), y1 + t * (y2 - y1)], near: a.net, far: b.net };
      break;
    }
    if (cross) break;
  }
  expect(cross).not.toBeNull();

  await openLayers(page);
  await layerBox(page, 'F', 'all').uncheck();
  await layerBox(page, near, 'all').check();
  await layerBox(page, far, 'all').check();
  const hit = (side) => page.evaluate(([s, p]) => netHitScan(s, ...p), [side, cross.at]);
  expect(await hit('F')).toBe(cross.near);
  expect(await hit('B')).toBe(cross.far);
});

// The B view shows the board from below. With the default table, only F is
// on, so it shows F through the board.
test('the back view shows F through the board by default', async ({ page }) => {
  await load(page);
  await page.keyboard.press('b');
  const withF = await canvasHash(page, 'B');
  await openLayers(page);
  await layerBox(page, 'F', 'all').uncheck();
  expect(await canvasHash(page, 'B')).not.toBe(withF);
  await layerBox(page, 'F', 'all').check();
  expect(await canvasHash(page, 'B')).toBe(withF);
});

// The far side is cached. Its silk must follow the reference toggle without
// a pan or zoom.
test('the far side redraws when references are toggled', async ({ page }) => {
  await load(page);
  await openLayers(page);
  await layerBox(page, 'F', 'all').uncheck();
  await layerBox(page, 'B', 'all').check();
  const withRefs = await canvasHash(page, 'F');
  await page.evaluate(() => referencesVisible(false));
  expect(await canvasHash(page, 'F')).not.toBe(withRefs);
  await page.evaluate(() => referencesVisible(true));
  expect(await canvasHash(page, 'F')).toBe(withRefs);
});

test('zones turn off on their own, tracks stay', async ({ page }) => {
  await load(page);
  // A point inside an F zone, found the same way a click would.
  const pt = await page.evaluate(() => {
    for (const z of pcbdata.zones.F) {
      const pts = (z.polygons || []).flat();
      if (!pts.length) continue;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
        const x = x0 + (x1 - x0) * i / 20, y = y0 + (y1 - y0) * j / 20;
        if (zoneHitScan('F', x, y) !== null) return [x, y];
      }
    }
    return null;
  });
  expect(pt).not.toBeNull();
  const f = await canvasHash(page, 'F');

  await openLayers(page);
  await layerBox(page, 'F', 'zones').uncheck();
  const s = (await state(page)).layers.F;
  expect(s.zones).toBe(false);
  expect(s.tracks).toBe(true);
  expect(await canvasHash(page, 'F')).not.toBe(f);
  expect(await page.evaluate((p) => zoneHitScan('F', p[0], p[1]), pt)).toBeNull();

  await layerBox(page, 'F', 'zones').check();
  expect(await canvasHash(page, 'F')).toBe(f);
});

// Settings saved before the layer table carry over where they map.
test('old saved layer settings are carried over', async ({ page }) => {
  await load(page);
  const layer = innerLayers[0];
  await page.evaluate((layer) => writeStorage('settings', JSON.stringify({
    innerLayerVisibility: { [layer]: true },
    renderSilkscreen: false,
    renderFabrication: true,
    showBackOnFront: true,
  })), layer);
  await page.reload();
  await page.waitForFunction(() => window.__pcbaTest && window.__pcbaTest.ready());
  const s = (await state(page)).layers;
  expect(s[layer].all).toBe(true);
  expect(s.F.all).toBe(true);
  expect(s.B.all).toBe(false);
  for (const l of ['F', 'B']) {
    expect(s[l].silk, l).toBe(false);
    expect(s[l].fab, l).toBe(true);
  }
});

// A row that is off keeps the state of its other boxes.
test('turning a row off and on keeps its other boxes', async ({ page }) => {
  await load(page);
  await openLayers(page);
  await layerBox(page, 'F', 'vias').uncheck();
  await layerBox(page, 'F', 'all').uncheck();
  await expect(page.locator('#layer-table tr[data-layer="F"]')).toHaveClass(/layer-off/);
  await layerBox(page, 'F', 'all').check();
  const s = (await state(page)).layers.F;
  expect(s.vias).toBe(false);
  expect(s.tracks).toBe(true);
});

test('layer filter limits the net list to nets on that layer', async ({ page }) => {
  await load(page);
  await page.locator('#tab-nets').click();
  const all = await page.locator('#net-search-list .net-search-name').count();

  for (const layer of innerLayers) {
    await page.locator(`#layer-filter-bar .layer-filter-btn[data-layer="${layer}"]`).click();
    expect((await state(page)).netLayerFilter).toBe(layer);

    const names = await page.locator('#net-search-list .net-search-name').allTextContents();
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(all);
    const layersPerNet = await page.evaluate(
      (ns) => ns.map((n) => window.__pcbaTest.netLayers(n)),
      names
    );
    for (const ls of layersPerNet) expect(ls).toContain(layer);
  }

  await page.locator('#layer-filter-bar .layer-filter-btn[data-layer="ALL"]').click();
  expect(await page.locator('#net-search-list .net-search-name').count()).toBe(all);
});

test('layer table rows match the fixture, F first and B last', async ({ page }) => {
  await load(page);
  const rows = await page.locator('#layer-table tbody tr')
    .evaluateAll((trs) => trs.map((tr) => tr.dataset.layer));
  expect(rows).toEqual(['F', ...(await state(page)).innerLayers, 'B']);
  expect(rows.slice(1, -1).sort()).toEqual(innerLayers.slice().sort());
  // Silk and fab only on F and B.
  for (const l of rows) {
    const n = await page.locator(`#layer-table tr[data-layer="${l}"] input`).count();
    expect(n, l).toBe(l === 'F' || l === 'B' ? 6 : 4);
  }
});

test('only F is on at first', async ({ page }) => {
  await load(page);
  const s = await state(page);
  for (const l of ['F', ...s.innerLayers, 'B']) expect(s.layers[l].all, l).toBe(l === 'F');
  expect(s.layers.F).toEqual({ all: true, tracks: true, zones: true, vias: true, silk: true, fab: true });
});

// Inner layers are drawn on both the front and the back view, so toggling one
// has to change both. Inner layers start hidden.
test('an inner layer checkbox changes both sides', async ({ page }) => {
  await load(page);
  await page.locator('#btn-layout-fb').click();
  const layer = (await state(page)).innerLayers[0];
  expect((await state(page)).layers[layer].all).toBe(false);
  const f = await canvasHash(page, 'F');
  const b = await canvasHash(page, 'B');

  await openLayers(page);
  const cb = layerBox(page, layer, 'all');
  await cb.check();
  expect((await state(page)).layers[layer].all).toBe(true);
  expect(await canvasHash(page, 'F')).not.toBe(f);
  expect(await canvasHash(page, 'B')).not.toBe(b);

  await cb.uncheck();
  expect((await state(page)).layers[layer].all).toBe(false);
  expect(await canvasHash(page, 'F')).toBe(f);
  expect(await canvasHash(page, 'B')).toBe(b);
});

test('layer badge on a net turns its inner layer back on', async ({ page }) => {
  await load(page);
  const layer = innerLayers[0];
  const routed = innerTrack(layer);
  expect((await state(page)).layers[layer].all).toBe(false);

  await selectNetFromList(page, routed.net);
  await page.locator(`#net-layer-badges button[title="${layer}"]`).click();
  expect((await state(page)).layers[layer].all).toBe(true);
});

// #25: inner layer badges show only the layer number, for KiCad names too.
test('net layer badges show the inner layer number (#25)', async ({ page }) => {
  await load(page);
  const layer = innerLayers[0];
  const routed = fixture.pcbdata.tracks[layer].find((t) => t.net && netToFootprints[t.net]);
  expect(routed).toBeDefined();
  const num = layer.match(/\d+/)[0];

  await selectNetFromList(page, routed.net);
  await expect(page.locator(`#net-layer-badges button[title="${layer}"]`)).toHaveText(num);
});

// ---- Keyboard shortcuts ----

test('F, B and G switch the view', async ({ page }) => {
  await load(page);
  await page.keyboard.press('f');
  expect((await state(page)).canvasLayout).toBe('F');
  await expect(page.locator('#backcanvas-wrap')).toBeHidden();
  await page.keyboard.press('b');
  expect((await state(page)).canvasLayout).toBe('B');
  await expect(page.locator('#frontcanvas-wrap')).toBeHidden();
  await page.keyboard.press('g');
  expect((await state(page)).canvasLayout).toBe('FB');
  await expect(page.locator('#frontcanvas-wrap')).toBeVisible();
  await expect(page.locator('#backcanvas-wrap')).toBeVisible();
});

// S and O work on the side in view; with both in view, on both.
for (const [key, sides] of [['f', ['F']], ['b', ['B']], ['g', ['F', 'B']]]) {
  test(`S and O toggle silkscreen and fabrication in view ${key.toUpperCase()}`, async ({ page }) => {
    await load(page);
    await page.keyboard.press(key);
    const before = (await state(page)).layers;
    await page.keyboard.press('s');
    await page.keyboard.press('o');
    const after = (await state(page)).layers;
    for (const l of ['F', 'B']) {
      const on = sides.includes(l);
      expect(after[l].silk, l).toBe(on ? !before[l].silk : before[l].silk);
      expect(after[l].fab, l).toBe(on ? !before[l].fab : before[l].fab);
    }
    await openLayers(page);
    for (const l of sides) await expect(layerBox(page, l, 'silk')).toBeChecked({ checked: after[l].silk });
  });
}

// X toggles the far side. With both sides in view there is none.
for (const [key, far] of [['f', 'B'], ['b', 'F'], ['g', null]]) {
  test(`X toggles the far side in view ${key.toUpperCase()}`, async ({ page }) => {
    await load(page);
    await page.keyboard.press(key);
    const before = (await state(page)).layers;
    await page.keyboard.press('x');
    let s = (await state(page)).layers;
    for (const l of ['F', 'B']) expect(s[l].all, l).toBe(l === far ? !before[l].all : before[l].all);
    await page.keyboard.press('x');
    s = (await state(page)).layers;
    for (const l of ['F', 'B']) expect(s[l].all, l).toBe(before[l].all);
  });
}

test('number keys toggle inner layers in order', async ({ page }) => {
  await load(page);
  const layers = (await state(page)).innerLayers;
  for (let n = 1; n <= Math.min(layers.length, 10); n++) {
    const layer = layers[n - 1];
    const before = (await state(page)).layers[layer].all;
    await page.keyboard.press(String(n % 10));
    const after = (await state(page)).layers[layer].all;
    expect(after, `key ${n % 10} -> ${layer}`).toBe(!before);
  }
});

test('A turns every layer not in view on, then off', async ({ page }) => {
  await load(page);
  const others = [...(await state(page)).innerLayers, 'B'];
  await page.keyboard.press('a');
  let s = (await state(page)).layers;
  for (const l of others) expect(s[l].all, l).toBe(true);
  expect(s.F.all).toBe(true);
  await page.keyboard.press('a');
  s = (await state(page)).layers;
  for (const l of others) expect(s[l].all, l).toBe(false);
  expect(s.F.all).toBe(true);
});

test('M toggles dark mode', async ({ page }) => {
  await load(page);
  const dark = (await state(page)).darkMode;
  await page.keyboard.press('m');
  expect((await state(page)).darkMode).toBe(!dark);
  await expect(page.locator('#topmostdiv')).toHaveClass(dark ? /^(?!.*\bdark\b)/ : /\bdark\b/);
});

test('? opens help and Escape closes it', async ({ page }) => {
  await load(page);
  await page.keyboard.press('?');
  await expect(page.locator('#help-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-overlay')).toBeHidden();
});

test('N focuses net search, C focuses component search', async ({ page }) => {
  await load(page);
  await page.keyboard.press('n');
  await expect(page.locator('#net-search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await expect(page.locator('#comp-search-input')).toBeFocused();
});

// N focuses the input on the next tick, so wait for focus before typing.
test('shortcuts are ignored while typing in search', async ({ page }) => {
  await load(page);
  const layout = (await state(page)).canvasLayout;
  await page.keyboard.press('n');
  await expect(page.locator('#net-search-input')).toBeFocused();
  await page.keyboard.type('fbg');
  expect((await state(page)).canvasLayout).toBe(layout);
  await expect(page.locator('#net-search-input')).toHaveValue('fbg');
});

test('arrow keys and Enter select a net from the search list', async ({ page }) => {
  await load(page);
  const net = frontNets[0];
  await page.keyboard.press('n');
  await expect(page.locator('#net-search-input')).toBeFocused();
  await page.keyboard.type(net);
  await page.keyboard.press('ArrowDown');
  // The filter also matches nets that only contain the name. The exact match
  // has to be the first row for ArrowDown to land on it.
  await expect(page.locator('#net-search-list .net-search-row.focused .net-search-name')).toHaveText(net);
  await page.keyboard.press('Enter');
  expect((await state(page)).selectedNet).toBe(net);
});

test('Escape deselects', async ({ page }) => {
  await load(page);
  await selectNetFromList(page, frontNets[0]);
  await page.mouse.click(1, 1);
  await page.keyboard.press('Escape');
  const s = await state(page);
  expect(s.selectedNet).toBeNull();
  expect(s.highlightedNetPath).toEqual([]);
});
