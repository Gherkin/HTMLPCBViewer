// The favicon is inlined into the generated HTML as a data URI.  Check that
// the placeholder was replaced and that the browser can decode the result.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.join(__dirname, 'board.html');

test('the inlined favicon decodes as an image', async ({ page }) => {
  await page.goto(PAGE);
  const href = await page.$eval('link[rel="icon"]', (l) => l.getAttribute('href'));
  expect(href.startsWith('data:image/svg+xml,')).toBe(true);
  const size = await page.evaluate((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => resolve(null);
    img.src = src;
  }), href);
  expect(size).toEqual([32, 32]);
});
