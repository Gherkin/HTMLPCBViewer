// locate through a real MCP client over HTTP, against both test fixtures
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
import { footprintPlace, pointInFootprint } from '../src/footprints.js';
import { createHttpServer, MCP_PATH } from '../src/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';
const CIAA = 'ciaa/ciaa.json';

let dir;
let pcbs;
let server;
let url;

async function callLocate(args) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    return await client.callTool({ name: 'locate', arguments: args });
  } finally {
    await client.close();
  }
}

function readBoard(rel) {
  return JSON.parse(fs.readFileSync(path.join(pcbs, rel), 'utf8'));
}

function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `${actual} != ${expected}`));
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

test('locate gives side, center, size, angle and extent of a front part (KiCad)', async () => {
  // U24 in netdaq: bbox pos [165, 138.480884], relpos [-2.645, -3.65],
  // size [5.27, 7.3], angle 90. The rectangle center is 0.01 left of the
  // origin in the footprint frame; turned by 90 degrees that is 0.01 down.
  const result = await callLocate({ board: NETDAQ, refs: ['U24'] });
  assert.equal(result.isError, undefined);
  const { parts, not_found } = result.structuredContent;
  assert.deepEqual(not_found, []);
  assert.equal(parts.length, 1);
  const u24 = parts[0];
  assert.equal(u24.ref, 'U24');
  assert.equal(u24.side, 'F');
  assert.equal(u24.angle, 90);
  assertClose(u24.center, [165, 138.490884]);
  assertClose(u24.size, [5.27, 7.3]);
  assertClose(
    [u24.extent.minx, u24.extent.miny, u24.extent.maxx, u24.extent.maxy],
    [161.35, 135.855884, 168.65, 141.125884]
  );
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('locate gives a back-side part in the same board coordinates', async () => {
  // C2 in ciaa-acc: bbox pos [62.2, 96.5], centered on its origin, 0.81 x 0.5, angle 90.
  const { structuredContent } = await callLocate({ board: CIAA, refs: ['C2'] });
  const [c2] = structuredContent.parts;
  assert.equal(c2.side, 'B');
  assertClose(c2.center, [62.2, 96.5]);
  assertClose([c2.extent.minx, c2.extent.miny, c2.extent.maxx, c2.extent.maxy], [61.95, 96.095, 62.45, 96.905]);
});

test('unknown refdes are listed in not_found and the rest still come back', async () => {
  const result = await callLocate({ board: NETDAQ, refs: ['U24', 'U9999', 'r18', 'U24'] });
  assert.equal(result.isError, undefined);
  const { parts, not_found } = result.structuredContent;
  assert.deepEqual(
    parts.map((p) => p.ref),
    ['U24', 'R18']
  );
  assert.deepEqual(not_found, ['U9999']);
});

test('an unknown board is a tool error that points at list_boards', async () => {
  const result = await callLocate({ board: 'nope/nope.json', refs: ['U1'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /list_boards/);
});

test('index.json is not a board', async () => {
  const result = await callLocate({ board: 'index.json', refs: ['U1'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a board payload/);
});

// The rectangle must sit on the part: every pad center inside it, and the
// center the tool reports inside it too. Checked for every footprint on both
// fixtures, so a wrong sign in the rotation shows up on rotated parts.
for (const [name, rel] of [
  ['netdaq', NETDAQ],
  ['ciaa-acc', CIAA],
]) {
  test(`every pad and every reported center is inside its footprint (${name})`, () => {
    const board = readBoard(rel);
    let pads = 0;
    for (const fp of board.footprints) {
      const place = footprintPlace(fp);
      assert.ok(pointInFootprint(fp, ...place.center), `${fp.ref} center outside`);
      for (const pad of fp.pads) {
        // Nudge toward the center so a pad exactly on the edge does not fail on float noise.
        const x = pad.pos[0] + Math.sign(place.center[0] - pad.pos[0]) * 1e-9;
        const y = pad.pos[1] + Math.sign(place.center[1] - pad.pos[1]) * 1e-9;
        assert.ok(pointInFootprint(fp, x, y), `${fp.ref} pad at ${pad.pos} outside`);
        assert.ok(place.extent.minx <= x && x <= place.extent.maxx, `${fp.ref} pad outside extent`);
        assert.ok(place.extent.miny <= y && y <= place.extent.maxy, `${fp.ref} pad outside extent`);
        pads++;
      }
    }
    assert.ok(pads > 0);
  });
}
