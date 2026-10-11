// snapshot through a real MCP client, in both server modes (harness.js),
// with real headless Chromium on the viewer shell from generate.py
// --build-viewer, served here as a static site. Needs the Playwright browser:
//   npx playwright-core install --with-deps --only-shell chromium   (in mcp/)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createBrowser, MAX_RUNNING, MAX_WAITING, NO_BROWSER } from '../src/browser.js';
import { parseBaseUrl, parseViewerLink } from '../src/links.js';
import { closeServer, listen, serveSite, startMcp } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';
const SIZE = { width: 800, height: 600 };

const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'netdaq-small.json'), 'utf8'));
const bb = fixture.pcbdata.edges_bbox;
// A point on the board, a view around it and a second point to its right.
const P = [+(bb.minx + 0.4 * (bb.maxx - bb.minx)).toFixed(2), +(bb.miny + 0.5 * (bb.maxy - bb.miny)).toFixed(2)];
const P2 = [+(P[0] + 4).toFixed(2), P[1]];
const VIEW = { minx: P[0] - 10, miny: P[1] - 8, maxx: P[0] + 10, maxy: P[1] + 8 };

let dir;
let browser;
let viewerSite;
let mcp;
let mcpNoSnapshot;

const call = (where, name, args) => where.call(name, args);

// The image of a snapshot result, decoded: { width, height, data (RGBA) }.
function imageOf(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const img = result.content.find((c) => c.type === 'image');
  assert.ok(img, 'no image content');
  assert.equal(img.mimeType, 'image/png');
  return PNG.sync.read(Buffer.from(img.data, 'base64'));
}

async function shot(args) {
  return imageOf(await call(mcp, 'snapshot', { ...SIZE, ...args }));
}

// The pixels that differ between two images of the same size: count, box
// and centre. A difference of a few colour steps is not counted: some
// anti-aliased edges come out one step apart from run to run.
function diff(a, b) {
  let n = 0, sx = 0, sy = 0;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > 12) {
        n++;
        sx += x;
        sy += y;
        minx = Math.min(minx, x);
        maxx = Math.max(maxx, x);
        miny = Math.min(miny, y);
        maxy = Math.max(maxy, y);
      }
    }
  }
  return { n, cx: sx / n, cy: sy / n, w: maxx - minx + 1, h: maxy - miny + 1 };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-snap-'));
  const site = path.join(dir, 'site');
  fs.mkdirSync(path.join(dir, 'exports', 'netdaq'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'netdaq-small.json'), path.join(dir, 'exports', NETDAQ));
  execFileSync('python3', ['build_boards.py', '--src', path.join(dir, 'exports'), '--out', path.join(site, 'pcbs')], {
    cwd: ROOT,
  });
  execFileSync('python3', ['generate.py', '--build-viewer', '-o', path.join(site, 'viewer', 'index.html')], {
    cwd: ROOT,
  });

  viewerSite = serveSite(site);
  const viewer = await listen(viewerSite);
  browser = createBrowser();
  const opts = {
    pcbs: path.join(site, 'pcbs'),
    baseUrl: parseBaseUrl('http://pcbhost:1010/', 'VIEWER_URL'),
  };
  mcp = await startMcp({ ...opts, snapshot: { base: parseBaseUrl(viewer.href, 'x'), browser } });
  mcpNoSnapshot = await startMcp(opts);
});

after(async () => {
  for (const m of [mcp, mcpNoSnapshot]) await m?.close();
  if (viewerSite) await closeServer(viewerSite);
  await browser?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a snapshot is a PNG of the asked size, with the public link and its warnings', async () => {
  const args = { board: NETDAQ, marks: [{ side: 'F', x: P[0], y: P[1] }], view_f: VIEW };
  const result = await call(mcp, 'snapshot', { ...args, width: 640, height: 480 });
  const img = imageOf(result);
  assert.equal(img.width, 640);
  assert.equal(img.height, 480);
  const { structuredContent } = result;
  assert.deepEqual(JSON.parse(result.content.find((c) => c.type === 'text').text), structuredContent);
  // The same link the link tool makes, on the public address.
  const link = await call(mcp, 'link', args);
  assert.equal(structuredContent.url, link.structuredContent.url);
  assert.match(structuredContent.url, /^http:\/\/pcbhost:1010\/viewer\//);
  assert.equal(structuredContent.side, 'F');
  assert.deepEqual(structuredContent.warnings, []);
  assert.equal(structuredContent.width, 640);

  // Not one flat colour: the board is drawn.
  const colours = new Set();
  for (let i = 0; i < img.data.length; i += 4 * 97) colours.add(img.data.readUInt32BE(i));
  assert.ok(colours.size > 20, `only ${colours.size} colours`);
});

test('the marker is drawn where it is asked, white, and nothing else changes', async () => {
  const base = { board: NETDAQ, side: 'F', view_f: VIEW };
  const none = await shot(base);
  const at1 = await shot({ ...base, marks: [{ side: 'F', x: P[0], y: P[1] }] });
  const at2 = await shot({ ...base, marks: [{ side: 'F', x: P2[0], y: P2[1] }] });
  const d1 = diff(none, at1);
  const d2 = diff(none, at2);
  for (const d of [d1, d2]) {
    assert.ok(d.n > 20, `marker changed only ${d.n} pixels`);
    assert.ok(d.w < 80 && d.h < 80, `marker change is ${d.w}x${d.h} px`);
  }
  // P is the view centre; P2 is 4 board units to its right, 20 wide in view.
  // The canvas sits right of the side panel, so only the direction and the
  // rough distance are checked.
  assert.ok(d2.cx - d1.cx > 0.1 * SIZE.width * (4 / 20), `markers at x ${d1.cx} and ${d2.cx}`);
  assert.ok(Math.abs(d2.cy - d1.cy) < 3, `markers at y ${d1.cy} and ${d2.cy}`);
  // The marker centre is white.
  const i = (Math.round(d1.cy) * at1.width + Math.round(d1.cx)) * 4;
  assert.ok(at1.data[i] > 200 && at1.data[i + 1] > 200 && at1.data[i + 2] > 200, `centre ${[...at1.data.slice(i, i + 4)]}`);
});

test('a selection shows', async () => {
  const base = { board: NETDAQ, side: 'F', zoom: 'board' };
  const d = diff(await shot(base), await shot({ ...base, refs: ['U24'] }));
  assert.ok(d.n > 1000, `selection changed only ${d.n} pixels`);
});

test('a ready link gives the same picture as its fields', async () => {
  const args = { board: NETDAQ, refs: ['U24'], marks: [{ side: 'F', x: P[0], y: P[1] }] };
  const { structuredContent } = await call(mcp, 'link', args);
  const fromFields = await shot(args);
  const result = await call(mcp, 'snapshot', { ...SIZE, url: structuredContent.url });
  const fromUrl = imageOf(result);
  assert.equal(result.structuredContent.url, structuredContent.url);
  // A root-relative link works too.
  const relative = await shot({ url: new URL(structuredContent.url).pathname + new URL(structuredContent.url).search + new URL(structuredContent.url).hash });
  for (const img of [fromUrl, relative]) {
    const d = diff(fromFields, img);
    assert.ok(d.n < 0.001 * SIZE.width * SIZE.height, `${d.n} pixels differ`);
  }
});

test('bad input is a tool error', async () => {
  for (const args of [
    {},
    { url: 'http://pcbhost:1010/viewer/?data=/pcbs/netdaq/netdaq.json', board: NETDAQ },
    { url: 'http://pcbhost:1010/viewer/?data=/pcbs/nope/nope.json' },
    { url: 'http://pcbhost:1010/other/?data=/pcbs/netdaq/netdaq.json' },
    { url: 'not a link at all' },
    { board: NETDAQ, refs: ['U9999'] },
    { board: NETDAQ, width: 10000 },
    { board: NETDAQ, height: 100 },
  ]) {
    const result = await call(mcp, 'snapshot', args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
});

test('without a viewer address the tool says snapshots are not set up', async () => {
  const result = await call(mcpNoSnapshot, 'snapshot', { board: NETDAQ });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SNAPSHOT_VIEWER_URL/);
});

test('viewer links parse back to board and hash, under any site root', () => {
  assert.deepEqual(parseViewerLink('https://example.org/pcb/viewer/?data=/pcb/pcbs/lab/rev%202/a.json#comp=U1'), {
    board: 'lab/rev 2/a.json',
    hash: 'comp=U1',
  });
  assert.deepEqual(parseViewerLink('/viewer/?data=/pcbs/a.json'), { board: 'a.json', hash: '' });
  assert.throws(() => parseViewerLink('/pcb/viewer/?data=/pcbs/a.json'), /not a board under \/pcb\/pcbs\//);
});

// A browser whose pages never finish loading until let go, to fill every slot.
// Its pages load (with no response) only once release() is called.
function stuckBrowser() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const page = { on() {}, goto: () => gate.then(() => null) };
  const context = { route: async () => {}, newPage: async () => page, close: async () => {} };
  const fake = {
    on() {},
    newContext: async () => {
      started++;
      return context;
    },
    close: async () => {},
  };
  return { browser: createBrowser({ launch: async () => fake }), release, started: () => started };
}

test(`at most ${MAX_RUNNING} snapshots run and ${MAX_WAITING} wait; one more is told the server is busy`, async () => {
  const { browser: b, release, started } = stuckBrowser();
  const calls = [];
  for (let i = 0; i < MAX_RUNNING + MAX_WAITING; i++) {
    calls.push(b.screenshot('http://viewer.invalid/viewer/', SIZE).catch((err) => err));
  }
  await assert.rejects(b.screenshot('http://viewer.invalid/viewer/', SIZE), /busy/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started(), MAX_RUNNING);
  // Each page then fails (no response), which gives its slot to one waiting.
  release();
  const ends = await Promise.all(calls);
  assert.equal(started(), MAX_RUNNING + MAX_WAITING);
  for (const e of ends) assert.match(String(e?.message), /did not load/);
  // All slots are free again.
  release();
  await assert.rejects(b.screenshot('http://viewer.invalid/viewer/', SIZE), /did not load/);
});

test('without Chromium installed, a snapshot says how to install it', async () => {
  // Playwright's own error when the browser is missing.
  const b = createBrowser({
    launch: async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell");
    },
  });
  await assert.rejects(b.screenshot('http://viewer.invalid/viewer/', SIZE), (err) => err.message === NO_BROWSER);
  assert.match(NO_BROWSER, /npx playwright-core install --only-shell chromium/);
});
