// Headless Chromium for the snapshot tool.
//
// One browser for the whole process, started on the first snapshot and
// started again if it dies. Each snapshot gets its own browser context (a
// fresh profile: no cookies, no stored viewer settings) and closes it after.
// A context costs a few ms; a browser start costs a second or more.
//
// At most MAX_RUNNING snapshots draw at once and at most MAX_WAITING wait
// for a turn. One more is a tool error ("busy"), so one agent cannot make
// the server queue work without end. Each snapshot has TIMEOUT_MS in all,
// waiting time included.
//
// Chromium runs without its sandbox (Playwright's default): the container is
// the boundary, and the page only ever loads from the viewer address; every
// other request is blocked. --disable-dev-shm-usage keeps it off /dev/shm,
// which is 64 MB in Docker by default.

import { chromium } from 'playwright-core';
import { BoardError } from './boards.js';

export const MAX_RUNNING = 2;
export const MAX_WAITING = 4;
export const TIMEOUT_MS = 30000;

// The viewer sets this up (window.__pcbaTest in web/app.js): ready() once
// the board is loaded and the link applied, idle() once no render is in
// flight or scheduled, overscan pieces and backdrop included. The browser
// tests wait on the same two.
function viewerDone() {
  const t = window.__pcbaTest;
  return !!(t && t.ready() && t.idle());
}

export function createBrowser({ launch = () => chromium.launch({ args: ['--disable-dev-shm-usage'] }) } = {}) {
  let browser;
  let running = 0;
  const waiting = [];

  function getBrowser() {
    if (!browser) {
      // Clear only this launch: a browser that goes away late must not
      // drop a newer one.
      const started = launch().then(
        (b) => {
          b.on('disconnected', () => {
            if (browser === started) browser = undefined;
          });
          return b;
        },
        (err) => {
          if (browser === started) browser = undefined;
          throw err;
        }
      );
      browser = started;
    }
    return browser;
  }

  async function turn(deadline) {
    if (running < MAX_RUNNING) {
      running++;
      return;
    }
    if (waiting.length >= MAX_WAITING) {
      throw new BoardError('The snapshot server is busy. Try again in a few seconds.');
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve };
      waiting.push(entry);
      entry.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(entry), 1);
        reject(new BoardError('The snapshot server is busy. Try again in a few seconds.'));
      }, Math.max(0, deadline - Date.now()));
    });
  }

  function done() {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      running--;
    }
  }

  // A PNG (Buffer) of url in a width x height window.
  async function screenshot(url, { width, height }) {
    const deadline = Date.now() + TIMEOUT_MS;
    const left = () => Math.max(1, deadline - Date.now());
    await turn(deadline);
    let context;
    try {
      const b = await getBrowser();
      context = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const origin = new URL(url).origin;
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
      );
      const page = await context.newPage();
      // A page error (such as a board that does not load) ends the wait at
      // once instead of at the timeout.
      let failed;
      const pageFailed = new Promise((_, reject) => {
        failed = reject;
      });
      pageFailed.catch(() => {});
      page.on('pageerror', (err) => failed(new BoardError(`The viewer failed: ${err.message}`)));

      let response;
      try {
        response = await page.goto(url, { waitUntil: 'load', timeout: left() });
      } catch (err) {
        if (err.name === 'TimeoutError') throw err;
        throw new BoardError(`Cannot open the viewer at ${origin}: ${err.message.split('\n')[0]}`);
      }
      if (!response || !response.ok()) {
        throw new BoardError(`The viewer page did not load (${response ? response.status() : 'no response'}): ${url}`);
      }
      try {
        await Promise.race([page.waitForFunction(viewerDone, null, { timeout: left(), polling: 100 }), pageFailed]);
      } catch (err) {
        if (err instanceof BoardError) throw err;
        if (err.name === 'TimeoutError') {
          throw new BoardError(`The viewer did not finish drawing within ${TIMEOUT_MS / 1000} s.`);
        }
        throw err;
      }
      // animations: 'disabled' ends CSS transitions, such as a button
      // fading in, so the same link gives the same picture.
      return await page.screenshot({ type: 'png', animations: 'disabled', timeout: left() });
    } catch (err) {
      if (err instanceof BoardError) throw err;
      if (err.name === 'TimeoutError') {
        throw new BoardError(`The snapshot took longer than ${TIMEOUT_MS / 1000} s.`);
      }
      throw err;
    } finally {
      if (context) await context.close().catch(() => {});
      done();
    }
  }

  async function close() {
    const b = browser;
    browser = undefined;
    if (b) await (await b.catch(() => undefined))?.close();
  }

  return { screenshot, close };
}
