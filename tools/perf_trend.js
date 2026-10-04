// Per-commit wall-clock trend for the perf spec (#18).
//
//   node tools/perf_trend.js check  <wall-clock.json> <history-dir>
//   node tools/perf_trend.js record <wall-clock.json> <history-dir> <sha> <commit-date>
//
// <wall-clock.json> is what tests/browser/perf.spec.js writes when
// PERF_WALLCLOCK_OUT is set. <history-dir> holds one JSON file per commit on
// main. CI keeps it on the perf-history branch.
//
// check compares render p50/p90/p99 and droppedFrames, per canvas side,
// against the median of the last HISTORY_WINDOW entries. It fails only when a
// value moves by FACTOR or more in either direction. The numbers come from a
// GitHub-hosted runner, so smaller changes are noise. Values are raised to a
// floor before comparing, so 0.5ms against 2ms does not count as 4x. With no
// history yet, check passes.
//
// record writes one file named <commit-date>-<sha>, so the files sort in
// commit order and two runs never touch the same file.

const fs = require("fs");
const path = require("path");

const FACTOR = 10;
const HISTORY_WINDOW = 10;
// Render times are in ms. droppedFrames is a count of renders over 100ms.
const FLOOR = { p50: 5, p90: 5, p99: 5, droppedFrames: 1 };

function usage() {
  console.log("usage: node tools/perf_trend.js check  <wall-clock.json> <history-dir>");
  console.log("       node tools/perf_trend.js record <wall-clock.json> <history-dir> <sha> <commit-date>");
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Flatten one wall-clock result to { "F.p50": 5.7, "F.droppedFrames": 0, ... }.
// Sides that did not render are left out.
function metrics(wallClock) {
  const out = {};
  const stats = wallClock.renderStats || {};
  for (const side of Object.keys(stats)) {
    const s = stats[side];
    if (!s) continue;
    out[side + ".p50"] = s.total.p50;
    out[side + ".p90"] = s.total.p90;
    out[side + ".p99"] = s.total.p99;
    out[side + ".droppedFrames"] = s.droppedFrames;
  }
  return out;
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function loadHistory(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson(path.join(dir, f)));
}

function check(wallClockFile, historyDir) {
  const current = metrics(readJson(wallClockFile));
  const history = loadHistory(historyDir).slice(-HISTORY_WINDOW);
  if (history.length === 0) {
    console.log("no perf history yet, nothing to compare against");
    return 0;
  }
  const past = history.map((h) => metrics(h.wallClock));
  console.log("comparing against the median of the last " + history.length + " commits on main");
  console.log("fails on a change of " + FACTOR + "x or more\n");

  let failed = 0;
  for (const key of Object.keys(current)) {
    const values = past.map((m) => m[key]).filter((v) => typeof v === "number");
    if (values.length === 0) continue;
    const ref = median(values);
    const floor = FLOOR[key.split(".")[1]];
    const ratio = Math.max(current[key], floor) / Math.max(ref, floor);
    const bad = ratio >= FACTOR || ratio <= 1 / FACTOR;
    if (bad) failed++;
    console.log(
      (bad ? "FAIL " : "ok   ") + key.padEnd(18) +
      " now " + String(round(current[key])).padStart(8) +
      "  median " + String(round(ref)).padStart(8) +
      "  x" + round(ratio)
    );
  }
  if (failed) {
    console.log("\n" + failed + " wall-clock metric(s) changed by " + FACTOR + "x or more");
    return 1;
  }
  return 0;
}

function round(x) {
  return Math.round(x * 100) / 100;
}

function record(wallClockFile, historyDir, sha, commitDate) {
  const date = new Date(commitDate);
  if (isNaN(date)) {
    console.log("bad commit date: " + commitDate);
    return 2;
  }
  // 2026-10-04T12:34:56.000Z -> 20261004T123456Z
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const file = path.join(historyDir, stamp + "-" + sha.slice(0, 12) + ".json");
  const entry = { sha: sha, date: date.toISOString(), wallClock: readJson(wallClockFile) };
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
  console.log("wrote " + file);
  return 0;
}

const [cmd, wallClockFile, historyDir, sha, commitDate] = process.argv.slice(2);
if (cmd === "check" && wallClockFile && historyDir) {
  process.exit(check(wallClockFile, historyDir));
} else if (cmd === "record" && wallClockFile && historyDir && sha && commitDate) {
  process.exit(record(wallClockFile, historyDir, sha, commitDate));
} else {
  usage();
}
