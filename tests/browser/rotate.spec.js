// Board rotation in steps of 90 degrees: R and Shift+R, and the two top bar
// buttons. The board is drawn to canvas, so the direction is checked through
// the board point under a screen point, not through pixels.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');

async function load(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready() && window.__pcbaTest.idle(),
    null,
    { timeout: 30000 }
  );
}

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function rotation(page) {
  return (await page.evaluate(() => window.__pcbaTest.state())).boardRotation;
}

// Wheel zoom in at the centre of a side, so the view is no longer fitted.
async function zoomIn(page, side) {
  await page.evaluate((id) => {
    const div = document.getElementById(id);
    const r = div.getBoundingClientRect();
    for (let i = 0; i < 3; i++) {
      div.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true,
      }));
    }
  }, side === 'B' ? 'backcanvas' : 'frontcanvas');
  await waitIdle(page);
}

// Board points at the centre of a side and 50 px above and to the right of it.
async function probe(page, side) {
  return page.evaluate((side) => {
    const div = document.getElementById(side === 'B' ? 'backcanvas' : 'frontcanvas');
    const cx = div.clientWidth / 2, cy = div.clientHeight / 2;
    const at = (x, y) => window.__pcbaTest.boardPoint(side, x, y);
    return { centre: at(cx, cy), up: at(cx, cy - 50), right: at(cx + 50, cy) };
  }, side);
}

function expectClose(a, b) {
  expect(a[0]).toBeCloseTo(b[0], 3);
  expect(a[1]).toBeCloseTo(b[1], 3);
}

test('R and Shift+R rotate in steps of 90 degrees', async ({ page }) => {
  await load(page);
  expect(await rotation(page)).toBe(0);
  await page.keyboard.press('r');
  expect(await rotation(page)).toBe(90);
  await page.keyboard.press('Shift+R');
  await page.keyboard.press('Shift+R');
  expect(await rotation(page)).toBe(270);
  await page.keyboard.press('r');
  expect(await rotation(page)).toBe(0);
});

test('the top bar buttons rotate, and the rotation is saved', async ({ page }) => {
  await load(page);
  await page.click('#btn-rotate-cw');
  expect(await rotation(page)).toBe(90);
  await page.click('#btn-rotate-ccw');
  await page.click('#btn-rotate-ccw');
  expect(await rotation(page)).toBe(270);
  const stored = await page.evaluate(() => window.__pcbaTest.storedSettings());
  expect(stored.boardRotation).toBe(270);
  await load(page);
  expect(await rotation(page)).toBe(270);
});

test('Ctrl+R does not rotate', async ({ page }) => {
  await load(page);
  // Stop the reload so the check runs on the same page.
  await page.evaluate(() => window.addEventListener('keydown', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, true));
  await page.keyboard.press('Control+R');
  expect(await rotation(page)).toBe(0);
});

// Clockwise on screen: what was above the centre is now right of it. The back
// is drawn mirrored, so with only the back in view the angle goes the other
// way to turn the picture clockwise.
for (const [key, side, angle] of [['f', 'F', 90], ['b', 'B', 270]]) {
  test(`R turns view ${key.toUpperCase()} clockwise on screen and keeps the zoomed view`, async ({ page }) => {
    await load(page);
    await page.keyboard.press(key);
    await waitIdle(page);
    await zoomIn(page, side);
    const before = await probe(page, side);
    const boxBefore = await page.evaluate((s) => window.__pcbaTest.viewBox(s), side);

    await page.keyboard.press('r');
    await waitIdle(page);
    expect(await rotation(page)).toBe(angle);
    const after = await probe(page, side);
    expectClose(after.centre, before.centre);
    expectClose(after.right, before.up);

    const boxAfter = await page.evaluate((s) => window.__pcbaTest.viewBox(s), side);
    expect(boxAfter.w).toBeCloseTo(boxBefore.w, 3);
    expect(boxAfter.h).toBeCloseTo(boxBefore.h, 3);
  });
}

// The view after R is the same as the one W fits.
test('a fitted view is fitted again after rotation', async ({ page }) => {
  await load(page);
  await page.keyboard.press('r');
  await waitIdle(page);
  const rotated = await page.evaluate(() => window.__pcbaTest.viewBox('F'));
  await page.keyboard.press('w');
  await waitIdle(page);
  const fitted = await page.evaluate(() => window.__pcbaTest.viewBox('F'));
  for (const k of ['cx', 'cy', 'w', 'h']) expect(rotated[k], k).toBeCloseTo(fitted[k], 3);
});
