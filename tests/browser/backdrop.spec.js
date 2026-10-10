// The backdrop: the whole board at the fit zoom, under the normal layers, so
// a fast zoom out shows a blurry board at the edges instead of the background.
//
// The zoom out test compares two screenshots taken in the same run, never a
// stored image, and only asks which pixels show board and which show the
// background. GPU differences do not change that.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function load(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await page.keyboard.press('f');
  await waitIdle(page);
}

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

async function backdrops(page) {
  return page.evaluate(() => window.__pcbaTest.counters().backdrops);
}

async function center(page) {
  const box = await page.locator('#frontcanvas').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function zoomIn(page, steps) {
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -100);
    await waitIdle(page);
  }
}

// Which pixels of the front canvas show something other than the plain
// background, as a string of 0 and 1.
async function boardMask(page) {
  const png = await page.locator('#frontcanvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = getComputedStyle(document.getElementById('frontcanvas')).backgroundColor;
    probe.fillRect(0, 0, 1, 1);
    const bg = probe.getImageData(0, 0, 1, 1).data;
    let s = '';
    for (let i = 0; i < d.length; i += 4) {
      const diff = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      s += diff > 12 ? '1' : '0';
    }
    return s;
  }, png.toString('base64'));
}

// Fraction of pixels where two masks agree.
function agreement(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

function boardFraction(m) {
  let n = 0;
  for (const ch of m) if (ch === '1') n++;
  return n / m.length;
}

test('the backdrop is drawn after load and not again for pan and zoom', async ({ page }) => {
  await load(page);
  const first = await backdrops(page);
  expect(first).toBeGreaterThan(0);

  await zoomIn(page, 4);
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 200, c.y + 100, { steps: 5 });
  await page.mouse.up();
  await waitIdle(page);

  expect(await backdrops(page)).toBe(first);
});

test('the backdrop is drawn again when a layer is turned off', async ({ page }) => {
  await load(page);
  const first = await backdrops(page);
  await page.keyboard.press('s');
  await waitIdle(page);
  expect(await backdrops(page)).toBe(first + 1);
});

test('a fast zoom out shows the board at the edges', async ({ page }) => {
  await load(page);
  const fit = await boardMask(page);
  // The board fills a good part of the view at the fit zoom, or this test
  // says nothing.
  expect(boardFraction(fit)).toBeGreaterThan(0.3);

  // Zoom in far enough that the buffer covers well under the whole board.
  await zoomIn(page, 8);

  // Zoom back out to fit without rendering, as when the wheel is faster than
  // the worker. Only the CSS transforms move.
  const fast = async () => {
    await page.evaluate(() => {
      const t = allcanvas.front.transform;
      t.zoom = 1; t.panx = 0; t.pany = 0;
      updateCSSTransform(allcanvas.front);
    });
    return boardMask(page);
  };
  const withBackdrop = await fast();
  expect(agreement(withBackdrop, fit)).toBeGreaterThan(0.97);

  // Without the backdrop the edges are background, so the check above means
  // something.
  await page.evaluate(() => { allcanvas.front.backdrop.style.visibility = 'hidden'; });
  const without = await fast();
  expect(agreement(without, fit)).toBeLessThan(0.9);
});
