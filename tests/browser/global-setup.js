// Builds the pages under test from the fixture before every run (#27).
// The .html files are ignored by git and inline web/, so a copy left on disk
// goes stale as soon as the viewer code or the fixture changes.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'netdaq-small.json');

function generate(input, output) {
  execFileSync('python3', ['generate.py', input, '-o', output], { cwd: ROOT, stdio: 'inherit' });
}

// The fixture with ten more inner layers, In3.Cu to In12.Cu. Each holds one
// routed track from In2.Cu, so its net reaches every layer.
function manyLayersBoard() {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const tracks = data.pcbdata.tracks;
  const padNets = new Set(data.pcbdata.footprints.flatMap((fp) => (fp.pads || []).map((p) => p.net)));
  const track = tracks['In2.Cu'].find(
    (t) => padNets.has(t.net) && t.start && !(t.start[0] === t.end[0] && t.start[1] === t.end[1])
  );
  for (let n = 3; n <= 12; n++) tracks[`In${n}.Cu`] = [track];
  return writeTemp(data, 'many-layers.json');
}

// The fixture with every board outline edge listed twice, as some exports do.
function doubledOutlineBoard() {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  data.pcbdata.edges = data.pcbdata.edges.concat(data.pcbdata.edges);
  return writeTemp(data, 'doubled-outline.json');
}

// The fixture with two more outline islands right of the board: a circle made
// of two half arcs and a lens made of two curves. Each pair shares its
// endpoints, so only the middle point in the outline dedup key keeps the two
// halves apart. With doubled, every edge is listed twice.
function outlineShapesBoard(doubled) {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const w = 0.05;
  const shapes = [
    { type: 'arc', start: [235, 80], radius: 10, startangle: 0, endangle: 180, width: w },
    { type: 'arc', start: [235, 80], radius: 10, startangle: 180, endangle: 360, width: w },
    { type: 'curve', start: [225, 130], cpa: [228, 118], cpb: [242, 118], end: [245, 130], width: w },
    { type: 'curve', start: [225, 130], cpa: [228, 142], cpb: [242, 142], end: [245, 130], width: w },
  ];
  let edges = data.pcbdata.edges.concat(shapes);
  if (doubled) edges = edges.concat(edges);
  data.pcbdata.edges = edges;
  return writeTemp(data, 'outline-shapes.json');
}

// The fixture with one more outline island, a circle at negative
// coordinates, so the board does not sit in the positive quadrant.
function offOriginBoard() {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  data.pcbdata.edges = data.pcbdata.edges.concat([
    { type: 'circle', start: [-60, -40], radius: 25, width: 0.05 },
  ]);
  return writeTemp(data, 'off-origin.json');
}

// Writes a changed fixture to a new temp dir, which generateTemp removes.
function writeTemp(data, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function generateTemp(input, output) {
  try {
    generate(input, output);
  } finally {
    fs.rmSync(path.dirname(input), { recursive: true, force: true });
  }
}

module.exports = function globalSetup() {
  generate('tests/fixtures/netdaq-small.json', 'tests/browser/board.html');
  generate('tests/fixtures/ciaa-acc.json', 'tests/browser/ciaa-acc.html');
  generateTemp(manyLayersBoard(), 'tests/browser/many-layers.html');
  generateTemp(doubledOutlineBoard(), 'tests/browser/doubled-outline.html');
  generateTemp(outlineShapesBoard(false), 'tests/browser/outline-shapes.html');
  generateTemp(outlineShapesBoard(true), 'tests/browser/outline-shapes-doubled.html');
  generateTemp(offOriginBoard(), 'tests/browser/off-origin.html');
};
