// link through a real MCP client over HTTP. The viewer side (that it reads
// these links) is tested in tests/browser/mcp-link.spec.js.

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
import { formatHashPairs, parseBaseUrl, viewerUrl } from '../src/links.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const NETDAQ = 'netdaq/netdaq.json';
const CIAA = 'ciaa/ciaa.json';
const NOPAD = 'netdaq/nopad.json';
const TWOCASE = 'netdaq/twocase.json';

let dir;
let servers = [];
let url;
let urlWithBase;

async function call(where, args) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(where));
  try {
    return await client.callTool({ name: 'link', arguments: args });
  } finally {
    await client.close();
  }
}

async function listen(opts) {
  const server = createHttpServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return new URL(`http://127.0.0.1:${server.address().port}${MCP_PATH}`);
}

// The hash of a link as [[key, value], ...], decoded as the viewer does.
function pairsOf(link) {
  const hash = link.split('#')[1] ?? '';
  return hash
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
    });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-mcp-'));
  const pcbs = path.join(dir, 'pcbs');
  fs.mkdirSync(path.join(dir, 'exports', 'netdaq'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports', 'ciaa'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'netdaq-small.json'), path.join(dir, 'exports', NETDAQ));
  fs.copyFileSync(path.join(FIXTURES, 'ciaa-acc.json'), path.join(dir, 'exports', CIAA));
  execFileSync('python3', ['build_boards.py', '--src', path.join(dir, 'exports'), '--out', pcbs], { cwd: ROOT });

  // netdaq with one more net that has no pads, as a net with only vias has.
  const board = JSON.parse(fs.readFileSync(path.join(pcbs, NETDAQ), 'utf8'));
  board.nets.push('/VIA_ONLY');
  fs.writeFileSync(path.join(pcbs, NOPAD), JSON.stringify(board));
  // And with a net and a copper layer that differ from another only in case.
  board.nets.push('/via_only');
  board.tracks['in1.cu'] = [];
  fs.writeFileSync(path.join(pcbs, TWOCASE), JSON.stringify(board));

  url = await listen({ store: diskStore(pcbs) });
  urlWithBase = await listen({ store: diskStore(pcbs), baseUrl: parseBaseUrl('http://pcbhost:1010', 'VIEWER_URL') });
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the hash is encoded as web/util.js does: / : , @ readable, the rest escaped', () => {
  assert.equal(
    formatHashPairs([['net', '/A B&C=D:E,F@G#%+'], ['comp', 'U1']]),
    'net=/A%20B%26C%3DD:E,F@G%23%25%2B&comp=U1'
  );
});

test('a link selects parts and nets by their board names, in order', async () => {
  const result = await call(urlWithBase, { board: NETDAQ, refs: ['u24', 'R18'], nets: ['+3.3v'] });
  assert.equal(result.isError, undefined);
  const { url: link, warnings, side } = result.structuredContent;
  assert.deepEqual(warnings, []);
  assert.equal(side, undefined);
  assert.equal(link, 'http://pcbhost:1010/viewer/?data=/pcbs/netdaq/netdaq.json#comp=U24&comp=R18&net=%2B3.3V');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('focus, marks, views, zoom, copper and netlayers go in as the README describes', async () => {
  const { structuredContent } = await call(urlWithBase, {
    board: NETDAQ,
    nets: ['/ADC1/INT_ADCIN0', '+3.3V'],
    focus: 'net:/adc1/int_adcin0',
    marks: [{ side: 'F', x: 167.750000001, y: 144.23 }],
    view_f: { minx: 160, miny: 130, maxx: 170, maxy: 136 },
    zoom: 'selected',
    copper: [{ layer: 'f' }, { layer: 'In1.Cu', only: ['tracks', 'vias'] }],
    netlayers: true,
  });
  assert.deepEqual(pairsOf(structuredContent.url), [
    ['net', '/ADC1/INT_ADCIN0'],
    ['net', '+3.3V'],
    ['focus', 'net:/ADC1/INT_ADCIN0'],
    ['side', 'F'],
    ['viewF', '165,133,10,6'],
    ['mark', 'F:167.75,144.23'],
    ['zoom', 'selected'],
    ['copper', 'F'],
    ['copper', 'In1.Cu:tv'],
    ['netlayers', '1'],
  ]);
  assert.equal(structuredContent.side, 'F');
});

test('copper [] hides every layer', async () => {
  const { structuredContent } = await call(urlWithBase, { board: NETDAQ, copper: [] });
  assert.deepEqual(pairsOf(structuredContent.url), [['copper', '']]);
});

// The viewer keeps a view only on a side it shows. Without side= it picks
// the sides from the markers alone, so a back view with a front marker
// would be lost. The link must always carry a side that covers both.
test('a view on one side and a marker on the other give side=FB', async () => {
  const { structuredContent } = await call(urlWithBase, {
    board: NETDAQ,
    marks: [{ side: 'F', x: 150, y: 140 }],
    view_b: { minx: 140, miny: 130, maxx: 160, maxy: 150 },
  });
  const pairs = pairsOf(structuredContent.url);
  assert.deepEqual(pairs.find((p) => p[0] === 'side'), ['side', 'FB']);
  assert.equal(structuredContent.side, 'FB');
});

test('a view alone always sets its side', async () => {
  for (const [key, want] of [
    ['view_f', 'F'],
    ['view_b', 'B'],
  ]) {
    const { structuredContent } = await call(urlWithBase, {
      board: NETDAQ,
      [key]: { minx: 140, miny: 130, maxx: 160, maxy: 150 },
    });
    assert.deepEqual(pairsOf(structuredContent.url).find((p) => p[0] === 'side'), ['side', want]);
  }
});

test('a given side that hides a view or marker is widened, with a warning', async () => {
  const { structuredContent } = await call(urlWithBase, {
    board: NETDAQ,
    side: 'F',
    marks: [{ side: 'B', x: 150, y: 140 }],
  });
  assert.equal(structuredContent.side, 'FB');
  assert.equal(structuredContent.warnings.length, 1);
  assert.match(structuredContent.warnings[0], /side "F" would hide B/);

  // A side that covers everything is kept as given.
  const kept = await call(urlWithBase, { board: NETDAQ, side: 'FB', marks: [{ side: 'B', x: 1, y: 2 }] });
  assert.equal(kept.structuredContent.side, 'FB');
  assert.deepEqual(kept.structuredContent.warnings, []);
});

test('a focused part on the other side of a marker is shown too', async () => {
  // C2 is on the back of ciaa-acc. Without a view the viewer turns to the
  // focused part's side, which would hide a front marker.
  const { structuredContent } = await call(urlWithBase, {
    board: CIAA,
    refs: ['C2'],
    marks: [{ side: 'F', x: 60, y: 90 }],
  });
  assert.equal(structuredContent.side, 'FB');
});

test('a given side that hides the focused part is widened; with zoom the part side is not needed', async () => {
  // No view and no zoom: the viewer turns to C2 (back) whatever side= says.
  const given = await call(urlWithBase, { board: CIAA, refs: ['C2'], side: 'F' });
  assert.equal(given.structuredContent.side, 'FB');
  assert.match(given.structuredContent.warnings[0], /side "F" would hide B/);

  // With zoom the viewer does not turn to the part, so the marker side is enough.
  const zoomed = await call(urlWithBase, {
    board: CIAA,
    refs: ['C2'],
    marks: [{ side: 'F', x: 60, y: 90 }],
    zoom: 'board',
  });
  assert.equal(zoomed.structuredContent.side, 'F');

  // No side, no marker, no view: no side=, the viewer turns to the part.
  const plain = await call(urlWithBase, { board: CIAA, refs: ['C2'] });
  assert.equal(plain.structuredContent.side, undefined);
});

test('a net or copper layer that matches two names when case is ignored says so', async () => {
  const result = await call(urlWithBase, {
    board: TWOCASE,
    nets: ['/Via_Only'],
    copper: [{ layer: 'IN1.CU' }],
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /"\/Via_Only" matches \/VIA_ONLY, \/via_only when case is ignored/);
  assert.match(text, /"IN1.CU" matches In1.Cu, in1.cu when case is ignored/);
});

test('a bad name used twice is listed once', async () => {
  const result = await call(urlWithBase, { board: NETDAQ, refs: ['U9999'], focus: 'comp:U9999' });
  assert.equal(result.content[0].text.match(/No part "U9999"/g).length, 1);
});

test('unknown refdes, nets and copper layers are a tool error that names them all', async () => {
  const result = await call(urlWithBase, {
    board: NETDAQ,
    refs: ['U24', 'U9999'],
    nets: ['NOPE'],
    copper: [{ layer: 'In7.Cu' }],
    focus: 'comp:Q1234',
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /No part "U9999"/);
  assert.match(text, /No net "NOPE"/);
  assert.match(text, /No copper layer "In7.Cu".*In1.Cu/);
  assert.match(text, /No part "Q1234"/);
  assert.doesNotMatch(text, /"U24"/);
});

test('a net with no pads is a tool error: the viewer cannot select it', async () => {
  const result = await call(urlWithBase, { board: NOPAD, nets: ['/VIA_ONLY'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no pads/);
});

test('bad focus, empty views and an unknown board are tool errors', async () => {
  for (const args of [
    { board: NETDAQ, focus: 'U24' },
    { board: NETDAQ, view_f: { minx: 1, miny: 1, maxx: 1, maxy: 2 } },
    // Wider than 0, but 0 after rounding to 4 decimals.
    { board: NETDAQ, view_b: { minx: 10, miny: 5, maxx: 10.00004, maxy: 6 } },
    { board: 'nope/nope.json' },
    { board: NETDAQ, base_url: 'pcbhost:1010' },
    { board: NETDAQ, base_url: 'ftp://pcbhost/' },
  ]) {
    const result = await call(urlWithBase, args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
});

test('without a known address the link is root-relative, with a warning', async () => {
  const { structuredContent } = await call(url, { board: NETDAQ, refs: ['U24'] });
  assert.equal(structuredContent.url, '/viewer/?data=/pcbs/netdaq/netdaq.json#comp=U24');
  assert.equal(structuredContent.warnings.length, 1);
  assert.match(structuredContent.warnings[0], /base_url/);
});

test('base_url wins over the server address and may hold a sub-path', async () => {
  const { structuredContent } = await call(urlWithBase, {
    board: NETDAQ,
    refs: ['U24'],
    base_url: 'https://example.org/pcb?x=1#y',
  });
  assert.equal(structuredContent.url, 'https://example.org/pcb/viewer/?data=/pcb/pcbs/netdaq/netdaq.json#comp=U24');
  assert.deepEqual(structuredContent.warnings, []);
});

test('board paths are escaped in the query, slashes kept', () => {
  assert.equal(
    viewerUrl(parseBaseUrl('http://h/', 'x'), 'lab/rev 2/a&b.json', ''),
    'http://h/viewer/?data=/pcbs/lab/rev%202/a%26b.json'
  );
});
