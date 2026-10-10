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

test('the viewport comes first and the pieces cover the rest of the buffer', async ({ page }) => {
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
  const msgs = await page.evaluate(() => window.__msgs);

  expect(msgs.length).toBeGreaterThan(1);
  const first = msgs[0];
  expect(first.type).toBe('rendered');
  expect(msgs.slice(1).every((m) => m.type === 'piece' && m.gen === first.gen)).toBe(true);
  expect(msgs.map((m) => m.done)).toEqual(msgs.map((_, i) => i === msgs.length - 1));

  // The first rect is the viewport: the buffer less the overscan.
  const { bufW, bufH, overscan } = first;
  expect(first.rect.x).toBe(Math.floor(overscan.x));
  expect(first.rect.y).toBe(Math.floor(overscan.y));
  expect(first.rect.x + first.rect.w).toBe(Math.ceil(bufW - overscan.x));
  expect(first.rect.y + first.rect.h).toBe(Math.ceil(bufH - overscan.y));

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
