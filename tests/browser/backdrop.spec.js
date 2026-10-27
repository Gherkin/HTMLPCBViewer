// The backdrop: the whole board at the fit zoom, under the normal layers, so
// a fast zoom out shows a blurry board at the edges instead of the background.
//
// The zoom out test compares two screenshots taken in the same run, never a
// stored image, and only asks which pixels show board and which show the
// background. GPU differences do not change that.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');
const DOUBLED = 'file://' + path.join(__dirname, 'doubled-outline.html');
const SHAPES = 'file://' + path.join(__dirname, 'outline-shapes.html');
const SHAPES_DOUBLED = 'file://' + path.join(__dirname, 'outline-shapes-doubled.html');
const OFF_ORIGIN = 'file://' + path.join(__dirname, 'off-origin.html');

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function load(page, url = PAGE) {
  await page.goto(url);
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

async function hideBackdrop(page) {
  await page.evaluate(() => { allcanvas.front.backdrop.style.visibility = 'hidden'; });
}

async function backdrops(page) {
  return page.evaluate(() => window.__pcbaTest.counters().backdrops);
}

// A backdrop for the current view is drawn. It is displayed only where the
// buffer does not reach, so this is not the same as being on screen.
async function ready(page) {
  return page.evaluate(() => allcanvas.front._backdropReady === true);
}

function shown(page) {
  return page.evaluate(() => allcanvas.front.backdrop.style.display);
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
  await hideBackdrop(page);
  const without = await fast();
  expect(agreement(without, fit)).toBeLessThan(0.9);
});

// The buffer is see-through outside the board outline. A backdrop under it
// showed there, scaled up and blurred, when the buffer covered the whole view.
test('the backdrop is not shown while the buffer covers the view', async ({ page }) => {
  await load(page);
  expect(await ready(page)).toBe(true);
  expect(await shown(page)).toBe('none');

  await zoomIn(page, 8);
  expect(await shown(page)).toBe('none');

  // A fast zoom out leaves the edges without buffer, and the backdrop shows.
  expect(await page.evaluate(() => {
    const t = allcanvas.front.transform;
    t.zoom = 1; t.panx = 0; t.pany = 0;
    updateCSSTransform(allcanvas.front);
    return allcanvas.front.backdrop.style.display;
  })).toBe('block');

  // The renders catch up and it is hidden again.
  await page.evaluate(() => redrawCanvas(allcanvas.front));
  await waitIdle(page);
  expect(await shown(page)).toBe('none');
});

// After a layer toggle the old backdrop showed outside the board outline
// until the new one came. The first render of the new state covers the view,
// so the old backdrop must be hidden from then on.
test('the old backdrop is not shown after a layer toggle', async ({ page }) => {
  await load(page);
  const first = await backdrops(page);
  // Hold the worker's next backdrop, so only the renders come in.
  await page.evaluate(() => {
    window.__held = null;
    _worker.onmessage = (e) => {
      if (e.data.type === 'backdrop' && !window.__held) window.__held = e;
      else handleWorkerMessage(e);
    };
  });
  await page.keyboard.press('s');
  await page.waitForFunction(() => window.__held !== null, null, { timeout: 30000 });
  expect(await backdrops(page)).toBe(first);
  expect(await shown(page)).toBe('none');

  await page.evaluate(() => {
    _worker.onmessage = handleWorkerMessage;
    handleWorkerMessage(window.__held);
  });
  await waitIdle(page);
  expect(await backdrops(page)).toBe(first + 1);
  expect(await shown(page)).toBe('none');
});

// The worker keeps the backdrop's layer canvases between draws. Cleared under
// the last draw's transform, they kept part of the board at the old rotation.
// Only a board off the positive quadrant shows it. After a few turns the
// backdrop must match one drawn fresh at that rotation.
test('the backdrop shows no old rotation after rotating', async ({ page }) => {
  const backdropOnly = async () => {
    await page.evaluate(() => {
      for (const c of document.querySelectorAll('#frontcanvas canvas')) {
        if (c !== allcanvas.front.backdrop) c.style.visibility = 'hidden';
      }
      // The buffer covers the view, so the backdrop is not displayed.
      allcanvas.front.backdrop.style.display = 'block';
    });
    return boardMask(page);
  };

  await load(page, OFF_ORIGIN);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('r');
    await waitIdle(page);
  }
  const turned = await backdropOnly();
  expect(boardFraction(turned)).toBeGreaterThan(0.05);

  // The rotation is saved, so a reload draws it once with a new worker.
  await load(page, OFF_ORIGIN);
  const fresh = await backdropOnly();
  expect(boardFraction(fresh)).toBeGreaterThan(0.05);
  // The ghost is the thin outline of the island, some hundred pixels, so
  // count them rather than compare the whole view.
  let extra = 0;
  for (let i = 0; i < turned.length; i++) if (turned[i] === '1' && fresh[i] === '0') extra++;
  expect(extra).toBeLessThan(50);
});

// The backdrop at the old rotation showed under the first render of the new
// one, as a second board, until the new backdrop arrived.
test('the old backdrop is hidden while the new rotation is drawn', async ({ page }) => {
  await load(page);
  expect(await ready(page)).toBe(true);

  const first = await backdrops(page);
  expect(await page.evaluate(() => {
    rotateBoard(1);
    return [allcanvas.front.backdrop.style.display, allcanvas.front._backdropReady];
  })).toEqual(['none', false]);
  await waitIdle(page);
  expect(await ready(page)).toBe(true);
  expect(await backdrops(page)).toBe(first + 1);

  // A full turn brings back the old key, and it must still be drawn again.
  for (let i = 0; i < 3; i++) await page.evaluate(() => rotateBoard(1));
  await waitIdle(page);
  expect(await ready(page)).toBe(true);
});

// A new size of the view gives a new fit. The backdrop at the old fit showed
// as a second, larger board until the new one arrived.
test('the old backdrop is hidden when the view changes size', async ({ page }) => {
  // Both sides are drawn from FB on, which takes several seconds a step.
  test.setTimeout(60000);
  await load(page);

  // The window. The resize event comes later, so record whether it was hidden.
  await page.evaluate(() => {
    window.__hidden = false;
    const hide = window.hideBackdrop;
    window.hideBackdrop = (ld) => {
      if (ld === allcanvas.front) window.__hidden = true;
      hide(ld);
    };
  });
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.waitForFunction(() => window.__hidden, null, { timeout: 10000 });
  await waitIdle(page);
  expect(await ready(page)).toBe(true);

  // F to FB, as the G key does.
  expect(await page.evaluate(() => {
    showSide('FB');
    return allcanvas.front._backdropReady;
  })).toBe(false);
  await waitIdle(page);
  expect(await ready(page)).toBe(true);

  // Row to column.
  expect(await page.evaluate(() => {
    setCanvasDirection('column');
    return allcanvas.front._backdropReady;
  })).toBe(false);
  await waitIdle(page);
  expect(await ready(page)).toBe(true);
});

// The same fit keeps the backdrop. A resize to the same size must not hide it.
test('a resize with the same fit keeps the backdrop', async ({ page }) => {
  await load(page);
  expect(await page.evaluate(() => {
    resizeAll();
    return allcanvas.front._backdropReady;
  })).toBe(true);
});

// A backdrop the worker is still drawing when the board turns is for the old
// rotation. It must not be shown when it arrives.
test('a backdrop drawn for the old rotation is dropped', async ({ page }) => {
  await load(page);
  const first = await backdrops(page);
  // Hold the worker's backdrop until the board has turned.
  await page.evaluate(() => {
    window.__held = null;
    _worker.onmessage = (e) => {
      if (e.data.type === 'backdrop' && !window.__held) window.__held = e;
      else handleWorkerMessage(e);
    };
    allcanvas.front._backdropKey = null;
    scheduleBackdrop(allcanvas.front);
  });
  await page.waitForFunction(() => window.__held !== null);
  expect(await page.evaluate(() => {
    rotateBoard(1);
    _worker.onmessage = handleWorkerMessage;
    handleWorkerMessage(window.__held);
    return allcanvas.front._backdropReady;
  })).toBe(false);
  expect(await backdrops(page)).toBe(first);

  await waitIdle(page);
  expect(await ready(page)).toBe(true);
  expect(await backdrops(page)).toBe(first + 1);
});

// Two identical outline loops cancel under the evenodd fill, so the board
// had no fill of its own and only the blurry backdrop showed between the
// copper. With the backdrop hidden, the board must still look the same.
test('an outline listed twice still fills the board', async ({ page }) => {
  await load(page);
  await hideBackdrop(page);
  const single = await boardMask(page);
  expect(boardFraction(single)).toBeGreaterThan(0.3);

  await load(page, DOUBLED);
  await hideBackdrop(page);
  const doubled = await boardMask(page);
  expect(agreement(doubled, single)).toBeGreaterThan(0.97);
});

// Whether the mask shows board at a point in board coordinates. The view is
// at the fit zoom on the front side, so only the fit transform applies.
async function boardAt(page, mask, bx, by) {
  const { x, y, w, h } = await page.evaluate(([bx, by]) => {
    const t = allcanvas.front.transform;
    const c = document.getElementById('frontcanvas');
    return {
      x: Math.round(bx * t.s + t.x), y: Math.round(by * t.s + t.y),
      w: c.clientWidth, h: c.clientHeight,
    };
  }, [bx, by]);
  // The mask rows must be as wide as the canvas and the point inside it,
  // or the index reads some other pixel. The canvas sits at a fractional y,
  // so the screenshot can be one row taller than clientHeight.
  const rows = mask.length / w;
  expect(Number.isInteger(rows) && Math.abs(rows - h) <= 1).toBe(true);
  expect(x >= 0 && x < w && y >= 0 && y < rows).toBe(true);
  return mask[y * w + x] === '1';
}

// The two halves of a circle, or two curves, share their endpoints. If the
// dedup key loses its middle point, one half is dropped as a repeat, the
// loop stays open and that island gets no fill.
test('an outline with arcs and curves listed twice still fills every island', async ({ page }) => {
  const masks = [];
  for (const url of [SHAPES, SHAPES_DOUBLED]) {
    await load(page, url);
    await hideBackdrop(page);
    const mask = await boardMask(page);
    // Off the board, between the islands: no fill, or the checks below say
    // nothing.
    expect(await boardAt(page, mask, 235, 105)).toBe(false);
    expect(await boardAt(page, mask, 235, 80)).toBe(true);
    expect(await boardAt(page, mask, 235, 130)).toBe(true);
    masks.push(mask);
  }
  expect(agreement(masks[1], masks[0])).toBeGreaterThan(0.97);
});
