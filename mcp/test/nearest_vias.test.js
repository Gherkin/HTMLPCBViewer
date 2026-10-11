// nearest_vias through a real MCP client over HTTP, against both test
// fixtures built by build_boards.py, plus small made-up boards for the rules.

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
import { VIA_NOTE } from '../src/tools/nearest_vias.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';
const CIAA = 'ciaa/ciaa.json';
const MADE_UP = 'made/up.json';

let dir;
let pcbs;
let server;
let url;

async function withClient(fn) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const callVias = (args) => withClient((c) => c.callTool({ name: 'nearest_vias', arguments: args }));

// nearest_vias on a made-up board payload, through the same server.
async function viasOn(board, args) {
  fs.mkdirSync(path.join(pcbs, 'made'), { recursive: true });
  fs.writeFileSync(path.join(pcbs, MADE_UP), JSON.stringify(board));
  return callVias({ board: MADE_UP, ...args });
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

// A part with a size x size box centered on (x, y), unrotated, no pads.
function part(ref, layer, x, y, size = 2, pads = []) {
  return { ref, layer, bbox: { pos: [x, y], relpos: [-size / 2, -size / 2], size: [size, size], angle: 0 }, pads };
}

// Copies of a via at (x, y) on each of layers, the way the exports write it.
function via(tracks, x, y, net, layers, width = 0.6, drillsize) {
  for (const l of layers) {
    const t = { start: [x, y], end: [x, y], width, net };
    if (drillsize !== undefined) t.drillsize = drillsize;
    (tracks[l] ??= []).push(t);
  }
}

const ALL4 = ['F', 'B', 'In1.Cu', 'In2.Cu'];

test('the tool description and every answer say vias are a last resort and may be under soldermask', async () => {
  const { tools } = await withClient((c) => c.listTools());
  const tool = tools.find((t) => t.name === 'nearest_vias');
  assert.match(tool.description, /last resort/);
  assert.match(tool.description, /soldermask/);
  assert.match(tool.description, /no tenting data/);
  assert.match(VIA_NOTE, /last resort/);
  assert.match(VIA_NOTE, /soldermask/);

  const found = await callVias({ board: NETDAQ, net: '+3.3V', near: 'U24' });
  assert.equal(found.structuredContent.note, VIA_NOTE);
  const missing = await callVias({ board: NETDAQ, net: '/NO/SUCH_NET', near: 'U24' });
  assert.equal(missing.isError, undefined);
  assert.deepEqual(missing.structuredContent, { net: '/NO/SUCH_NET', found: false, note: VIA_NOTE, vias: [] });
});

test('netdaq: every +3.3V via, on all four layers, nearest to U24 first', async () => {
  const result = await callVias({ board: NETDAQ, net: '+3.3V', near: 'U24', limit: 200 });
  assert.equal(result.isError, undefined);
  const { net, found, vias } = result.structuredContent;
  assert.equal(net, '+3.3V');
  assert.equal(found, true);
  // 127 via places on +3.3V; a few places have two copies per layer, which
  // are one via.
  assert.equal(vias.length, 127);
  assert.equal(new Set(vias.map((v) => `${v.x},${v.y}`)).size, 127);
  for (let i = 1; i < vias.length; i++) assert.ok(vias[i - 1].distance <= vias[i].distance);
  for (const v of vias) {
    assert.deepEqual(v.layers, ALL4);
    assert.ok(v.diameter > 0);
    assert.equal('drill' in v, false);
  }
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('ciaa: vias span all twelve layers; side B keeps them all, given on B', async () => {
  const all = await callVias({ board: CIAA, net: 'GND', near: [100, 100] });
  assert.equal(all.structuredContent.vias.length, 10);
  for (const v of all.structuredContent.vias) assert.equal(v.layers.length, 12);
  const back = await callVias({ board: CIAA, net: 'GND', near: [100, 100], side: 'B' });
  assert.deepEqual(
    back.structuredContent.vias.map((v) => [v.x, v.y]),
    all.structuredContent.vias.map((v) => [v.x, v.y])
  );
  for (const v of back.structuredContent.vias) assert.equal(v.side, 'B');
});

// On both fixtures: a via without covered_by lies inside no part's box on
// the side it is given for; a via with covered_by lies inside that part's
// box, on that part's side.
for (const [name, rel] of [
  ['netdaq', NETDAQ],
  ['ciaa-acc', CIAA],
]) {
  test(`covered_by matches the part boxes (${name})`, async () => {
    const board = readBoard(rel);
    const byRef = new Map(board.footprints.map((fp) => [fp.ref, fp]));
    let seen = 0;
    let covered = 0;
    for (const [net, side] of [
      ['GND', undefined],
      ['+3.3V', undefined],
      ['+3.3V', 'F'],
      ['+3.3V', 'B'],
    ]) {
      const { structuredContent } = await callVias({ board: rel, net, near: [0, 0], side, limit: 200 });
      for (const v of structuredContent.vias) {
        seen++;
        const sides = v.side === 'both' ? ['F', 'B'] : [v.side];
        if (v.covered_by) {
          covered++;
          const over = byRef.get(v.covered_by);
          assert.ok(sides.includes(over.layer) && pointInFootprint(over, v.x, v.y), `via at ${v.x},${v.y}`);
          continue;
        }
        for (const s of sides) {
          const over = board.footprints.filter((fp) => fp.layer === s && pointInFootprint(fp, v.x, v.y));
          assert.deepEqual(over.map((fp) => fp.ref), [], `via at ${v.x},${v.y} side ${s}`);
        }
      }
    }
    assert.ok(seen > 0);
    assert.ok(covered > 0);
  });
}

test('a zero-length item on one layer, a real track and a via with no net are not vias', async () => {
  const tracks = { F: [], B: [] };
  via(tracks, 1, 0, 'N', ['F']);
  tracks.F.push({ start: [2, 0], end: [3, 0], width: 0.2, net: 'N' });
  tracks.B.push({ start: [2, 0], end: [3, 0], width: 0.2, net: 'N' });
  via(tracks, 4, 0, '', ['F', 'B']);
  via(tracks, 5, 0, 'N', ['F', 'B']);
  const { structuredContent } = await viasOn({ footprints: [], tracks, nets: ['N'] }, { net: 'N', near: [0, 0] });
  assert.deepEqual(structuredContent.vias, [{ x: 5, y: 0, layers: ['F', 'B'], side: 'both', diameter: 0.6, distance: 5 }]);
});

test('a via is reachable only from the outer layers it is on; a buried via is never returned', async () => {
  const tracks = {};
  via(tracks, 1, 0, 'N', ['F', 'In1.Cu']);
  via(tracks, 2, 0, 'N', ['In1.Cu', 'B']);
  via(tracks, 3, 0, 'N', ['In1.Cu', 'In2.Cu']);
  const board = { footprints: [], tracks, nets: ['N'] };
  const all = await viasOn(board, { net: 'N', near: [0, 0] });
  assert.deepEqual(all.structuredContent.vias.map((v) => [v.x, v.side]), [
    [1, 'F'],
    [2, 'B'],
  ]);
  const front = await viasOn(board, { net: 'N', near: [0, 0], side: 'F' });
  assert.deepEqual(front.structuredContent.vias.map((v) => v.x), [1]);
  const back = await viasOn(board, { net: 'N', near: [0, 0], side: 'B' });
  assert.deepEqual(back.structuredContent.vias.map((v) => v.x), [2]);
});

test('copies at one point are one via; drill size is given when the export has it', async () => {
  const tracks = {};
  via(tracks, 0, 0, 'N', ALL4, 0.6, 0.3);
  via(tracks, 0, 0, 'N', ['F', 'B'], 0.6, 0.3);
  const { structuredContent } = await viasOn({ footprints: [], tracks }, { net: 'N', near: [3, 4] });
  assert.deepEqual(structuredContent.vias, [{ x: 0, y: 0, layers: ALL4, side: 'both', diameter: 0.6, drill: 0.3, distance: 5 }]);
});

test('Allegro inner layer names are kept as they are', async () => {
  const tracks = {};
  via(tracks, 0, 0, 'N', ['F', 'ETCH/GND', 'B']);
  const { structuredContent } = await viasOn({ footprints: [], tracks }, { net: 'N', near: [0, 0] });
  assert.deepEqual(structuredContent.vias[0].layers, ['F', 'ETCH/GND', 'B']);
});

test('a via under a part gets covered_by, also under the near part; free on one side, it is given on that side', async () => {
  const tracks = {};
  via(tracks, 0, 0, 'N', ['F', 'B']);
  via(tracks, 10, 0, 'N', ['F', 'B']);
  via(tracks, 20, 0, 'N', ['F', 'B']);
  const board = {
    footprints: [part('U1', 'F', 0, 0, 4), part('U2', 'F', 10, 0), part('U3', 'B', 10, 0), part('U4', 'B', 20, 0)],
    tracks,
  };
  const { structuredContent } = await viasOn(board, { net: 'N', near: 'U1' });
  assert.deepEqual(structuredContent.vias.map((v) => [v.x, v.side, v.covered_by, v.distance]), [
    [0, 'B', undefined, 0],
    [10, 'both', 'U2', 8],
    [20, 'F', undefined, 18],
  ]);
  const front = await viasOn(board, { net: 'N', near: 'U1', side: 'F' });
  assert.deepEqual(front.structuredContent.vias.map((v) => [v.x, v.side, v.covered_by]), [
    [0, 'F', 'U1'],
    [10, 'F', 'U2'],
    [20, 'F', undefined],
  ]);
});

test('limit and max_distance cut the list', async () => {
  const tracks = {};
  for (const i of [1, 2, 3, 4]) via(tracks, i * 10, 0, 'N', ['F', 'B']);
  const board = { footprints: [], tracks };
  const limited = await viasOn(board, { net: 'N', near: [0, 0], limit: 2 });
  assert.deepEqual(limited.structuredContent.vias.map((v) => v.x), [10, 20]);
  const near = await viasOn(board, { net: 'N', near: [0, 0], max_distance: 30 });
  assert.deepEqual(near.structuredContent.vias.map((v) => v.x), [10, 20, 30]);
});

test('a net with only vias is found, also without a net list, and ignoring case', async () => {
  const tracks = {};
  via(tracks, 0, 0, 'Via_Only', ['F', 'B']);
  const { structuredContent } = await viasOn({ footprints: [], tracks }, { net: ' via_only ', near: [0, 0] });
  assert.equal(structuredContent.net, 'Via_Only');
  assert.equal(structuredContent.found, true);
  assert.equal(structuredContent.vias.length, 1);
});

test('vias on other nets are not returned', async () => {
  const tracks = {};
  via(tracks, 0, 0, 'A', ['F', 'B']);
  via(tracks, 1, 0, 'B', ['F', 'B']);
  const { structuredContent } = await viasOn({ footprints: [], tracks }, { net: 'B', near: [0, 0] });
  assert.deepEqual(structuredContent.vias.map((v) => v.x), [1]);
});

test('an unknown refdes is a tool error', async () => {
  const result = await callVias({ board: NETDAQ, net: '+3.3V', near: 'U999' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /U999/);
});
