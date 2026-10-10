// list_boards through a real MCP client over HTTP, against boards that
// build_boards.py builds from the test fixtures.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { diskStore } from '../src/boards.js';
import { createHttpServer, MCP_PATH } from '../src/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'netdaq-small.json');

let dir;
let pcbs;
let server;
let url;

async function connect() {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

async function callListBoards() {
  const client = await connect();
  try {
    return await client.callTool({ name: 'list_boards', arguments: {} });
  } finally {
    await client.close();
  }
}

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

  server = createHttpServer({ store: diskStore(pcbs) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = new URL(`http://127.0.0.1:${server.address().port}${MCP_PATH}`);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the server offers list_boards', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('list_boards'));
  } finally {
    await client.close();
  }
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

test('only POST is served, and only at /mcp', async () => {
  const get = await fetch(url);
  assert.equal(get.status, 405);
  const other = await fetch(new URL('/other', url), { method: 'POST' });
  assert.equal(other.status, 404);
});

test('the disk store does not read outside the board folder', async () => {
  const store = diskStore(pcbs);
  await assert.rejects(store.readJson('../exports/boardA/boardA.json'), /outside the board folder/);
});
