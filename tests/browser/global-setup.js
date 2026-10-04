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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbviewer-'));
  const file = path.join(dir, 'many-layers.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

module.exports = function globalSetup() {
  generate('tests/fixtures/netdaq-small.json', 'tests/browser/board.html');
  const manyLayers = manyLayersBoard();
  try {
    generate(manyLayers, 'tests/browser/many-layers.html');
  } finally {
    fs.rmSync(path.dirname(manyLayers), { recursive: true, force: true });
  }
};
