// The real stdio process (node src/main.js --stdio --site <url>) against a
// static site served under a sub-path, the way a GitHub Pages project site
// is (https://<user>.github.io/<repo>/), and the HTTP board store on its own:
// cache, size cap, timeout. The tool tests themselves run in stdio mode
// through harness.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BoardError, httpStore, listBoards } from '../src/boards.js';
import { NO_BROWSER } from '../src/browser.js';
import { closeServer, listen, serveSite } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = path.join(ROOT, 'mcp', 'src', 'main.js');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';

let dir;
let pcbs;
let site;
let host; // http://127.0.0.1:<port>/
let client;
let stderr = '';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-stdio-'));
  pcbs = path.join(dir, 'www', 'repo', 'pcbs');
  fs.mkdirSync(path.join(dir, 'exports', 'netdaq'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'netdaq-small.json'), path.join(dir, 'exports', NETDAQ));
  execFileSync('python3', ['build_boards.py', '--src', path.join(dir, 'exports'), '--out', pcbs], { cwd: ROOT });

  site = serveSite(path.join(dir, 'www'));
  host = await listen(site);
  // No Chromium where Playwright looks for it.
  const noBrowsers = path.join(dir, 'no-browsers');
  fs.mkdirSync(noBrowsers);
  const transport = new StdioClientTransport({
    command: process.execPath,
    // No trailing slash: the server adds it.
    args: [MAIN, '--stdio', '--site', new URL('repo', host).href],
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: noBrowsers },
    stderr: 'pipe',
  });
  transport.stderr.on('data', (d) => (stderr += d));
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (site) await closeServer(site);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the stdio server offers the same tools as the Docker one', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'link',
    'list_boards',
    'locate',
    'nearest',
    'nearest_vias',
    'net_places',
    'snapshot',
  ]);
  // Logs go to stderr; stdout carries only MCP.
  assert.match(stderr, /MCP on stdio, boards from http:\/\/127\.0\.0\.1:\d+\/repo\/pcbs\//);
});

test('boards come from the site', async () => {
  const result = await client.callTool({ name: 'list_boards', arguments: {} });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(result.structuredContent, { boards: [{ path: NETDAQ, title: 'netdaq' }] });
  const located = await client.callTool({ name: 'locate', arguments: { board: NETDAQ, refs: ['U24'] } });
  assert.equal(located.structuredContent.parts[0].ref, 'U24');
});

test('links point at the site, with data= under its sub-path, and the board is there', async () => {
  const { structuredContent } = await client.callTool({ name: 'link', arguments: { board: NETDAQ, refs: ['U24'] } });
  const want = new URL('repo/viewer/?data=/repo/pcbs/netdaq/netdaq.json#comp=U24', host).href;
  assert.equal(structuredContent.url, want);
  assert.deepEqual(structuredContent.warnings, []);
  // The viewer fetches data= from the page; it must find the board.
  const data = new URL(structuredContent.url).searchParams.get('data');
  const res = await fetch(new URL(data, structuredContent.url));
  assert.equal(res.status, 200);
});

test('without Chromium, snapshot is a tool error that says how to install it', async () => {
  const result = await client.callTool({ name: 'snapshot', arguments: { board: NETDAQ } });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, NO_BROWSER);
});

test('bad arguments stop the server with a message', () => {
  for (const args of [['--stdio'], ['--stdio', '--site', 'ftp://example.org/'], ['--site', 'http://example.org/'], ['--nope']]) {
    const run = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, /Usage:/);
  }
});

// The HTTP board store on its own.

const storeOn = (opts) => httpStore(new URL('repo/pcbs/', host), opts);

test('an unchanged file is answered with 304 and not downloaded again; a changed one is', async () => {
  const store = storeOn();
  const before304 = site.requests[304] ?? 0;
  const first = await store.readJson(NETDAQ);
  const again = await store.readJson(NETDAQ);
  assert.equal(again, first);
  assert.equal(site.requests[304], before304 + 1);

  const index = path.join(pcbs, 'index.json');
  const saved = fs.readFileSync(index);
  try {
    fs.writeFileSync(index, JSON.stringify({ boards: [{ path: 'x.json', title: 'X' }] }));
    assert.deepEqual(await listBoards(store), [{ path: 'x.json', title: 'X' }]);
  } finally {
    fs.writeFileSync(index, saved);
  }
  assert.deepEqual(await listBoards(store), [{ path: NETDAQ, title: 'netdaq' }]);
});

test('a file the site sends without ETag or Last-Modified is fetched every time', async () => {
  let hits = 0;
  const bare = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"boards":[]}');
  });
  const url = await listen(bare);
  try {
    const store = httpStore(url);
    await store.readJson('index.json');
    await store.readJson('index.json');
    assert.equal(hits, 2);
  } finally {
    await closeServer(bare);
  }
});

test('the store refuses files over the size cap, slow sites and paths outside the folder', async () => {
  await assert.rejects(storeOn({ maxFileBytes: 1000 }).readJson(NETDAQ), (err) => err instanceof BoardError && /larger than/.test(err.message));

  // Sends headers, then never the body.
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
  });
  const url = await listen(slow);
  try {
    await assert.rejects(httpStore(url, { timeoutMs: 200 }).readJson('index.json'), /no full answer .* within 0\.2 s/);
  } finally {
    await closeServer(slow);
  }

  for (const bad of ['../index.json', 'a//b.json', '/etc/passwd', './index.json']) {
    await assert.rejects(storeOn().readJson(bad), /outside the board folder/, bad);
  }
  await assert.rejects(storeOn().readJson('nope/nope.json'), /Not found: nope\/nope\.json/);
});

test('a site that cannot be reached is a tool error', async () => {
  const store = httpStore('http://127.0.0.1:1/pcbs/');
  await assert.rejects(store.readJson('index.json'), (err) => err instanceof BoardError && /Cannot fetch index\.json/.test(err.message));
});
