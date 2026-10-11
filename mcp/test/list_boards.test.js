// list_boards through a real MCP client, against boards that
// build_boards.py builds from the test fixtures. Runs in both server modes
// (harness.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardError, diskStore } from '../src/boards.js';
import { MODE, startMcp } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'netdaq-small.json');

let dir;
let pcbs;
let mcp;

const callListBoards = () => mcp.call('list_boards', {});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-mcp-'));
  pcbs = path.join(dir, 'pcbs');
  fs.mkdirSync(path.join(dir, 'exports', 'boardA'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports', 'lab', 'rev2'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, 'exports', 'boardA', 'boardA.json'));
  // A board with no title falls back to its file name.
  const untitled = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  delete untitled.pcbdata.metadata.title;
  fs.writeFileSync(path.join(dir, 'exports', 'lab', 'rev2', 'probe.json'), JSON.stringify(untitled));
  execFileSync('python3', ['build_boards.py', '--src', path.join(dir, 'exports'), '--out', pcbs], {
    cwd: ROOT,
  });

  mcp = await startMcp({ pcbs });
});

after(async () => {
  await mcp.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the server offers list_boards', async () => {
  const { tools } = await mcp.withClient((c) => c.listTools());
  assert.ok(tools.map((t) => t.name).includes('list_boards'));
});

test('list_boards returns each board with its path and title', async () => {
  const result = await callListBoards();
  const boards = [
    { path: 'boardA/boardA.json', title: 'netdaq' },
    { path: 'lab/rev2/probe.json', title: 'probe' },
  ];
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { boards });
  assert.deepEqual(JSON.parse(result.content[0].text), { boards });
});

test('list_boards sees a rebuild without a restart', async () => {
  const index = path.join(pcbs, 'index.json');
  const saved = fs.readFileSync(index);
  try {
    fs.writeFileSync(index, JSON.stringify({ boards: [{ path: 'x.json', title: 'X' }] }));
    const result = await callListBoards();
    assert.deepEqual(result.structuredContent, { boards: [{ path: 'x.json', title: 'X' }] });
  } finally {
    fs.writeFileSync(index, saved);
  }
});

test('with no index.json, list_boards says to run build_boards.py', async () => {
  const index = path.join(pcbs, 'index.json');
  const saved = fs.readFileSync(index);
  fs.rmSync(index);
  try {
    const result = await callListBoards();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /build_boards\.py/);
  } finally {
    fs.writeFileSync(index, saved);
  }
});

const httpOnly = { skip: MODE !== 'http' && 'the HTTP transport only' };

test('only POST is served, and only at /mcp', httpOnly, async () => {
  const url = mcp.mcpUrl;
  const get = await fetch(url);
  assert.equal(get.status, 405);
  const other = await fetch(new URL('/other', url), { method: 'POST' });
  assert.equal(other.status, 404);
});

test('a malformed request target gets a 404 and the server stays up', httpOnly, async () => {
  const url = mcp.mcpUrl;
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write('POST //[ HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', (d) => (data += d));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 404/);
  const result = await callListBoards();
  assert.equal(result.isError, undefined);
});

test('the disk store does not read outside the board folder', async () => {
  const store = diskStore(pcbs);
  await assert.rejects(store.readJson('../exports/boardA/boardA.json'), /outside the board folder/);
});

test('the disk store gives a tool error for a folder or a missing file', async () => {
  const store = diskStore(pcbs);
  await assert.rejects(store.readJson('lab/rev2'), (err) => err instanceof BoardError && /A folder/.test(err.message));
  await assert.rejects(store.readJson('boardA/boardA.json/x'), (err) => err instanceof BoardError && /Not found/.test(err.message));
  await assert.rejects(store.readJson('nope.json'), (err) => err instanceof BoardError && /Not found/.test(err.message));
});
