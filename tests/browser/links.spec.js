// Link tests (#13). The URL hash holds the selection. The share menu adds the
// view and the layers. A link applies its view and layers for that visit only.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'netdaq-small.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const footprints = fixture.pcbdata.footprints;

const netToFootprints = {};
footprints.forEach((fp, i) => {
  for (const p of fp.pads || []) {
    if (!p.net) continue;
    (netToFootprints[p.net] = netToFootprints[p.net] || new Set()).add(i);
  }
});
const allNets = Object.keys(netToFootprints).sort();
const frontNets = allNets.filter((n) => {
  const fps = [...netToFootprints[n]];
  return fps.length >= 2 && fps.length <= 6 && fps.some((i) => footprints[i].layer === 'F');
});
const frontParts = footprints.map((fp, i) => i).filter((i) => footprints[i].layer === 'F');

const innerLayers = [...new Set(
  ['tracks', 'zones'].flatMap((s) => Object.keys(fixture.pcbdata[s] || {}))
)].filter((l) => l !== 'F' && l !== 'B');

// A net with real tracks on an inner layer.
const innerLayer = innerLayers[0];
const innerNet = fixture.pcbdata.tracks[innerLayer].find(
  (t) => t.net && netToFootprints[t.net] &&
    !(t.start && t.start[0] === t.end[0] && t.start[1] === t.end[1])
).net;

function hashOf(pairs) {
  return '#' + pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

async function load(page, hash = '') {
  // Going to the same file with only a new hash does not reload the page.
  await page.goto('about:blank');
  await page.goto(PAGE + hash);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  // A link may open the Nets tab, so the rows can be hidden.
  await page.locator('#comp-tbody .comp-row').first().waitFor({ state: 'attached' });
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

async function storedSettings(page) {
  return page.evaluate(() => window.__pcbaTest.storedSettings());
}

async function currentHash(page) {
  return page.evaluate(() => window.location.hash);
}

function parseHash(hash) {
  return hash.replace(/^#/, '').split('&').filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
  });
}

async function settle(page) {
  const box = await page.locator('#meta-title').boundingBox();
  await page.mouse.move(box.x + 2, box.y + 2);
  await waitIdle(page);
}

async function selectNetFromList(page, net) {
  await page.locator('#tab-nets').click();
  if (await page.locator('#net-detail-panel').isVisible()) {
    await page.locator('#net-back-btn').click();
  }
  await page.locator('#net-search-input').fill(net);
  await page.locator('#net-search-list .net-search-row', {
    has: page.locator('.net-search-name', { hasText: new RegExp('^' + escapeRe(net) + '$') }),
  }).click();
  await settle(page);
}

async function clickPart(page, idx) {
  await page.locator('#tab-components').click();
  await page.locator(`#comp-tbody .comp-row[data-idx="${idx}"]`).click();
  await settle(page);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectBoxClose(a, b) {
  for (const k of ['cx', 'cy', 'w', 'h']) expect(a[k]).toBeCloseTo(b[k], 1);
}

async function shareLink(page, { view = false, layers = false, zoom = '' } = {}) {
  await page.locator('#btn-share').hover();
  await page.locator('#cb-link-view').setChecked(view);
  await page.locator('#cb-link-layers').setChecked(layers);
  if (!view) await page.locator(`input[name=link-zoom][value="${zoom}"]`).check();
  // The box is rebuilt async on each change; wait for the last build.
  await page.evaluate(() => updateShareLink());
  await page.locator('#btn-copy-link').click();
  return page.locator('#share-link-text').inputValue();
}

function hashFromLink(link) {
  return link.slice(link.indexOf('#'));
}

test('fixture has what these tests need', () => {
  expect(frontNets.length).toBeGreaterThanOrEqual(2);
  expect(frontParts.length).toBeGreaterThanOrEqual(2);
  expect(innerNet).toBeDefined();
});

test('the hash holds every pinned part and walked net, in order', async ({ page }) => {
  await load(page);
  const [a, b] = frontNets;
  const [p, q] = frontParts;
  await clickPart(page, p);
  await selectNetFromList(page, a);
  await clickPart(page, q);
  await selectNetFromList(page, b);

  expect(parseHash(await currentHash(page))).toEqual([
    ['comp', footprints[p].ref], ['net', a], ['comp', footprints[q].ref], ['net', b],
  ]);
});

test('a link restores the selection with the same colours', async ({ page, browser }) => {
  await load(page);
  const [a, b] = frontNets;
  const [p, q] = frontParts;
  await clickPart(page, p);
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  await clickPart(page, q);
  const want = await state(page);
  const hash = await currentHash(page);

  const other = await browser.newPage();
  await load(other, hash);
  const got = await state(other);
  expect(got.selection).toEqual(want.selection);
  expect(got.selectedFootprintIdx).toBe(want.selectedFootprintIdx);
  expect(got.selectedNet).toBe(want.selectedNet);
  expect(got.highlightedNetPath).toEqual(want.highlightedNetPath);
  await other.close();
});

test('the focused net is kept when it is not the last one walked', async ({ page, browser }) => {
  await load(page);
  const [a, b] = frontNets;
  await selectNetFromList(page, a);
  await selectNetFromList(page, b);
  await page.locator('#breadcrumb-bar .breadcrumb-item', { hasText: a }).click();
  await settle(page);
  const want = await state(page);
  const hash = await currentHash(page);
  expect(parseHash(hash)).toContainEqual(['focus', 'net:' + a]);

  const other = await browser.newPage();
  await load(other, hash);
  const s = await state(other);
  expect(s.selectedNet).toBe(a);
  expect(s.highlightedNetPath).toEqual(want.highlightedNetPath);
  await other.close();
});

test('deselect clears the hash', async ({ page }) => {
  await load(page);
  await selectNetFromList(page, frontNets[0]);
  expect(await currentHash(page)).not.toBe('');
  await page.keyboard.press('Escape');
  expect(await currentHash(page)).toBe('');
});

test('old #component= and #net= links still work', async ({ page }) => {
  await load(page);
  const board = await viewBox(page, 'F');
  const idx = frontParts[0];
  await load(page, '#component=' + encodeURIComponent(footprints[idx].ref));
  let s = await state(page);
  expect(s.selectedFootprintIdx).toBe(idx);
  expect(s.selection.map((e) => e.value)).toEqual([footprints[idx].ref]);
  // An old component link zooms to the part.
  expect((await viewBox(page, 'F')).w).toBeLessThan(board.w / 2);

  await load(page, hashOf([['net', frontNets[0]]]));
  s = await state(page);
  expect(s.selectedNet).toBe(frontNets[0]);
});

test('unknown parts and nets in a link are skipped', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page, hashOf([['comp', 'NOPE999'], ['net', 'no such net'], ['net', frontNets[0]]]));
  const s = await state(page);
  expect(s.selectedNet).toBe(frontNets[0]);
  expect(s.selection.map((e) => e.value)).toEqual([frontNets[0]]);
  expect(errors).toEqual([]);
});

test('a link sets side and layers for this visit only', async ({ page }) => {
  await load(page);
  const before = await state(page);
  expect(before.canvasLayout).not.toBe('B');
  expect(before.innerLayerVisibility[innerLayer]).toBe(false);

  await load(page, hashOf([
    ['side', 'B'], ['layers', innerLayer], ['xray', 'front-on-back'], ['overlay', 'silk'],
  ]));
  const s = await state(page);
  expect(s.canvasLayout).toBe('B');
  expect(s.innerLayerVisibility[innerLayer]).toBe(true);
  expect(s.showFrontOnBack).toBe(true);
  expect(s.renderSilkscreen).toBe(true);
  expect(s.renderFabrication).toBe(false);
  await page.locator('#inner-layers-menu .menu-btn').hover();
  await expect(page.locator('#inner-layer-toggles label', { hasText: innerLayer }).locator('input')).toBeChecked();
  await expect(page.locator('#cb-front-on-back')).toBeChecked();

  // A change the user makes is saved; the link's settings are not.
  await page.mouse.move(0, 0);
  await page.keyboard.press('o');
  const stored = await storedSettings(page);
  expect(stored.renderFabrication).toBe(true);
  expect(stored.canvaslayout).toBe(before.canvasLayout);
  expect(stored.renderSilkscreen).toBe(false);
  expect(stored.showFrontOnBack).toBe(false);
  expect(stored.innerLayerVisibility[innerLayer]).toBe(false);

  // A setting the link set is saved once the user changes it.
  await page.keyboard.press('g');
  expect((await storedSettings(page)).canvaslayout).toBe('FB');
});

test('netlayers=1 turns on the layers of the linked nets', async ({ page }) => {
  await load(page, hashOf([['net', innerNet], ['layers', ''], ['netlayers', '1']]));
  const s = await state(page);
  expect(s.selectedNet).toBe(innerNet);
  expect(s.innerLayerVisibility[innerLayer]).toBe(true);
});

test('a link with the current view opens on the same area', async ({ page, browser }) => {
  await load(page);
  await page.keyboard.press('g');
  await selectNetFromList(page, frontNets[0]);
  const front = page.locator('#frontcanvas');
  const box = await front.boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.wheel(0, -400);
  await waitIdle(page);
  const wantF = await viewBox(page, 'F');
  const wantB = await viewBox(page, 'B');

  const link = await shareLink(page, { view: true });
  expect(link).toContain('side=FB');
  expect(link).toContain('viewF=');
  expect(link).toContain('viewB=');

  const other = await browser.newPage();
  await load(other, hashFromLink(link));
  expect((await state(other)).canvasLayout).toBe('FB');
  expectBoxClose(await viewBox(other, 'F'), wantF);
  expectBoxClose(await viewBox(other, 'B'), wantB);
  await other.close();
});

test('a link with a preset zoom applies it', async ({ page }) => {
  await load(page);
  const board = await viewBox(page, 'F');
  const idx = frontParts[0];
  const ref = footprints[idx].ref;

  // zoom=board overrides the old zoom-to-part.
  await load(page, hashOf([['comp', ref], ['zoom', 'board']]));
  expectBoxClose(await viewBox(page, 'F'), board);

  await load(page, hashOf([['comp', ref], ['zoom', 'highlight']]));
  expect((await viewBox(page, 'F')).w).toBeLessThan(board.w / 2);
});

test('the share menu adds view and layers only when asked', async ({ page }) => {
  await load(page);
  await selectNetFromList(page, frontNets[0]);

  let link = await shareLink(page);
  expect(parseHash(hashFromLink(link))).toEqual([['net', frontNets[0]]]);

  link = await shareLink(page, { zoom: 'selected' });
  expect(link).toContain('zoom=selected');

  link = await shareLink(page, { layers: true });
  expect(link).toContain('layers=&');
  expect(link).toContain('xray=&');
  expect(link).toContain('overlay=fab');
  expect(link).not.toContain('side=');

  // A preset zoom does not apply when the link carries the view.
  link = await shareLink(page, { view: true });
  expect(link).not.toContain('zoom=');
  await expect(page.locator('input[name=link-zoom]').first()).toBeDisabled();
});

test('a long selection is compressed into z= and restores', async ({ page, browser }) => {
  // Every net plus some parts is well past the 1500 character limit.
  const pairs = allNets.map((n) => ['net', n]).concat(frontParts.slice(0, 20).map((i) => ['comp', footprints[i].ref]));
  await load(page, hashOf(pairs));
  const want = await state(page);
  expect(want.selection.length).toBe(pairs.length);

  // Any selection rewrites the hash, compressed this time. 76 breadcrumbs
  // cover the part list, so select the current net again from the last one.
  await page.locator('#breadcrumb-bar .breadcrumb-item').last().click();
  await expect.poll(() => currentHash(page)).toMatch(/^#z=[A-Za-z0-9_-]+$/);
  const hash = await currentHash(page);
  const after = await state(page);

  const other = await browser.newPage();
  await load(other, hash);
  const got = await state(other);
  expect(got.selection.map((e) => e.value)).toEqual(after.selection.map((e) => e.value));
  expect(got.selectedFootprintIdx).toBe(after.selectedFootprintIdx);
  await other.close();
});
