// nearest through a real MCP client over HTTP, against both test fixtures
// built by build_boards.py, plus small made-up boards for the reach rules.

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
import { pointInFootprint } from '../src/footprints.js';
import { createHttpServer, MCP_PATH } from '../src/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';
const CIAA = 'ciaa/ciaa.json';
const MADE_UP = 'made/up.json';

let dir;
let pcbs;
let server;
let url;

async function callNearest(args) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    return await client.callTool({ name: 'nearest', arguments: args });
  } finally {
    await client.close();
  }
}

// nearest on a made-up board payload, through the same server.
async function nearestOn(board, args) {
  fs.mkdirSync(path.join(pcbs, 'made'), { recursive: true });
  fs.writeFileSync(path.join(pcbs, MADE_UP), JSON.stringify(board));
  return callNearest({ board: MADE_UP, ...args });
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

// A part with a 2 x 2 box centered on (x, y), unrotated.
function part(ref, layer, x, y, pads, size = 2) {
  return {
    ref,
    layer,
    bbox: { pos: [x, y], relpos: [-size / 2, -size / 2], size: [size, size], angle: 0 },
    pads,
  };
}
const smd = (x, y, net, layer = 'F') => ({ pos: [x, y], layers: [layer], type: 'smd', net });
const th = (x, y, net) => ({ pos: [x, y], layers: ['F', 'B'], type: 'th', net });

test('nearest on a KiCad board: pads by distance from the part box, own pads at 0', async () => {
  const result = await callNearest({ board: NETDAQ, net: '+3.3V', near: 'U24' });
  assert.equal(result.isError, undefined);
  const { net, found, pads, covered } = result.structuredContent;
  assert.equal(net, '+3.3V');
  assert.equal(found, true);
  assert.equal(covered, 0);
  assert.deepEqual(pads[0], { ref: 'U24', side: 'F', x: 167.8, y: 138.480884, type: 'smd', distance: 0 });
  assert.deepEqual(
    pads.map((p) => p.ref),
    ['U24', 'R18', 'R14', 'FB2', 'SW2', 'SW2']
  );
  for (let i = 1; i < pads.length; i++) assert.ok(pads[i - 1].distance <= pads[i].distance);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('test points come first, even when other pads are nearer', async () => {
  const { structuredContent } = await callNearest({
    board: CIAA,
    net: '/Principal/BANK_0/I2C_SCL',
    near: [100, 100],
  });
  const [first, second] = structuredContent.pads;
  assert.equal(first.ref, 'TP4');
  assert.equal(first.testpoint, true);
  assert.equal(second.ref, 'U1');
  assert.ok(second.distance < first.distance);
  assert.equal(structuredContent.pads.filter((p) => p.testpoint).length, 1);
});

test('through-hole pads come before SMD pads', async () => {
  const { structuredContent } = await callNearest({ board: CIAA, net: '+3.3V', near: 'U1' });
  const types = structuredContent.pads.map((p) => p.type);
  assert.equal(types[0], 'th');
  assert.equal(structuredContent.pads[0].ref, 'J17');
  assert.deepEqual(types.slice(types.lastIndexOf('th') + 1).filter((t) => t !== 'smd'), []);
});

test('a free through-hole test point is reachable from both sides', async () => {
  const { structuredContent } = await callNearest({ board: NETDAQ, net: '/RMII.TXD1', near: 'TP68' });
  assert.deepEqual(structuredContent.pads, [
    { ref: 'TP68', side: 'both', x: 151, y: 89.6, type: 'th', pin1: true, testpoint: true, distance: 0 },
  ]);
});

test('a test point under another part is left out and counted (ciaa TP7 under L2)', async () => {
  const { structuredContent } = await callNearest({
    board: CIAA,
    net: '/Principal/BANKS_HR/UART_EMIO_RX',
    near: 'TP7',
  });
  assert.equal(structuredContent.covered, 1);
  assert.ok(!structuredContent.pads.some((p) => p.ref === 'TP7'));
  assert.ok(structuredContent.pads.length > 0);
});

// On both fixtures, no pad that comes back lies inside another part's box on
// the side it is reported reachable from.
for (const [name, rel] of [
  ['netdaq', NETDAQ],
  ['ciaa-acc', CIAA],
]) {
  test(`returned pads are never under another part (${name})`, async () => {
    const board = readBoard(rel);
    const { structuredContent } = await callNearest({ board: rel, net: 'GND', near: [0, 0], limit: 200 });
    assert.ok(structuredContent.pads.length > 0);
    for (const p of structuredContent.pads) {
      const sides = p.side === 'both' ? ['F', 'B'] : [p.side];
      for (const s of sides) {
        const over = board.footprints.filter(
          (fp) => fp.ref !== p.ref && fp.layer === s && pointInFootprint(fp, p.x, p.y)
        );
        assert.deepEqual(over.map((fp) => fp.ref), [], `${p.ref} at ${p.x},${p.y} side ${s}`);
      }
    }
  });
}

test('distance from a point is straight-line distance to the pad center', async () => {
  const board = { footprints: [part('R1', 'F', 10, 10, [smd(13, 14, 'N')])] };
  const { structuredContent } = await nearestOn(board, { net: 'N', near: [10, 10] });
  assert.equal(structuredContent.pads[0].distance, 5);
});

test('distance from a refdes is to the nearest edge of its box', async () => {
  // U1's box is 10..12 x 10..12 (rotated 90 degrees, still the same square).
  const u1 = part('U1', 'F', 11, 11, [smd(11, 11, 'N')]);
  u1.bbox.angle = 90;
  const board = { footprints: [u1, part('R1', 'F', 20, 11, [smd(15, 11, 'N')]), part('R2', 'F', 20, 30, [smd(15, 16, 'N')])] };
  const { structuredContent } = await nearestOn(board, { net: 'N', near: 'u1' });
  assert.deepEqual(
    structuredContent.pads.map((p) => [p.ref, p.distance]),
    [
      ['U1', 0],
      ['R1', 3],
      ['R2', 5],
    ]
  );
});

test('an SMD pad under another part on its side is skipped; one on the other side is not', async () => {
  const board = {
    footprints: [
      part('U1', 'F', 10, 10, [], 6),
      part('R1', 'F', 10, 10, [smd(10, 10, 'N')]),
      part('R2', 'B', 10, 10, [smd(11, 10, 'N', 'B')]),
    ],
  };
  const { structuredContent } = await nearestOn(board, { net: 'N', near: [10, 10] });
  assert.deepEqual(structuredContent.pads.map((p) => p.ref), ['R2']);
  assert.equal(structuredContent.covered, 1);
});

test('a through-hole pad covered on one side is reported on the free side', async () => {
  const board = {
    footprints: [
      part('J1', 'F', 0, 0, [th(0, 0, 'N')]),
      part('U1', 'F', 0, 0, [], 6),
      part('J2', 'F', 20, 0, [th(20, 0, 'N')]),
      part('U2', 'F', 20, 0, [], 6),
      part('U3', 'B', 20, 0, [], 6),
    ],
  };
  const { structuredContent } = await nearestOn(board, { net: 'N', near: [0, 0] });
  assert.deepEqual(structuredContent.pads, [{ ref: 'J1', side: 'B', x: 0, y: 0, type: 'th', distance: 0 }]);
  assert.equal(structuredContent.covered, 1);
});

test('side keeps only pads reachable from that side', async () => {
  const board = {
    footprints: [
      part('R1', 'F', 0, 0, [smd(0, 0, 'N')]),
      part('R2', 'B', 5, 0, [smd(5, 0, 'N', 'B')]),
      part('J1', 'F', 9, 0, [th(9, 0, 'N')]),
    ],
  };
  const front = await nearestOn(board, { net: 'N', near: [0, 0], side: 'F' });
  assert.deepEqual(front.structuredContent.pads.map((p) => [p.ref, p.side]), [['J1', 'F'], ['R1', 'F']]);
  const back = await nearestOn(board, { net: 'N', near: [0, 0], side: 'B' });
  assert.deepEqual(back.structuredContent.pads.map((p) => [p.ref, p.side]), [['J1', 'B'], ['R2', 'B']]);
  assert.equal(back.structuredContent.covered, 1);
});

test('limit and max_distance cut the list', async () => {
  const board = {
    footprints: [1, 2, 3, 4].map((i) => part(`R${i}`, 'F', i * 10, 0, [smd(i * 10, 0, 'N')])),
  };
  const limited = await nearestOn(board, { net: 'N', near: [0, 0], limit: 2 });
  assert.deepEqual(limited.structuredContent.pads.map((p) => p.ref), ['R1', 'R2']);
  const near = await nearestOn(board, { net: 'N', near: [0, 0], max_distance: 30 });
  assert.deepEqual(near.structuredContent.pads.map((p) => p.ref), ['R1', 'R2', 'R3']);
});

test('a test point is known by its value or footprint name too', async () => {
  const board = {
    footprints: [
      part('X1', 'F', 30, 0, [smd(30, 0, 'N')]),
      part('X2', 'F', 20, 0, [smd(20, 0, 'N')]),
      part('R1', 'F', 0, 0, [smd(0, 0, 'N')]),
    ],
    components: [
      { ref: 'X1', val: 'Test Point', footprint: 'pad' },
      { ref: 'X2', val: '', footprint: 'TestPoint_Pad_D1.0mm' },
      { ref: 'R1', val: '10k', footprint: 'R_0402' },
    ],
  };
  const { structuredContent } = await nearestOn(board, { net: 'N', near: [0, 0] });
  assert.deepEqual(
    structuredContent.pads.map((p) => [p.ref, p.testpoint ?? false]),
    [
      ['X2', true],
      ['X1', true],
      ['R1', false],
    ]
  );
});

test('vias are never returned', async () => {
  const board = {
    footprints: [part('R1', 'F', 50, 0, [smd(50, 0, 'N')])],
    tracks: { F: [{ start: [0, 0], end: [0, 0], width: 0.6, drillsize: 0.3, net: 'N' }], B: [] },
    nets: ['N'],
  };
  const { structuredContent } = await nearestOn(board, { net: 'N', near: [0, 0] });
  assert.deepEqual(structuredContent.pads.map((p) => p.ref), ['R1']);
});

test('an unknown net is not found, not an error', async () => {
  const result = await callNearest({ board: NETDAQ, net: '/NO/SUCH_NET', near: 'U24' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { net: '/NO/SUCH_NET', found: false, pads: [], covered: 0 });
});

test('an unknown refdes is a tool error', async () => {
  const result = await callNearest({ board: NETDAQ, net: '+3.3V', near: 'U999' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /U999/);
});

test('net and refdes ignore case and surrounding spaces', async () => {
  const { structuredContent } = await callNearest({ board: NETDAQ, net: ' +3.3v ', near: ' u24 ' });
  assert.equal(structuredContent.net, '+3.3V');
  assert.equal(structuredContent.pads[0].ref, 'U24');
});
