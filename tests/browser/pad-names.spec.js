// Pad labels in the canvas tooltip and the detail pane's pad table.
// netdaq-small has a KiCad pad name on every pad, so a pad shows as the pin
// the netlist names (U24:11 is "pin 11"). ciaa-acc has no names, so its pads
// keep the old "pad N", N being the place in the footprint's pad list.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BOARDS = {
  named: {
    page: 'file://' + path.join(__dirname, 'board.html'),
    fixture: path.join(__dirname, '..', 'fixtures', 'netdaq-small.json'),
  },
  unnamed: {
    page: 'file://' + path.join(__dirname, 'ciaa-acc.html'),
    fixture: path.join(__dirname, '..', 'fixtures', 'ciaa-acc.json'),
  },
};

function footprint(board, ref) {
  const data = JSON.parse(fs.readFileSync(BOARDS[board].fixture, 'utf8'));
  return data.pcbdata.footprints.find((fp) => fp.ref === ref);
}

async function load(page, board, ref) {
  await page.goto('about:blank');
  await page.goto(BOARDS[board].page + `#comp=${ref}&side=F&zoom=selected`);
  await page.waitForFunction(() => window.__pcbaTest && window.__pcbaTest.ready(), null, { timeout: 60000 });
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 60000 });
}

// Move the pointer onto a front board point and return the tooltip text.
async function hover(page, [x, y]) {
  const v = await page.evaluate(() => window.__pcbaTest.viewBox('F'));
  const box = await page.locator('#frontcanvas').boundingBox();
  const fx = 0.5 + (x - v.cx) / v.w;
  const fy = 0.5 + (y - v.cy) / v.h;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  const tooltip = page.locator('#canvas-tooltip');
  await expect(tooltip).toBeVisible();
  return tooltip.innerText();
}

async function padTableNumbers(page) {
  return page.locator('#detail-pane .pad-table tr td:first-child').allInnerTexts();
}

test('named board: hovering a pad shows its pin name, not its place in the list', async ({ page }) => {
  const fp = footprint('named', 'U24');
  // ibom sorts pads by name as text, so the third pad is pin 11.
  expect(fp.pads[2].name).toBe('11');
  await load(page, 'named', 'U24');

  const text = await hover(page, fp.pads[2].pos);
  expect(text).toContain('U24');
  expect(text).toContain('pin 11');
  expect(text).not.toContain('pad 3');

  const pin1 = fp.pads.find((p) => p.pin1);
  expect(await hover(page, pin1.pos)).toContain('pin ' + pin1.name);

  expect(await padTableNumbers(page)).toEqual(fp.pads.map((p) => p.name));
  // The first column holds pin names, so its header says so.
  expect(await page.locator('#detail-pane .pad-table th').allInnerTexts()).toEqual(['Pin', 'Net', 'Type']);
});

test('unnamed board: hovering a pad still shows pad N', async ({ page }) => {
  test.setTimeout(120000);
  const fp = footprint('unnamed', 'U46');
  expect(fp.pads.every((p) => p.name === undefined)).toBe(true);
  expect(fp.pads[3].pin1).toBeFalsy();
  await load(page, 'unnamed', 'U46');

  const text = await hover(page, fp.pads[3].pos);
  expect(text).toContain('U46');
  expect(text).toContain('pad 4');
  expect(text).not.toContain('pin 4');

  expect(await padTableNumbers(page)).toEqual(fp.pads.map((p, i) => String(i + 1)));
  // Same header as on a named board, even though the column holds list places.
  expect(await page.locator('#detail-pane .pad-table th').allInnerTexts()).toEqual(['Pin', 'Net', 'Type']);
});

// Allegro writes a through-hole pin as two pads at one pos: F "th" and B
// "smd", both with the pin name. The pad table shows each pin once.
test('pad table: an Allegro through-hole pin pair is one row', async ({ page }) => {
  await load(page, 'named', 'U24');
  const rows = await page.evaluate(() => {
    const idx = pcbdata.footprints.findIndex((f) => f.ref === 'U24');
    const fp = pcbdata.footprints[idx];
    const [a, b] = fp.pads;
    const pair = (pad, name, net) => [
      { ...pad, layers: ['F'], type: 'th', name, net },
      { ...pad, layers: ['B'], type: 'smd', name, net },
    ];
    fp.pads = [...pair(a, '1', 'N1'), ...pair(b, '2', 'N2')];
    renderDetailPane(idx);
    return [...document.querySelectorAll('#detail-pane .pad-table tr')].slice(1)
      .map((tr) => [...tr.children].map((td) => td.innerText));
  });
  expect(rows).toEqual([['1', 'N1', 'th'], ['2', 'N2', 'th']]);
});

// A KiCad EP with a through-hole thermal pad in its center, both on GND,
// is two rows: only an F pad and a B pad make a pair.
test('pad table: an SMD pad and a through-hole pad at one point are two rows', async ({ page }) => {
  await load(page, 'named', 'U24');
  const rows = await page.evaluate(() => {
    const idx = pcbdata.footprints.findIndex((f) => f.ref === 'U24');
    const fp = pcbdata.footprints[idx];
    const [a] = fp.pads;
    fp.pads = [
      { ...a, layers: ['F'], type: 'smd', name: 'EP', net: 'GND' },
      { ...a, layers: ['F', 'B'], type: 'th', name: 'EP', net: 'GND' },
    ];
    renderDetailPane(idx);
    return [...document.querySelectorAll('#detail-pane .pad-table tr')].slice(1)
      .map((tr) => [...tr.children].map((td) => td.innerText));
  });
  expect(rows).toEqual([['EP', 'GND', 'smd'], ['EP', 'GND', 'th']]);
});

test('the tooltip shows a pad name as text, not markup', async ({ page }) => {
  await load(page, 'named', 'U24');
  const fp = footprint('named', 'U24');
  await page.evaluate(() => {
    const fp = pcbdata.footprints.find((f) => f.ref === 'U24');
    fp.pads[2].name = '<b>X</b>';
  });
  const text = await hover(page, fp.pads[2].pos);
  expect(text).toContain('pin <b>X</b>');
});
