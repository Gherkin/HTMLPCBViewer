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

  // No piece is more than half the viewport along either axis, however large
  // the overscan, so a new render never waits long behind one.
  const vpW = first.rect.w, vpH = first.rect.h;
  for (const { rect } of msgs.slice(1)) {
    expect(rect.w).toBeLessThanOrEqual(Math.ceil(vpW / 2));
    expect(rect.h).toBeLessThanOrEqual(Math.ceil(vpH / 2));
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
