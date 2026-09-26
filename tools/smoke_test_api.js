// Exercise window.__pcbaTest without a browser.
//
//   node tools/smoke_test_api.js <board.json>
//
// Loads util.js + render.js + app.js into one vm context with permissive DOM
// stubs, feeds it a board, and calls every test API method.
//
// This does NOT check rendering, and it is not a substitute for the browser
// tests. It checks that the API evaluates, that it finds the globals it
// reaches for, and that everything it returns survives JSON serialisation,
// which is what Playwright's page.evaluate() does. Useful as a fast guard
// against the test API silently breaking when internals get renamed.
//
// Generate a board with tools/make_fixture.py.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const WEB = path.join(__dirname, "..", "web");
const BOARD = process.argv[2];

if (!BOARD) {
  console.log("usage: node tools/smoke_test_api.js <board.json>");
  process.exit(2);
}

// --- permissive DOM stubs -------------------------------------------------
function makeEl() {
  const el = {
    style: {}, dataset: {}, classList: {
      toggle() {}, add() {}, remove() {}, contains() { return false; },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, insertBefore() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0 }; },
    getContext() { return null; },
    focus() {}, click() {}, remove() {},
    innerHTML: "", textContent: "", value: "", checked: false,
    children: [], parentNode: null, offsetWidth: 800, offsetHeight: 600,
  };
  return el;
}

const storage = {
  _d: {},
  getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const sandbox = {
  console,
  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
  requestAnimationFrame(cb) { return setTimeout(() => cb(performance.now()), 0); },
  cancelAnimationFrame(id) { clearTimeout(id); },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Worker: function () { this.postMessage = () => {}; this.terminate = () => {}; },
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  Blob: function () {},
  Set, Map, JSON, Math, Object, Array, String, Number, Date, Promise, RegExp,
  localStorage: storage,
  sessionStorage: storage,
  navigator: { userAgent: "node" },
  location: { search: "" },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener() {},
  body: makeEl(),
  documentElement: makeEl(),
};

vm.createContext(sandbox);

// --- board data -----------------------------------------------------------
const envelope = JSON.parse(fs.readFileSync(BOARD, "utf8"));
const pcb = Object.assign({}, envelope.pcbdata);
if (envelope.components) pcb.components = envelope.components;
sandbox.pcbdata = pcb;
sandbox.pcbdataReady = Promise.resolve();

// --- load the app ---------------------------------------------------------
const files = ["util.js", "render.js", "app.js"];
for (const f of files) {
  let src = fs.readFileSync(path.join(WEB, f), "utf8");
  // render.js inlines the worker via a placeholder that generate.py fills.
  src = src.replace("///RENDERWORKERJS_INLINE///", "");
  try {
    vm.runInContext(src, sandbox, { filename: f });
    console.log(`loaded ${f}`);
  } catch (e) {
    console.log(`FAILED loading ${f}: ${e.message}`);
    process.exit(1);
  }
}

// --- exercise the API -----------------------------------------------------
const api = sandbox.window.__pcbaTest;
if (!api) { console.log("FAIL: window.__pcbaTest is not defined"); process.exit(1); }

let failures = 0;
function check(name, fn) {
  try {
    const v = fn();
    JSON.stringify(v); // must be serialisable, Playwright does this
    console.log(`  ok  ${name}: ${JSON.stringify(v).slice(0, 120)}`);
  } catch (e) {
    console.log(`  FAIL ${name}: ${e.message}`);
    failures++;
  }
}

console.log(`\n__pcbaTest.version = ${api.version}`);
check("ready()", () => api.ready());
check("timings()", () => api.timings());
check("sides()", () => api.sides());
check("renderStats('F')", () => api.renderStats("F"));
check("counters()", () => api.counters());
check("state()", () => api.state());

// buildIndexes() has not run (no load event), so netLayers needs it first.
sandbox.buildIndexes();
check("counters() after buildIndexes", () => api.counters());
const someNet = Object.keys(sandbox.netToComponents)[0];
check(`netLayers(${JSON.stringify(someNet)})`, () => api.netLayers(someNet));

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
