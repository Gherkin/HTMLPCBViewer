// Wheel zoom renders during the zoom, not only after the wheel stops.
//
// The wheel events are sent in one page.evaluate, so no worker reply can
// arrive between them and the post counts do not depend on machine speed.
// One step of deltaY 100 zooms by 1.1^2.5, about 1.27x. A render is posted
// once the zoom is more than 1.5x from the last render posted, so on the
// second step.

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

test('wheel zoom posts a render during the zoom and one when it settles', async ({ page }) => {
  await load(page);
  const posts = await page.evaluate(() => {
    const div = document.getElementById('frontcanvas');
    const r = div.getBoundingClientRect();
    const wheel = () => div.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -100,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
    }));
    const count = () => window.__pcbaTest.counters().workerPosts;
    const out = [count()];
    for (let i = 0; i < 3; i++) {
      wheel();
      out.push(count());
    }
    return out;
  });

  // 1.27x: no render yet. 1.61x: render. 2.05x is 1.27x from that: no render.
  expect(posts.slice(1).map((p) => p - posts[0])).toEqual([0, 1, 1]);

  // The settle timer renders the rest. Only that last render is at the final
  // zoom, so it gives the one zoom-to-sharp sample.
  await page.waitForFunction(() => window.__pcbaTest.idle(), null, { timeout: 30000 });
  const after = await page.evaluate(() => ({
    posts: window.__pcbaTest.counters().workerPosts,
    zoomToSharp: window.__pcbaTest.renderStats('F').zoomToSharp,
  }));
  expect(after.posts - posts[0]).toBe(2);
  expect(after.zoomToSharp.count).toBe(1);
});
