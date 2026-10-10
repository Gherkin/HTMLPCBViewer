// build_boards.py writes pcbs/index.json, and the board list page
// (docker/index.html) works from that file alone. The page is served here by
// a plain static server with no directory listing, as on GitHub Pages.

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'netdaq-small.json');

let dir;
let site;
let pcbs;

function build(...extra) {
  return execFileSync(
    'python3',
    ['build_boards.py', '--src', path.join(dir, 'exports'), '--out', pcbs, ...extra],
    { cwd: ROOT, encoding: 'utf8' }
  );
}

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(pcbs, 'index.json'), 'utf8'));
}

// Serves files only. A directory, or anything missing, is a 404.
function staticServer(root) {
  const types = { '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };
  return http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

test.describe.serial('board index', () => {
  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-index-'));
    site = path.join(dir, 'site');
    pcbs = path.join(site, 'pcbs');
    fs.mkdirSync(site);
    fs.mkdirSync(path.join(dir, 'exports', 'boardA'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'exports', 'lab', 'rev2'), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(dir, 'exports', 'boardA', 'boardA.json'));
    // A board with no title falls back to its file name.
    const untitled = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    delete untitled.pcbdata.metadata.title;
    fs.writeFileSync(path.join(dir, 'exports', 'lab', 'rev2', 'probe.json'), JSON.stringify(untitled));
    fs.copyFileSync(path.join(ROOT, 'docker', 'index.html'), path.join(site, 'index.html'));
  });

  test.afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('build_boards.py lists every board with its title', () => {
    build();
    expect(readIndex()).toEqual({
      boards: [
        { path: 'boardA/boardA.json', title: 'netdaq' },
        { path: 'lab/rev2/probe.json', title: 'probe' },
      ],
    });
  });

  test('build_boards.py writes the index when every board is up to date', () => {
    const before = readIndex();
    fs.rmSync(path.join(pcbs, 'index.json'));
    const out = build();
    expect(out).toContain('built=0  skipped=2');
    expect(readIndex()).toEqual(before);
  });

  test('a dry run does not write the index', () => {
    fs.rmSync(path.join(pcbs, 'index.json'));
    build('--dry-run', '--force');
    expect(fs.existsSync(path.join(pcbs, 'index.json'))).toBe(false);
    build();
  });

  test('the board list page works from index.json alone', async ({ page }) => {
    const server = staticServer(site);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
      await page.goto(base);
      const listing = page.locator('#listing');
      await expect(listing.locator('.entry.folder .name')).toHaveText(['boardA', 'lab']);
      await expect(listing.locator('.entry.file')).toHaveCount(0);

      await listing.getByRole('link', { name: 'boardA' }).click();
      const board = listing.locator('.entry.file');
      await expect(board.locator('.name')).toHaveText('netdaq');
      await expect(board.locator('.meta')).toHaveText('boardA.json');
      const href = await board.locator('.open-btn').getAttribute('href');
      expect(href).toBe('/viewer/?data=' + encodeURIComponent('/pcbs/boardA/boardA.json'));
      // The link points at a file the static server really has.
      const res = await page.request.get(base + 'pcbs/boardA/boardA.json');
      expect(res.ok()).toBe(true);

      // A deep link opens the folder straight away.
      await page.goto(base + '#lab/rev2');
      await expect(listing.locator('.entry.file .name')).toHaveText('probe');
      await expect(page.locator('#breadcrumb')).toContainText('lab/rev2');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
