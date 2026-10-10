// net_places through a real MCP client over HTTP, against both test fixtures
// built by build_boards.py.

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
import { boardPads, padPlace } from '../src/pads.js';
import { createHttpServer, MCP_PATH } from '../src/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';
const CIAA = 'ciaa/ciaa.json';

let dir;
let pcbs;
let server;
let url;

async function callNetPlaces(args) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    return await client.callTool({ name: 'net_places', arguments: args });
  } finally {
    await client.close();
  }
}

function readBoard(rel) {
  return JSON.parse(fs.readFileSync(path.join(pcbs, rel), 'utf8'));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-mcp-'));
  pcbs = path.join(dir, 'pcbs');
  fs.mkdirSync(path.join(dir, 'exports', 'netdaq'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports', 'ciaa'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'netdaq-small.json'), path.join(dir, 'exports', NETDAQ));
  fs.copyFileSync(path.join(FIXTURES, 'ciaa-acc.json'), path.join(dir, 'exports', CIAA));
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

test('net_places lists every pad on a net with refdes, side, position and type (KiCad)', async () => {
  // /ADC3/ADCIN_ISOL7 in netdaq is on two pads of U24; the first is pin 1.
  const result = await callNetPlaces({ board: NETDAQ, net: '/ADC3/ADCIN_ISOL7' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    net: '/ADC3/ADCIN_ISOL7',
    found: true,
    pads: [
      { ref: 'U24', side: 'F', x: 167.8, y: 140.430884, type: 'smd', pin1: true },
      { ref: 'U24', side: 'F', x: 167.8, y: 139.780884, type: 'smd' },
    ],
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('a power net name with symbols matches as written', async () => {
  const { structuredContent } = await callNetPlaces({ board: NETDAQ, net: '+3.3V' });
  assert.equal(structuredContent.found, true);
  const refs = new Set(structuredContent.pads.map((p) => p.ref));
  for (const ref of ['U24', 'R18', 'R14', 'FB2', 'SW2']) assert.ok(refs.has(ref), `${ref} missing`);
});

test('a through-hole pad is on both sides', async () => {
  const { structuredContent } = await callNetPlaces({ board: NETDAQ, net: '/RMII.TXD1' });
  const tp = structuredContent.pads.filter((p) => p.ref === 'TP68');
  assert.equal(tp.length, 1);
  assert.equal(tp[0].side, 'both');
  assert.equal(tp[0].type, 'th');
});

test('pads on the back side say B, in the same board coordinates', async () => {
  // OB_USB_OC in ciaa-acc: pin 1 of J3 on the back, pin 1 of J2 on the front.
  const { structuredContent } = await callNetPlaces({ board: CIAA, net: '/Principal/OneBank/OB_USB_OC' });
  assert.deepEqual(structuredContent.pads, [
    { ref: 'J3', side: 'B', x: 121.7585, y: 104.293, type: 'smd', pin1: true },
    { ref: 'J2', side: 'F', x: 121.8855, y: 104.293, type: 'smd', pin1: true },
  ]);
});

test('matching ignores case when the exact name is not on the board', async () => {
  const { structuredContent } = await callNetPlaces({ board: NETDAQ, net: '/adc3/adcin_isol7' });
  assert.equal(structuredContent.found, true);
  assert.equal(structuredContent.net, '/ADC3/ADCIN_ISOL7');
  assert.equal(structuredContent.pads.length, 2);
});

test('spaces around the net name are ignored', async () => {
  const { structuredContent } = await callNetPlaces({ board: NETDAQ, net: ' /ADC3/ADCIN_ISOL7 ' });
  assert.equal(structuredContent.found, true);
  assert.equal(structuredContent.net, '/ADC3/ADCIN_ISOL7');
  assert.equal(structuredContent.pads.length, 2);
});

test('an unknown net is not found, not an error', async () => {
  const result = await callNetPlaces({ board: NETDAQ, net: '/NO/SUCH_NET' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { net: '/NO/SUCH_NET', found: false, pads: [] });
});

test('unconnected pads are never matched', async () => {
  // ciaa-acc has pads with net "", e.g. the mounting holes of J3.
  const { structuredContent } = await callNetPlaces({ board: CIAA, net: '' });
  assert.deepEqual(structuredContent, { net: '', found: false, pads: [] });
});

test('an unknown board is a tool error that points at list_boards', async () => {
  const result = await callNetPlaces({ board: 'nope/nope.json', net: 'GND' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /list_boards/);
});

// Every pad in the payload comes out of boardPads, at its own position, with
// a side that matches its layers. Checked on both fixtures.
for (const [name, rel] of [
  ['netdaq', NETDAQ],
  ['ciaa-acc', CIAA],
]) {
  test(`every pad is walked once, at its payload position (${name})`, () => {
    const board = readBoard(rel);
    const total = board.footprints.reduce((n, fp) => n + fp.pads.length, 0);
    let seen = 0;
    for (const { fp, pad } of boardPads(board)) {
      const place = padPlace(fp, pad);
      assert.equal(place.ref, fp.ref);
      assert.ok(Math.abs(place.x - pad.pos[0]) < 1e-6 && Math.abs(place.y - pad.pos[1]) < 1e-6);
      assert.ok(['smd', 'th'].includes(place.type));
      const want = pad.layers.length === 2 ? 'both' : pad.layers[0];
      assert.equal(place.side, want);
      assert.equal(place.pin1 === true, Boolean(pad.pin1));
      seen++;
    }
    assert.equal(seen, total);
    assert.ok(total > 0);
  });
}
