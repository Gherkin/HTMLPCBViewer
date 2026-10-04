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

// Hovering a list row is a temporary highlight that replaces the selection
// until the mouse leaves. A click leaves the cursor on a row, so move it to
// the title before reading state, the way a user moves on after clicking.
async function settle(page) {
  const box = await page.locator('#meta-title').boundingBox();
  await page.mouse.move(box.x + 2, box.y + 2);
  await waitIdle(page);
}

// Count pixels on a side's highlight canvas that are close to a colour.
async function countColor(page, side, hex) {
  await waitIdle(page);
  return page.evaluate(({ side, hex }) => {
    const c = document.getElementById(side + '_hl');
    if (!c || !c.width || !c.height) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 64) continue;
      if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30) n++;
    }
    return n;
  }, { side, hex });
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

// #1: the nets are still in the breadcrumbs, but the canvas shows only the
// component. netWalkHistory keeps both nets while highlightedNetPath ends up
// empty after the mouse passes over a component row.
test('highlighting a component after nets keeps the nets highlighted (#1)', async ({ page }) => {
  test.fail(true, 'Known bug #1');
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

// ---- Layers ----

// #3: there is no control for the outer copper layers yet, so there is
// nothing to click. Write this once the checkbox exists.
test.fixme('outer copper layers can be turned off (#3)', async () => {});

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

test('inner layer checkboxes match the fixture', async ({ page }) => {
  await load(page);
  const labels = await page.locator('#inner-layer-toggles label').allTextContents();
  expect(labels.map((l) => l.trim()).sort()).toEqual(innerLayers.slice().sort());
});

// Inner layers are drawn on both the front and the back view, so toggling one
// has to change both. Inner layers start hidden.
test('an inner layer checkbox changes both sides', async ({ page }) => {
  await load(page);
  await page.locator('#btn-layout-fb').click();
  const layer = (await state(page)).innerLayers[0];
  expect((await state(page)).innerLayerVisibility[layer]).toBe(false);
  const f = await canvasHash(page, 'F');
  const b = await canvasHash(page, 'B');

  await page.locator('#inner-layers-menu .menu-btn').hover();
  const cb = page.locator('#inner-layer-toggles label', { hasText: layer }).locator('input');
  await cb.check();
  expect((await state(page)).innerLayerVisibility[layer]).toBe(true);
  expect(await canvasHash(page, 'F')).not.toBe(f);
  expect(await canvasHash(page, 'B')).not.toBe(b);

  await cb.uncheck();
  expect((await state(page)).innerLayerVisibility[layer]).toBe(false);
  expect(await canvasHash(page, 'F')).toBe(f);
  expect(await canvasHash(page, 'B')).toBe(b);
});

test('layer badge on a net turns its inner layer back on', async ({ page }) => {
  await load(page);
  const layer = innerLayers[0];
  const routed = fixture.pcbdata.tracks[layer].find(
    (t) => t.net && netToFootprints[t.net] &&
      !(t.start && t.start[0] === t.end[0] && t.start[1] === t.end[1])
  );
  expect(routed).toBeDefined();

  await page.locator('#inner-layers-menu .menu-btn').hover();
  await page.locator('#inner-layer-toggles label', { hasText: layer }).locator('input').uncheck();
  await page.mouse.move(0, 0);
  expect((await state(page)).innerLayerVisibility[layer]).toBe(false);

  await selectNetFromList(page, routed.net);
  await page.locator(`#net-layer-badges button[title="${layer}"]`).click();
  expect((await state(page)).innerLayerVisibility[layer]).toBe(true);
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

test('S and O toggle silkscreen and fabrication', async ({ page }) => {
  await load(page);
  const silk = await page.locator('#cb-silk').isChecked();
  const fab = await page.locator('#cb-fab').isChecked();
  await page.keyboard.press('s');
  await expect(page.locator('#cb-silk')).toBeChecked({ checked: !silk });
  await page.keyboard.press('o');
  await expect(page.locator('#cb-fab')).toBeChecked({ checked: !fab });
});

// X toggles the see-through for the side(s) in view.
for (const [key, bonf, fonb] of [['f', true, false], ['b', false, true], ['g', true, true]]) {
  test(`X toggles see-through in view ${key.toUpperCase()}`, async ({ page }) => {
    await load(page);
    await page.keyboard.press(key);
    await page.keyboard.press('x');
    await expect(page.locator('#cb-back-on-front')).toBeChecked({ checked: bonf });
    await expect(page.locator('#cb-front-on-back')).toBeChecked({ checked: fonb });
    await page.keyboard.press('x');
    await expect(page.locator('#cb-back-on-front')).not.toBeChecked();
    await expect(page.locator('#cb-front-on-back')).not.toBeChecked();
  });
}

test('number keys toggle inner layers in order', async ({ page }) => {
  await load(page);
  const layers = (await state(page)).innerLayers;
  for (let n = 1; n <= Math.min(layers.length, 10); n++) {
    const layer = layers[n - 1];
    const before = (await state(page)).innerLayerVisibility[layer];
    await page.keyboard.press(String(n % 10));
    const after = (await state(page)).innerLayerVisibility[layer];
    expect(after, `key ${n % 10} -> ${layer}`).toBe(!before);
  }
});

test('A turns all inner layers on, then off', async ({ page }) => {
  await load(page);
  const layers = (await state(page)).innerLayers;
  await page.keyboard.press('a');
  let vis = (await state(page)).innerLayerVisibility;
  for (const l of layers) expect(vis[l]).toBe(true);
  await page.keyboard.press('a');
  vis = (await state(page)).innerLayerVisibility;
  for (const l of layers) expect(vis[l]).toBe(false);
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
