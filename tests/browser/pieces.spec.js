// A render shows the viewport first, then fills the overscan around it in
// pieces. The worker messages of one render are recorded and checked: the
// viewport comes first, the pieces follow, and together they cover the buffer
// once.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function waitIdle(page) {
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
}

// The front side's worker messages of one full render.
async function recordRender(page) {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await waitIdle(page);

  await page.evaluate(() => {
    window.__msgs = [];
    _worker.addEventListener('message', (e) => {
      const m = e.data;
      if (m.side !== 'F' || (m.type !== 'rendered' && m.type !== 'piece')) return;
      window.__msgs.push({
        type: m.type, gen: m.gen, rect: m.rect, done: m.done,
        bufW: m.bufW, bufH: m.bufH, overscan: m.overscan,
      });
    });
    renderBuffers(allcanvas.front);
  });
  await waitIdle(page);
  return page.evaluate(() => window.__msgs);
}

test('the viewport comes first and the pieces cover the rest of the buffer', async ({ page }) => {
  const msgs = await recordRender(page);

  expect(msgs.length).toBeGreaterThan(1);
  const first = msgs[0];
  expect(first.type).toBe('rendered');
  expect(msgs.slice(1).every((m) => m.type === 'piece' && m.gen === first.gen)).toBe(true);
  expect(msgs.map((m) => m.done)).toEqual(msgs.map((_, i) => i === msgs.length - 1));

  // The first rect is the viewport, at the overscan. The overscan is whole
  // pixels, so the buffer sits on the screen pixels.
  const { bufW, bufH, overscan } = first;
  const vp = await page.evaluate(() => {
    const div = document.getElementById('frontcanvas');
    return { w: div.clientWidth * devicePixelRatio, h: div.clientHeight * devicePixelRatio };
  });
  expect(Number.isInteger(overscan.x) && Number.isInteger(overscan.y)).toBe(true);
  expect(first.rect).toEqual({ x: overscan.x, y: overscan.y, w: vp.w, h: vp.h });

  // No piece is more than half the viewport along either axis, or 256 px if
  // that is larger, however large the overscan, so a new render never waits
  // long behind one.
  const vpW = first.rect.w, vpH = first.rect.h;
  for (const { rect } of msgs.slice(1)) {
    expect(rect.w).toBeLessThanOrEqual(Math.max(Math.ceil(vpW / 2), 256));
    expect(rect.h).toBeLessThanOrEqual(Math.max(Math.ceil(vpH / 2), 256));
  }

  // Every buffer pixel is in exactly one rect.
  const cover = new Uint8Array(bufW * bufH);
  for (const { rect } of msgs) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) cover[y * bufW + x]++;
    }
  }
  expect(cover.every((c) => c === 1)).toBe(true);
});

test.describe('a small viewport', () => {
  test.use({ viewport: { width: 640, height: 480 } });

  test('gets no more pieces than 256 px steps give', async ({ page }) => {
    const msgs = await recordRender(page);
    const { bufW, bufH } = msgs[0];

    // With 256 px steps an axis has at most ceil(bufW / 256) + 3 intervals.
    // Half-viewport steps give more here.
    const most = (Math.ceil(bufW / 256) + 3) * (Math.ceil(bufH / 256) + 3);
    expect(msgs.length - 1).toBeLessThanOrEqual(most);
  });
});

test('the old buffer stays in the overscan until the pieces arrive', async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await waitIdle(page);
  const box = await page.locator('#frontcanvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -100);
    await waitIdle(page);
  }

  // Drop every worker message after the next viewport, so its pieces never
  // come.
  await page.evaluate(() => {
    const orig = _worker.onmessage;
    window.__held = false;
    _worker.onmessage = (e) => {
      if (window.__held) return;
      orig(e);
      if (e.data.type === 'rendered' && e.data.side === 'F') window.__held = true;
    };
  });
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => window.__held);

  // Just above the viewport is overscan the old buffer had drawn. The board
  // fill there is opaque.
  const alpha = await page.evaluate(() => {
    const os = allcanvas.front._overscan;
    const c = allcanvas.front.bg;
    const x = Math.round(c.width / 2), y = Math.round(os.y * 0.8);
    return c.getContext('2d').getImageData(x, y, 1, 1).data[3];
  });
  expect(alpha).toBe(255);
});

// Firefox draws the edges of the moved image partly see-through; Chromium
// does not.
test('the old buffer leaves no partly see-through line at its edges @firefox', async ({ page }) => {
  // A large board zoomed in, so the edges of the old image are on the board.
  await page.goto('file://' + path.join(__dirname, 'ciaa-acc.html'));
  await page.waitForFunction(
    () => window.__pcbaTest && window.__pcbaTest.ready(),
    null,
    { timeout: 30000 }
  );
  await waitIdle(page);
  const box = await page.locator('#frontcanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -100);
    await waitIdle(page);
  }

  // Zoom out one step, keep the carry and drop the pieces.
  await page.evaluate(() => {
    const orig = _worker.onmessage;
    window.__held = false;
    _worker.onmessage = (e) => {
      if (window.__held) return;
      orig(e);
      if (e.data.type === 'rendered' && e.data.side === 'F') window.__held = true;
    };
    const move = moveCanvas;
    moveCanvas = function (c, m) {
      if (c === allcanvas.front.bg) window.__carry = m;
      return move.apply(this, arguments);
    };
  });
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => window.__held);

  // The old image is smaller than the buffer now, and its edges fall between
  // pixels. The rows and columns they cross must be either old image or
  // empty, not a line of partly see-through pixels.
  const lines = await page.evaluate(() => {
    const m = window.__carry, c = allcanvas.front.bg, ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const at = { top: m.dy, bottom: m.dy + m.k * h, left: m.dx, right: m.dx + m.k * w };
    const out = { k: m.k };
    for (const side in at) {
      const v = Math.floor(at[side]), row = side === 'top' || side === 'bottom';
      const d = row ? ctx.getImageData(0, v, w, 1).data : ctx.getImageData(v, 0, 1, h).data;
      let part = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) part++;
      out[side] = { at: at[side], part };
    }
    return out;
  });
  expect(lines.k).toBeLessThan(1);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    expect(lines[side].part, side + ' edge at ' + lines[side].at).toBeLessThan(20);
  }
});
