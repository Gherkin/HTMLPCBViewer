// Builds the page under test from the fixture before every run (#27).
// board.html is ignored by git and inlines web/, so a copy left on disk goes
// stale as soon as the viewer code or the fixture changes.

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = function globalSetup() {
  execFileSync(
    'python3',
    ['generate.py', 'tests/fixtures/netdaq-small.json', '-o', 'tests/browser/board.html'],
    { cwd: ROOT, stdio: 'inherit' }
  );
};
