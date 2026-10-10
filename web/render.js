/* PCBA Bringup Viewer - Render Coordinator
 *
 * Copyright (c) 2026 Gherkin
 * Copyright (c) 2018 qu1ck
 * SPDX-License-Identifier: MIT
 *
 * Derived from InteractiveHtmlBom (MIT), web/render.js:
 *   https://github.com/openscopeproject/InteractiveHtmlBom
 * See LICENSE and NOTICE for the full notice.
 *
 * This is the main-thread coordinator.  All heavy Canvas2D drawing has been
 * moved to render-worker.js (runs in a Web Worker on an OffscreenCanvas).
 *
 * This file handles:
 *   - Worker lifecycle (Blob URL creation, message passing)
 *   - CSS transform for instant pan/zoom (GPU-composited)
 *   - ImageBitmap blitting from worker buffers onto visible canvases
 *   - Hit-testing (needs main-thread isPointInPath)
 *   - Pointer / mouse event handling
 *   - Public API surface consumed by app.js
 */

var emptyContext2d = document.createElement("canvas").getContext("2d");

// ---- Tuning parameters ----
var OVERSCAN_RATIO     = 2.0;
var REFILL_THRESHOLD   = 0.55;
var ZOOM_SETTLE_MS     = 50;
var ZOOM_WHEEL_RENDER_RATIO = 1.5;
var ZOOM_RERENDER_THRESHOLD = 1.8;
var LOOKAHEAD_MS       = 300;
var VELOCITY_EMA_DECAY = 0.85;
var MAX_CANVAS_DIM     = 16384;
var BACKDROP_DELAY_MS  = 100;

// ---- Worker ----
var _worker = null;
var _workerReady = false;
var _pendingRenders = {};  // side -> true (de-duplicate in-flight requests)
var _dirtyRenders = {};    // side -> true (re-render needed after in-flight completes)

function initWorker() {
  // Worker script is inlined by generate.py as a string literal
  var workerCode = "///RENDERWORKERJS_INLINE///";
  var blob = new Blob([workerCode], { type: "application/javascript" });
  _worker = new Worker(URL.createObjectURL(blob));
  _worker.onmessage = handleWorkerMessage;
}

function postRender(side) {
  if (!_worker || !_workerReady) return;
  // If a render is already in-flight, mark dirty so we re-render when it completes
  if (_pendingRenders[side]) {
    _dirtyRenders[side] = true;
    return;
  }
  _pendingRenders[side] = true;
  _dirtyRenders[side] = false;
  // The backdrop waits until the renders stop. The next blit asks again.
  if (_backdropTimers[side]) {
    clearTimeout(_backdropTimers[side]);
    delete _backdropTimers[side];
  }

  var layerdict = side === "F" ? allcanvas.front : allcanvas.back;
  var t = layerdict.transform;
  var divId = side === "F" ? "frontcanvas" : "backcanvas";
  var div = document.getElementById(divId);
  if (!div) return;

  updateStyleCache();

  // Collect selection colors from app.js peekSelectionColor/getSelectionColor.
  // Hovered items get the colour a click would give them (#35).
  var selColors = {};
  var hover = {
    nets: typeof hoverNets !== 'undefined' ? hoverNets : [],
    footprints: typeof highlightedFootprints !== 'undefined' ? highlightedFootprints : [],
  };
  if (typeof peekSelectionColor === 'function') {
    if (highlightedNet !== null) {
      var c = peekSelectionColor('net', highlightedNet);
      if (c) selColors['net:' + highlightedNet] = c;
    }
    for (var netName of hover.nets) {
      var c = peekSelectionColor('net', netName);
      if (c) selColors['net:' + netName] = c;
    }
    for (var idx of hover.footprints) {
      var c = peekSelectionColor('comp', idx);
      if (c) selColors['comp:' + idx] = c;
    }
  }
  if (typeof getSelectionColor === 'function' && highlightedNetPath) {
    for (var netName of highlightedNetPath) {
      var c = getSelectionColor('net', netName);
      if (c) selColors['net:' + netName] = c;
    }
  }

  var highlights = {
    net: typeof highlightedNet !== 'undefined' ? highlightedNet : null,
    netPath: typeof highlightedNetPath !== 'undefined' ? highlightedNetPath : [],
    pinned: typeof pinnedComponents !== 'undefined' ? pinnedComponents : {},
    hover: hover,
    selectionColors: selColors,
  };

  _worker.postMessage({
    type: "render",
    side: side,
    transform: { zoom: t.zoom, panx: t.panx, pany: t.pany, s: t.s, x: t.x, y: t.y },
    settings: gatherSettings(),
    styleCache: _styleCache,
    highlights: highlights,
    viewportW: div.clientWidth * devicePixelRatio,
    viewportH: div.clientHeight * devicePixelRatio,
    dpr: devicePixelRatio,
  });
  markRenderPost(side);
  layerdict._posted = { zoom: t.zoom, panx: t.panx, pany: t.pany };
}

function gatherSettings() {
  var show = {};
  getCopperLayers().forEach(function(l) {
    show[l] = {};
    ["all", "tracks", "zones", "vias", "pads", "silk", "fab"].forEach(function(k) {
      show[l][k] = layerShows(l, k);
    });
  });
  return {
    renderReferences: settings.renderReferences,
    renderValues: settings.renderValues,
    highlightpin1: settings.highlightpin1,
    boardRotation: settings.boardRotation,
    shadowMode: settings.shadowMode,
    shadowBrightness: settings.shadowBrightness,
    shadowSaturation: settings.shadowSaturation,
    show: show,
  };
}

function handleWorkerMessage(e) {
  var msg = e.data;

  if (msg.type === "ready") {
    _workerReady = true;
    _innerLayerNames = msg.innerLayers || [];
    // Now do initial render
    renderBuffers(allcanvas.front);
    renderBuffers(allcanvas.back);
    return;
  }

  if (msg.type === "rendered") {
    _pendingRenders[msg.side] = false;
    blitBitmaps(msg);
    // If a render was requested while this one was in-flight, fire it now
    if (_dirtyRenders[msg.side]) {
      _dirtyRenders[msg.side] = false;
      var ld = msg.side === "F" ? allcanvas.front : allcanvas.back;
      renderBuffers(ld);
    }
    return;
  }

  if (msg.type === "backdrop") {
    _backdropPending[msg.side] = false;
    blitBackdrop(msg);
    return;
  }
}

// ---- Backdrop ----
//
// The whole board at the fit zoom, under the normal layers. The buffer is
// only 2x the viewport, so zooming out faster than the renders arrive leaves
// the edges empty. The backdrop shows there instead, blurred. It is moved by
// CSS for pan and zoom, and drawn again only when what is drawn changes.

var _backdropTimers = {};   // side -> timeout
var _backdropPending = {};  // side -> true while the worker draws it

function backdropViewport(layerdict) {
  var div = document.getElementById(layerdict.layer === "B" ? "backcanvas" : "frontcanvas");
  if (!div) return { w: 0, h: 0 };
  return {
    w: Math.round(div.clientWidth * devicePixelRatio),
    h: Math.round(div.clientHeight * devicePixelRatio),
  };
}

// Everything the backdrop is drawn from. Pan, zoom and highlights are not in it.
function backdropKey(layerdict) {
  var s = gatherSettings();
  var t = layerdict.transform;
  var vp = backdropViewport(layerdict);
  return JSON.stringify([
    s.show, s.renderReferences, s.renderValues, s.highlightpin1, s.boardRotation,
    _styleCache, t.s, t.x, t.y, vp.w, vp.h,
  ]);
}

function scheduleBackdrop(layerdict) {
  var side = layerdict.layer;
  if (!layerdict.backdrop || _backdropTimers[side]) return;
  if (backdropKey(layerdict) === layerdict._backdropKey) return;
  _backdropTimers[side] = setTimeout(function() {
    delete _backdropTimers[side];
    // A render went out since. Its blit schedules this again.
    if (_pendingRenders[side]) return;
    var vp = backdropViewport(layerdict);
    if (vp.w <= 0 || vp.h <= 0) return;
    updateStyleCache();
    var key = backdropKey(layerdict);
    if (key === layerdict._backdropKey) return;
    layerdict._backdropKey = key;
    _backdropPending[side] = true;
    var t = layerdict.transform;
    _worker.postMessage({
      type: "backdrop",
      side: side,
      transform: { zoom: 1, panx: 0, pany: 0, s: t.s, x: t.x, y: t.y },
      settings: gatherSettings(),
      styleCache: _styleCache,
      viewportW: vp.w,
      viewportH: vp.h,
    });
  }, BACKDROP_DELAY_MS);
}

function blitBackdrop(msg) {
  var layerdict = msg.side === "F" ? allcanvas.front : allcanvas.back;
  var c = layerdict.backdrop;
  var bitmap = msg.bitmap;
  if (c.width !== bitmap.width || c.height !== bitmap.height) {
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.style.width = (bitmap.width / devicePixelRatio) + "px";
    c.style.height = (bitmap.height / devicePixelRatio) + "px";
  }
  var ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  c.style.display = "block";
  updateBackdropTransform(layerdict);

  if (!_stats[msg.side]) _stats[msg.side] = makeStatsTracker();
  _stats[msg.side].backdrops++;
  _stats[msg.side].drawCalls += msg.drawCalls || 0;
  _stats[msg.side].itemsVisited += msg.itemsVisited || 0;
}

// Drawn at zoom 1 and no pan, so the transform is the view itself.
function updateBackdropTransform(layerdict) {
  var c = layerdict.backdrop;
  if (!c) return;
  var t = layerdict.transform;
  var tx = t.zoom * t.panx / devicePixelRatio;
  var ty = t.zoom * t.pany / devicePixelRatio;
  c.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + t.zoom + ")";
}

// ---- Render performance stats ----
//
// Sliding-window quantile tracker.  Keeps the last WINDOW_SIZE samples,
// computes p50/p90/p99/min/max, and prints a rich summary every LOG_INTERVAL ms.
// Phase breakdown from the worker is aggregated alongside totals.
// Round-trip time (post → blit) is also measured.

var STATS_WINDOW   = 200;   // samples to keep
var STATS_LOG_MS   = 3000;  // log interval

var _stats = {};            // side → StatsTracker

function makeStatsTracker() {
  return {
    total: [],              // elapsed ms per render (ring)
    roundTrip: [],          // post→blit ms (ring)
    phases: {},             // phase name → ms[] (ring)
    writeIdx: 0,
    count: 0,
    _lastLog: 0,
    _postTimes: {},         // side render id → postTime
    _nextId: 0,
    zoomToSharp: [],        // last wheel event → blit at that zoom, ms (ring)
    zoomToSharpCount: 0,
    droppedFrames: 0,       // renders where elapsed > 100ms
    drawCalls: 0,           // canvas draw calls, summed over all renders and backdrops
    itemsVisited: 0,        // items the culling looked at, summed like drawCalls
    posts: 0,               // render requests posted to the worker
    backdrops: 0,           // backdrops drawn
    last: null,             // the last render: elapsed, phases, drawCalls, itemsVisited
  };
}

function pushSample(arr, idx, val) {
  if (arr.length < STATS_WINDOW) arr.push(val);
  else arr[idx % STATS_WINDOW] = val;
}

function quantile(arr, count, q) {
  if (count === 0) return 0;
  var n = Math.min(count, arr.length);
  var sorted = arr.slice(0, n).sort(function(a, b) { return a - b; });
  var i = Math.floor((n - 1) * q);
  return sorted[i];
}

function arrMin(arr, count) { return quantile(arr, count, 0); }
function arrMax(arr, count) { return quantile(arr, count, 1); }

function recordRenderStats(side, msg, roundTripMs) {
  if (!_stats[side]) _stats[side] = makeStatsTracker();
  var s = _stats[side];
  var idx = s.writeIdx;

  pushSample(s.total, idx, msg.elapsed);
  pushSample(s.roundTrip, idx, roundTripMs);

  if (msg.phases) {
    for (var pName in msg.phases) {
      if (pName === "innerCount") continue;
      if (!s.phases[pName]) s.phases[pName] = [];
      pushSample(s.phases[pName], idx, msg.phases[pName]);
    }
  }

  if (msg.elapsed > 100) s.droppedFrames++;
  s.drawCalls += msg.drawCalls || 0;
  s.itemsVisited += msg.itemsVisited || 0;
  s.last = {
    elapsed: msg.elapsed,
    phases: msg.phases || {},
    drawCalls: msg.drawCalls || 0,
    itemsVisited: msg.itemsVisited || 0,
  };

  s.writeIdx++;
  s.count++;

  var now = performance.now();
  if (now - s._lastLog >= STATS_LOG_MS) {
    printStats(side, s, msg);
    s._lastLog = now;
  }
}

function printStats(side, s, lastMsg) {
  var n = s.count;

  // Summary line
  var p50  = Math.round(quantile(s.total, n, 0.50));
  var p90  = Math.round(quantile(s.total, n, 0.90));
  var p99  = Math.round(quantile(s.total, n, 0.99));
  var tMin = Math.round(arrMin(s.total, n));
  var tMax = Math.round(arrMax(s.total, n));

  var rtp50 = Math.round(quantile(s.roundTrip, n, 0.50));
  var rtp90 = Math.round(quantile(s.roundTrip, n, 0.90));

  var zoomStr = "";
  if (s.zoomToSharpCount > 0) {
    zoomStr = "  |  zoom→sharp p50=" + Math.round(quantile(s.zoomToSharp, s.zoomToSharpCount, 0.50)) +
      " p90=" + Math.round(quantile(s.zoomToSharp, s.zoomToSharpCount, 0.90)) + "ms";
  }

  // Active layers description
  var own = ((lastMsg._settings || {}).show || {})[side] || {};
  var far = ((lastMsg._settings || {}).show || {})[side === "F" ? "B" : "F"] || {};
  var layers = [];
  if (own.pads) layers.push("pads");
  if (own.tracks) layers.push("trk");
  if (own.zones) layers.push("zones");
  if (own.silk) layers.push("silk");
  if (own.fab) layers.push("fab");
  if (far.all) layers.push("xray");
  var innerN = (lastMsg.phases && lastMsg.phases.innerCount) || 0;
  if (innerN > 0) layers.push("inner×" + innerN);
  var layerStr = layers.join("+") || "none";

  console.log(
    "%c[perf " + side + "]%c " +
    " p50=" + p50 + " p90=" + p90 + " p99=" + p99 +
    "  min=" + tMin + " max=" + tMax + "ms" +
    "  |  rt p50=" + rtp50 + " p90=" + rtp90 + "ms" + zoomStr +
    "  |  n=" + n + " dropped=" + s.droppedFrames +
    "  |  buf=" + lastMsg.bufW + "×" + lastMsg.bufH +
    "  |  " + layerStr,
    "color:#268bd2;font-weight:bold", "color:inherit"
  );

  // Phase breakdown (last render)
  if (lastMsg.phases) {
    var parts = [];
    var phaseOrder = ["zones","tracks","footprints","vias","xray","silk","fab","highlights","inner"];
    for (var pName of phaseOrder) {
      if (lastMsg.phases[pName] === undefined) continue;
      var pArr = s.phases[pName];
      if (!pArr || pArr.length === 0) continue;
      var pp50 = Math.round(quantile(pArr, n, 0.50));
      var pp90 = Math.round(quantile(pArr, n, 0.90));
      parts.push(pName + "=" + pp50 + "/" + pp90);
    }
    if (parts.length > 0) {
      console.log("  %c[phases " + side + "]%c " + parts.join("  "),
        "color:#859900;font-weight:bold", "color:inherit");
    }
  }
}

// Called when posting a render request — record the wall-clock time
function markRenderPost(side) {
  if (!_stats[side]) _stats[side] = makeStatsTracker();
  _stats[side]._postTime = performance.now();
  _stats[side].posts++;
}

// True when no render is in flight, queued, or waiting on a frame or timer.
// The perf tests wait for this between input steps, because coalescing makes
// the render count of a fast burst of input depend on machine speed.
function renderIdle() {
  if (!_workerReady) return false;
  for (var k in _pendingRenders) if (_pendingRenders[k]) return false;
  for (var k in _dirtyRenders) if (_dirtyRenders[k]) return false;
  for (var k in _backdropPending) if (_backdropPending[k]) return false;
  return Object.keys(_rafHandles).length === 0 &&
    Object.keys(_refillHandles).length === 0 &&
    Object.keys(_zoomSettleTimers).length === 0 &&
    Object.keys(_backdropTimers).length === 0;
}

function getRoundTrip(side) {
  if (!_stats[side] || !_stats[side]._postTime) return 0;
  return performance.now() - _stats[side]._postTime;
}

// ---- Bitmaps blit ----

function blitBitmaps(msg) {
  var side = msg.side;
  var layerdict = side === "F" ? allcanvas.front : allcanvas.back;

  // Skip blit if worker returned empty (hidden tab / zero-dimension viewport)
  if (!msg.bitmaps) {
    layerdict._bufferState = msg.bufferState;
    return;
  }

  // Save the buffer state from the worker's render
  layerdict._bufferState = msg.bufferState;
  layerdict._overscan = msg.overscan;
  layerdict._bufW = msg.bufW;
  layerdict._bufH = msg.bufH;

  function sizeCanvas(c, w, h) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.width = (w / devicePixelRatio) + "px";
      c.style.height = (h / devicePixelRatio) + "px";
    }
  }

  var bitmaps = msg.bitmaps;
  var bufW = msg.bufW;
  var bufH = msg.bufH;

  // Blit main canvases
  var canvasPairs = [
    [layerdict.bg, bitmaps.bg],
    [layerdict.silk, bitmaps.silk],
    [layerdict.fab, bitmaps.fab],
    [layerdict.highlight, bitmaps.highlight],
  ];

  for (var pair of canvasPairs) {
    var canvas = pair[0];
    var bitmap = pair[1];
    if (!canvas) continue;
    if (bitmap) {
      sizeCanvas(canvas, bufW, bufH);
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, bufW, bufH);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } else {
      // No content for this layer — clear it
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Blit inner layer composite canvases
  var innerComp = msg.innerComposite;
  var innerBgCanvas = side === "F" ? allcanvas.innerCompBg : allcanvas.innerBackCompBg;
  var innerHlCanvas = side === "F" ? allcanvas.innerCompHl : allcanvas.innerBackCompHl;

  if (innerComp && innerComp.bg && innerBgCanvas) {
    sizeCanvas(innerBgCanvas, bufW, bufH);
    var ibCtx = innerBgCanvas.getContext("2d");
    ibCtx.clearRect(0, 0, bufW, bufH);
    ibCtx.drawImage(innerComp.bg, 0, 0);
    innerComp.bg.close();
    innerBgCanvas.style.display = "block";
  } else if (innerBgCanvas) {
    innerBgCanvas.style.display = "none";
  }

  if (innerComp && innerComp.hl && innerHlCanvas) {
    sizeCanvas(innerHlCanvas, bufW, bufH);
    var ihCtx = innerHlCanvas.getContext("2d");
    ihCtx.clearRect(0, 0, bufW, bufH);
    ihCtx.drawImage(innerComp.hl, 0, 0);
    innerComp.hl.close();
    innerHlCanvas.style.display = "block";
  } else if (innerHlCanvas) {
    innerHlCanvas.style.display = "none";
  }

  // Log render performance
  var rtMs = getRoundTrip(side);
  msg._settings = gatherSettings(); // attach for layer description in stats
  recordRenderStats(side, msg, rtMs);

  // Time the blur after a wheel zoom: from the last wheel event until a
  // buffer drawn at that zoom is on screen.
  if (layerdict._lastWheel && msg.bufferState && msg.bufferState.zoom === layerdict.transform.zoom) {
    var zs = _stats[side];
    pushSample(zs.zoomToSharp, zs.zoomToSharpCount, performance.now() - layerdict._lastWheel);
    zs.zoomToSharpCount++;
    layerdict._lastWheel = 0;
  }

  // Apply shadow filter (DOM access, must be on main thread)
  applyShadowFilter(layerdict, msg.hasShadow);

  // Update CSS transform to match current pan/zoom vs buffer state
  updateCSSTransform(layerdict);

  // Check if we already need another render (e.g. zoom changed while worker was busy)
  if (needsBufferRefill(layerdict)) {
    scheduleBufferRefill(layerdict);
  }

  scheduleBackdrop(layerdict);
}

// ---- Render scheduling ----
var _rafHandles = {};

function scheduleRedraw(canvasdict) {
  var key = canvasdict.layer;
  if (_rafHandles[key]) cancelAnimationFrame(_rafHandles[key]);
  _rafHandles[key] = requestAnimationFrame(function() {
    delete _rafHandles[key];
    renderBuffers(canvasdict);
  });
}

function scheduleRedrawAll() {
  scheduleRedraw(allcanvas.front);
  scheduleRedraw(allcanvas.back);
}

// ---- Layer color palette (kept for hit-test tooltip colors) ----
var NET_WALK_PALETTE = ["#b58900","#2aa198","#d33682","#859900","#6c71c4","#cb4b16","#dc322f","#268bd2"];
var LAYER_COLORS = {
  "F": "#268bd2", "B": "#dc322f",
  "ETCH/LAY2": "#2aa198", "ETCH/LAY3": "#859900", "ETCH/LAY4": "#b58900",
  "ETCH/LAY5": "#cb4b16", "ETCH/LAY6": "#d33682", "ETCH/LAY7": "#6c71c4",
};

function getLayerColor(layer) {
  if (LAYER_COLORS[layer]) return LAYER_COLORS[layer];
  var m = layer.match(/(\d+)/);
  if (m) {
    var key = "ETCH/LAY" + m[1];
    if (LAYER_COLORS[key]) return LAYER_COLORS[key];
  }
  var h = 0;
  for (var i = 0; i < layer.length; i++) h = (h * 31 + layer.charCodeAt(i)) >>> 0;
  return "#" + Math.floor(Math.abs(Math.sin(h * 7919) * 0xffffff)).toString(16).padStart(6, "0");
}

// ---- Utility functions (needed for hit-testing and transform) ----

function deg2rad(deg) { return deg * Math.PI / 180; }

function rotateVector(v, angle) {
  angle = deg2rad(angle);
  return [
    v[0] * Math.cos(angle) - v[1] * Math.sin(angle),
    v[0] * Math.sin(angle) + v[1] * Math.cos(angle)
  ];
}

function applyRotation(bbox) {
  var corners = [
    [bbox.minx, bbox.miny], [bbox.minx, bbox.maxy],
    [bbox.maxx, bbox.miny], [bbox.maxx, bbox.maxy],
  ];
  corners = corners.map((v) => rotateVector(v, settings.boardRotation));
  return {
    minx: corners.reduce((a, v) => Math.min(a, v[0]), Infinity),
    miny: corners.reduce((a, v) => Math.min(a, v[1]), Infinity),
    maxx: corners.reduce((a, v) => Math.max(a, v[0]), -Infinity),
    maxy: corners.reduce((a, v) => Math.max(a, v[1]), -Infinity),
  };
}

// Compute tight board bbox from actual edge geometry, ignoring degenerate
// zero-length edges (isolated points that appear in some Allegro exports).
// Falls back to pcbdata.edges_bbox if no real edges are found.
var _boardBBoxCache = null;
function computeBoardBBox() {
  if (_boardBBoxCache) return _boardBBoxCache;
  var EPS = 0.1; // mm
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  function ex(x, y) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  for (var e of (pcbdata.edges || [])) {
    if (e.type === "segment" || e.type === "curve") {
      var dx = e.end[0] - e.start[0], dy = e.end[1] - e.start[1];
      if (dx * dx + dy * dy < EPS * EPS) continue; // skip degenerate
      ex(e.start[0], e.start[1]); ex(e.end[0], e.end[1]);
    } else if (e.type === "arc") {
      // e.start is the arc CENTER; compute actual endpoints from angles.
      // Also check cardinal extremes (0/90/180/270°) if they fall in range.
      var cx = e.start[0], cy = e.start[1], r = e.radius;
      var sa = deg2rad(e.startangle), ea = deg2rad(e.endangle);
      ex(cx + r * Math.cos(sa), cy + r * Math.sin(sa));
      ex(cx + r * Math.cos(ea), cy + r * Math.sin(ea));
      // Check cardinal points that fall within the arc sweep
      var angles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
      var sweep = ea - sa;
      if (sweep < 0) sweep += 2 * Math.PI;
      for (var a of angles) {
        var rel = a - sa;
        if (rel < 0) rel += 2 * Math.PI;
        if (rel <= sweep) ex(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    } else if (e.type === "circle") {
      ex(e.start[0] - e.radius, e.start[1] - e.radius);
      ex(e.start[0] + e.radius, e.start[1] + e.radius);
    } else if (e.type === "rect") {
      ex(e.start[0], e.start[1]); ex(e.end[0], e.end[1]);
    }
  }
  if (minx === Infinity) {
    // no real edges found — fall back to pcbdata.edges_bbox
    _boardBBoxCache = pcbdata.edges_bbox || { minx: 0, miny: 0, maxx: 1, maxy: 1 };
  } else {
    _boardBBoxCache = { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
  }
  return _boardBBoxCache;
}

// ---- Style cache ----
var _styleCache = null;

function updateStyleCache() {
  var style = getComputedStyle(topmostdiv);
  _styleCache = {
    padHoleColor:  style.getPropertyValue('--pad-hole-color'),
    pin1Outline:   style.getPropertyValue('--pin1-outline-color'),
    pcbEdgeColor:  style.getPropertyValue('--pcb-edge-color'),
    boardBg:       style.getPropertyValue('--board-bg').trim(),
    silkEdge:      style.getPropertyValue('--silkscreen-edge-color'),
    silkPoly:      style.getPropertyValue('--silkscreen-polygon-color'),
    silkText:      style.getPropertyValue('--silkscreen-text-color'),
    fabEdge:       style.getPropertyValue('--fabrication-edge-color'),
    fabPoly:       style.getPropertyValue('--fabrication-polygon-color'),
    fabText:       style.getPropertyValue('--fabrication-text-color'),
  };
}

// ---- Path2D helpers (needed for main-thread hit-testing) ----

function getChamferedRectPath(size, radius, chamfpos, chamfratio) {
  var path = new Path2D();
  var width = size[0], height = size[1];
  var x = width * -0.5, y = height * -0.5;
  var chamfOffset = Math.min(width, height) * chamfratio;
  path.moveTo(x, 0);
  if (chamfpos & 4) { path.lineTo(x, y + height - chamfOffset); path.lineTo(x + chamfOffset, y + height); path.lineTo(0, y + height); }
  else { path.arcTo(x, y + height, x + width, y + height, radius); }
  if (chamfpos & 8) { path.lineTo(x + width - chamfOffset, y + height); path.lineTo(x + width, y + height - chamfOffset); path.lineTo(x + width, 0); }
  else { path.arcTo(x + width, y + height, x + width, y, radius); }
  if (chamfpos & 2) { path.lineTo(x + width, y + chamfOffset); path.lineTo(x + width - chamfOffset, y); path.lineTo(0, y); }
  else { path.arcTo(x + width, y, x, y, radius); }
  if (chamfpos & 1) { path.lineTo(x + chamfOffset, y); path.lineTo(x, y + chamfOffset); path.lineTo(x, 0); }
  else { path.arcTo(x, y, x, y + height, radius); }
  path.closePath();
  return path;
}

function getOblongPath(size) {
  return getChamferedRectPath(size, Math.min(size[0], size[1]) / 2, 0, 0);
}

function getPolygonsPath(shape) {
  if (shape.path2d) return shape.path2d;
  if ("svgpath" in shape) {
    shape.path2d = new Path2D(shape.svgpath);
  } else {
    var path = new Path2D();
    for (var polygon of shape.polygons) {
      path.moveTo(...polygon[0]);
      for (var i = 1; i < polygon.length; i++) path.lineTo(...polygon[i]);
      path.closePath();
    }
    shape.path2d = path;
  }
  return shape.path2d;
}

function getCirclePath(radius) {
  var path = new Path2D();
  path.arc(0, 0, radius, 0, 2 * Math.PI);
  path.closePath();
  return path;
}

function getCachedPadPath(pad) {
  if (!pad.path2d) {
    if (pad.shape == "rect") {
      pad.path2d = new Path2D();
      pad.path2d.rect(...pad.size.map(c => -c * 0.5), ...pad.size);
    } else if (pad.shape == "oval") {
      pad.path2d = getOblongPath(pad.size);
    } else if (pad.shape == "circle") {
      pad.path2d = getCirclePath(pad.size[0] / 2);
    } else if (pad.shape == "roundrect") {
      pad.path2d = getChamferedRectPath(pad.size, pad.radius, 0, 0);
    } else if (pad.shape == "chamfrect") {
      pad.path2d = getChamferedRectPath(pad.size, pad.radius, pad.chamfpos, pad.chamfratio);
    } else if (pad.shape == "custom") {
      pad.path2d = getPolygonsPath(pad);
    }
  }
  return pad.path2d;
}

// ---- Shadow filter (CSS filter on DOM, must be main-thread) ----

function applyShadowFilter(canvasdict, hasShadow) {
  var active = settings.shadowMode && hasShadow;
  var filter = active
    ? "brightness(" + settings.shadowBrightness + "%) saturate(" + settings.shadowSaturation + "%)"
    : "";
  for (var c of [canvasdict.bg, canvasdict.silk, canvasdict.fab, canvasdict.backdrop]) {
    if (c) c.style.filter = filter;
  }
  // Apply shadow to composite inner canvases
  var isBg = canvasdict === allcanvas.front ? allcanvas.innerCompBg : (canvasdict === allcanvas.back ? allcanvas.innerBackCompBg : null);
  if (isBg) isBg.style.filter = filter;
  // Highlight canvases never get shadow filter
}

// ---- CSS transform for pan/zoom ----

function updateCSSTransform(layerdict) {
  updateBackdropTransform(layerdict);
  var wrapper = layerdict._wrapper;
  if (!wrapper) return;

  var buf = layerdict._bufferState;
  if (!buf) { wrapper.style.transform = ""; return; }

  var t = layerdict.transform;
  var os = layerdict._overscan || { x: 0, y: 0 };
  var k = t.zoom / buf.zoom;

  var tx = (t.zoom * (t.panx - buf.panx) - k * os.x) / devicePixelRatio;
  var ty = (t.zoom * (t.pany - buf.pany) - k * os.y) / devicePixelRatio;

  wrapper.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + k + ")";
}

function needsBufferRefill(layerdict) {
  var buf = layerdict._bufferState;
  if (!buf) return true;

  var t = layerdict.transform;
  var zoomRatio = t.zoom / buf.zoom;
  if (zoomRatio > ZOOM_RERENDER_THRESHOLD || zoomRatio < 1 / ZOOM_RERENDER_THRESHOLD) return true;

  var os = layerdict._overscan || { x: 0, y: 0 };
  var dx = Math.abs(t.zoom * (t.panx - buf.panx)) / devicePixelRatio;
  var dy = Math.abs(t.zoom * (t.pany - buf.pany)) / devicePixelRatio;
  var budgetX = Math.max((os.x / devicePixelRatio) * REFILL_THRESHOLD, 20);
  var budgetY = Math.max((os.y / devicePixelRatio) * REFILL_THRESHOLD, 20);

  return dx > budgetX || dy > budgetY;
}

var _refillHandles = {};

function scheduleBufferRefill(layerdict) {
  var key = "refill_" + layerdict.layer;
  if (_refillHandles[key]) return;
  _refillHandles[key] = requestAnimationFrame(function() {
    delete _refillHandles[key];
    renderBuffers(layerdict);
  });
}

var _zoomSettleTimers = {};

function scheduleZoomSettle(layerdict) {
  var key = layerdict.layer;
  if (_zoomSettleTimers[key]) clearTimeout(_zoomSettleTimers[key]);
  _zoomSettleTimers[key] = setTimeout(function() {
    delete _zoomSettleTimers[key];
    // Skip if the last render posted is already at this view.
    var p = layerdict._posted, t = layerdict.transform;
    if (p && p.zoom === t.zoom && p.panx === t.panx && p.pany === t.pany) return;
    renderBuffers(layerdict);
  }, ZOOM_SETTLE_MS);
}

// ---- Buffer rendering (dispatches to worker) ----

function renderBuffers(layerdict) {
  if (!layerdict.bg) return;
  postRender(layerdict.layer);
}

function redrawInnerLayer(canvasdict) {
  // Inner layers are rendered as part of the full side render in the worker
  var parentDict = canvasdict.flip ? allcanvas.back : allcanvas.front;
  renderBuffers(parentDict);
}

function redrawCanvas(canvasdict) {
  renderBuffers(canvasdict);
}

function redrawAll() {
  renderBuffers(allcanvas.front);
  renderBuffers(allcanvas.back);
}

// ---- Resize management ----

function recalcLayerScale(layerdict, width, height) {
  var flip = (layerdict.layer === "B");
  var bbox = applyRotation(computeBoardBBox());
  var scalefactor = 0.98 * Math.min(
    width / (bbox.maxx - bbox.minx),
    height / (bbox.maxy - bbox.miny)
  );
  if (scalefactor < 0.1) scalefactor = 1;
  layerdict.transform.s = scalefactor;
  if (flip) {
    layerdict.transform.x = -((bbox.maxx + bbox.minx) * scalefactor + width) * 0.5;
  } else {
    layerdict.transform.x = -((bbox.maxx + bbox.minx) * scalefactor - width) * 0.5;
  }
  layerdict.transform.y = -((bbox.maxy + bbox.miny) * scalefactor - height) * 0.5;

  layerdict._overscan = { x: 0, y: 0 };
}

function resizeFrontBack(canvasdict, skipRedraw) {
  var divId = canvasdict.layer === "F" ? "frontcanvas" : "backcanvas";
  var div = document.getElementById(divId);
  if (!div) return;
  var width = div.clientWidth * devicePixelRatio;
  var height = div.clientHeight * devicePixelRatio;
  recalcLayerScale(canvasdict, width, height);
  if (!skipRedraw) renderBuffers(canvasdict);
}

function resizeAll(skipRedraw) {
  resizeFrontBack(allcanvas.front, skipRedraw);
  resizeFrontBack(allcanvas.back, skipRedraw);
}

// ---- Hit-testing (main thread, needs isPointInPath) ----

function pointWithinDistanceToSegment(x, y, x1, y1, x2, y2, d) {
  var A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
  var dot = A * C + B * D, len_sq = C * C + D * D;
  var dx, dy;
  if (len_sq == 0) { dx = x - x1; dy = y - y1; }
  else {
    var param = dot / len_sq;
    var xx = param < 0 ? x1 : (param > 1 ? x2 : x1 + param * C);
    var yy = param < 0 ? y1 : (param > 1 ? y2 : y1 + param * D);
    dx = x - xx; dy = y - yy;
  }
  return dx * dx + dy * dy <= d * d;
}

function modulo(n, mod) { return ((n % mod) + mod) % mod; }

function pointWithinDistanceToArc(x, y, xc, yc, radius, startangle, endangle, d) {
  var dx = x - xc, dy = y - yc;
  var r_sq = dx * dx + dy * dy;
  var rmin = Math.max(0, radius - d), rmax = radius + d;
  if (r_sq < rmin * rmin || r_sq > rmax * rmax) return false;
  var angle1 = modulo(deg2rad(startangle), 2 * Math.PI);
  var dx1 = xc + radius * Math.cos(angle1) - x, dy1 = yc + radius * Math.sin(angle1) - y;
  if (dx1 * dx1 + dy1 * dy1 <= d * d) return true;
  var angle2 = modulo(deg2rad(endangle), 2 * Math.PI);
  var dx2 = xc + radius * Math.cos(angle2) - x, dy2 = yc + radius * Math.sin(angle2) - y;
  if (dx2 * dx2 + dy2 * dy2 <= d * d) return true;
  var angle = modulo(Math.atan2(dy, dx), 2 * Math.PI);
  if (angle1 > angle2) return (angle >= angle2 || angle <= angle1);
  else return (angle >= angle1 && angle <= angle2);
}

function pointWithinPad(x, y, pad) {
  var v = [x - pad.pos[0], y - pad.pos[1]];
  v = rotateVector(v, pad.angle);
  if (pad.offset) { v[0] -= pad.offset[0]; v[1] -= pad.offset[1]; }
  var path = getCachedPadPath(pad);
  if (!path) return false;
  return emptyContext2d.isPointInPath(path, ...v);
}

// Copper layers in order from the viewed side to the far side.
function copperLayersFrom(side) {
  var layers = getCopperLayers();
  if (side === "B") layers.reverse();
  return layers;
}

// Tracks and vias on one layer, as far as the layer table shows them.
function trackHitScan(layer, x, y) {
  if (!pcbdata.tracks || !pcbdata.tracks[layer]) return null;
  var tracks = layerShows(layer, "tracks");
  var vias = layerShows(layer, "vias");
  if (!tracks && !vias) return null;
  for (var track of pcbdata.tracks[layer]) {
    if ('radius' in track) {
      if (tracks && pointWithinDistanceToArc(x, y, ...track.center, track.radius, track.startangle, track.endangle, track.width / 2))
        return track.net;
    } else {
      var isVia = track.start[0] === track.end[0] && track.start[1] === track.end[1];
      if (isVia ? !vias : !tracks) continue;
      if (pointWithinDistanceToSegment(x, y, ...track.start, ...track.end, track.width / 2))
        return track.net;
    }
  }
  return null;
}

// Tracks and pads layer by layer, nearest first.
function copperHitScan(layers, x, y) {
  for (var l of layers) {
    var net = trackHitScan(l, x, y);
    if (net !== null) return net;
    var pad = padHitScan(l, x, y);
    if (pad) return pad.net;
  }
  return null;
}

// Tracks and pads from the viewed side to the far side.
function netHitScan(side, x, y) {
  return copperHitScan(copperLayersFrom(side), x, y);
}

// What a click or hover on the canvas lands on: copper down to the inner
// layers, then the viewed side's part outlines, then the far side's copper,
// then zones. Returns { net }, { net, zone: true }, { footprint } or null.
function canvasHitScan(side, x, y) {
  var layers = copperLayersFrom(side);
  var net = copperHitScan(layers.slice(0, -1), x, y);
  if (net) return { net: net };
  var footprints = bboxHitScan(side, x, y);
  if (footprints.length > 0) return { footprint: footprints[0] };
  net = copperHitScan(layers.slice(-1), x, y);
  if (net) return { net: net };
  net = zoneHitScan(side, x, y);
  if (net) return { net: net, zone: true };
  return null;
}

function padHitScan(layer, x, y) {
  if (!layerShows(layer, "pads")) return null;
  for (var i = 0; i < pcbdata.footprints.length; i++) {
    var fp = pcbdata.footprints[i];
    for (var j = 0; j < fp.pads.length; j++) {
      var pad = fp.pads[j];
      if (pad.layers.includes(layer) && pointWithinPad(x, y, pad)) {
        var label = pad.pin1 ? "pin 1" : ("pad " + (j + 1));
        return { fpIdx: i, padLabel: label, net: pad.net };
      }
    }
  }
  return null;
}

function zoneHitScan(side, x, y) {
  if (!pcbdata.zones) return null;
  for (var layer of copperLayersFrom(side)) {
    if (!pcbdata.zones[layer] || !layerShows(layer, "zones")) continue;
    for (var zone of pcbdata.zones[layer]) {
      if (!zone.path2d) zone.path2d = getPolygonsPath(zone);
      if (emptyContext2d.isPointInPath(zone.path2d, x, y, zone.fillrule || "nonzero")) return zone.net;
    }
  }
  return null;
}

function pointWithinFootprintBbox(x, y, bbox) {
  var v = [x - bbox.pos[0], y - bbox.pos[1]];
  v = rotateVector(v, bbox.angle);
  return bbox.relpos[0] <= v[0] && v[0] <= bbox.relpos[0] + bbox.size[0] &&
         bbox.relpos[1] <= v[1] && v[1] <= bbox.relpos[1] + bbox.size[1];
}

function bboxHitScan(layer, x, y) {
  var result = [];
  if (!layerShows(layer, "all")) return result;
  for (var i = 0; i < pcbdata.footprints.length; i++) {
    var fp = pcbdata.footprints[i];
    if (fp.layer == layer && pointWithinFootprintBbox(x, y, fp.bbox))
      result.push(i);
  }
  return result;
}

// ---- Pointer / mouse handlers ----

function handlePointerDown(e, layerdict) {
  if (e.button != 0 && e.button != 1) return;
  e.preventDefault(); e.stopPropagation();
  if (!e.hasOwnProperty("offsetX")) { e.offsetX = e.pageX - e.currentTarget.offsetLeft; e.offsetY = e.pageY - e.currentTarget.offsetTop; }
  layerdict.pointerStates[e.pointerId] = {
    distanceTravelled: 0, lastX: e.offsetX, lastY: e.offsetY, downTime: Date.now(),
  };
  if (!layerdict._velocity) layerdict._velocity = { vx: 0, vy: 0, lastTime: 0 };
}

function canvasToBoard(e, layerdict) {
  var x = e.offsetX, y = e.offsetY;
  var t = layerdict.transform;
  var flip = layerdict.layer === "B";
  if (flip) x = (devicePixelRatio * x / t.zoom - t.panx + t.x) / -t.s;
  else      x = (devicePixelRatio * x / t.zoom - t.panx - t.x) / t.s;
  y = (devicePixelRatio * y / t.zoom - t.y - t.pany) / t.s;
  return rotateVector([x, y], -settings.boardRotation);
}

function handleMouseClick(e, layerdict) {
  if (!e.hasOwnProperty("offsetX")) { e.offsetX = e.pageX - e.currentTarget.offsetLeft; e.offsetY = e.pageY - e.currentTarget.offsetTop; }
  var v = canvasToBoard(e, layerdict);
  var hit = canvasHitScan(layerdict.layer, ...v);
  if (!hit) return;
  if ("footprint" in hit) onFootprintClickedFromCanvas(hit.footprint);
  else onNetClickedFromCanvas(hit.net);
}

function handlePointerUp(e, layerdict) {
  if (!e.hasOwnProperty("offsetX")) { e.offsetX = e.pageX - e.currentTarget.offsetLeft; e.offsetY = e.pageY - e.currentTarget.offsetTop; }
  e.preventDefault(); e.stopPropagation();
  if (e.button == 2) { resetTransform(layerdict); layerdict.anotherPointerTapped = false; return; }
  var ptr = layerdict.pointerStates[e.pointerId];
  if (!ptr) return;
  ptr.distanceTravelled += Math.abs(e.offsetX - ptr.lastX) + Math.abs(e.offsetY - ptr.lastY);
  if (e.button == 0 && ptr.distanceTravelled < 10 && Date.now() - ptr.downTime <= 500) {
    if (Object.keys(layerdict.pointerStates).length == 1) {
      if (layerdict.anotherPointerTapped) { resetTransform(layerdict); }
      else { handleMouseClick(e, layerdict); }
      layerdict.anotherPointerTapped = false;
    } else {
      layerdict.anotherPointerTapped = true;
    }
  } else {
    layerdict.anotherPointerTapped = false;
  }
  delete layerdict.pointerStates[e.pointerId];
  if (layerdict._velocity) { layerdict._velocity.vx = 0; layerdict._velocity.vy = 0; }
  if (Object.keys(layerdict.pointerStates).length === 0 && needsBufferRefill(layerdict)) {
    scheduleBufferRefill(layerdict);
  }
}

function handlePointerLeave(e, layerdict) {
  e.preventDefault(); e.stopPropagation();
  delete layerdict.pointerStates[e.pointerId];
  if (layerdict._velocity) { layerdict._velocity.vx = 0; layerdict._velocity.vy = 0; }
  // The tooltip only updates on move over the canvas, so hide it here (#36).
  var tooltip = document.getElementById("canvas-tooltip");
  if (tooltip) tooltip.style.display = "none";
  if (Object.keys(layerdict.pointerStates).length === 0 && needsBufferRefill(layerdict)) {
    scheduleBufferRefill(layerdict);
  }
}

function handlePointerMove(e, layerdict) {
  if (!layerdict.pointerStates.hasOwnProperty(e.pointerId)) return;
  e.preventDefault(); e.stopPropagation();
  if (!e.hasOwnProperty("offsetX")) { e.offsetX = e.pageX - e.currentTarget.offsetLeft; e.offsetY = e.pageY - e.currentTarget.offsetTop; }
  var thisPtr = layerdict.pointerStates[e.pointerId];
  var dx = e.offsetX - thisPtr.lastX, dy = e.offsetY - thisPtr.lastY;
  thisPtr.distanceTravelled += Math.abs(dx) + Math.abs(dy);

  if (Object.keys(layerdict.pointerStates).length == 1) {
    layerdict.transform.panx += devicePixelRatio * dx / layerdict.transform.zoom;
    layerdict.transform.pany += devicePixelRatio * dy / layerdict.transform.zoom;

    var now = performance.now();
    var vel = layerdict._velocity;
    if (vel) {
      var dt = vel.lastTime > 0 ? (now - vel.lastTime) / 1000 : 0.016;
      if (dt > 0 && dt < 0.5) {
        var instantVx = (devicePixelRatio * dx / layerdict.transform.zoom) / dt;
        var instantVy = (devicePixelRatio * dy / layerdict.transform.zoom) / dt;
        vel.vx = vel.vx * VELOCITY_EMA_DECAY + instantVx * (1 - VELOCITY_EMA_DECAY);
        vel.vy = vel.vy * VELOCITY_EMA_DECAY + instantVy * (1 - VELOCITY_EMA_DECAY);
      }
      vel.lastTime = now;
    }
  } else if (Object.keys(layerdict.pointerStates).length == 2) {
    var otherPtr = Object.values(layerdict.pointerStates).filter((p) => p != thisPtr)[0];
    var oldDist = Math.sqrt(Math.pow(thisPtr.lastX - otherPtr.lastX, 2) + Math.pow(thisPtr.lastY - otherPtr.lastY, 2));
    var newDist = Math.sqrt(Math.pow(e.offsetX - otherPtr.lastX, 2) + Math.pow(e.offsetY - otherPtr.lastY, 2));
    var scaleFactor = newDist / oldDist;
    if (!isNaN(scaleFactor)) {
      layerdict.transform.zoom *= scaleFactor;
      var zoomd = (1 - scaleFactor) / layerdict.transform.zoom;
      layerdict.transform.panx += devicePixelRatio * otherPtr.lastX * zoomd;
      layerdict.transform.pany += devicePixelRatio * otherPtr.lastY * zoomd;
    }
  }
  thisPtr.lastX = e.offsetX; thisPtr.lastY = e.offsetY;

  // CSS transform update (instant, GPU-composited)
  updateCSSTransform(layerdict);

  // Queue a buffer refill if the CSS transform has exhausted the overscan budget.
  // Without this, no new render is ever triggered during continuous drag.
  if (needsBufferRefill(layerdict)) {
    scheduleBufferRefill(layerdict);
  }
}

function handleMouseWheel(e, layerdict) {
  e.preventDefault(); e.stopPropagation();
  var t = layerdict.transform;
  var wheeldelta = e.deltaY;
  if (e.deltaMode == 1) wheeldelta *= 30;
  else if (e.deltaMode == 2) wheeldelta *= 300;
  var m = Math.pow(1.1, -wheeldelta / 40);
  if (m > 2) m = 2; else if (m < 0.5) m = 0.5;
  t.zoom *= m;
  var zoomd = (1 - m) / t.zoom;
  t.panx += devicePixelRatio * e.offsetX * zoomd;
  t.pany += devicePixelRatio * e.offsetY * zoomd;

  layerdict._lastWheel = performance.now();
  updateCSSTransform(layerdict);

  // Render during the zoom once it has moved far enough from the last render
  // posted, so a long zoom shows steps instead of one stretched bitmap.
  // postRender merges requests while one is in flight. The settle timer
  // renders whatever is left when the wheel stops.
  var posted = layerdict._posted;
  var r = posted ? t.zoom / posted.zoom : Infinity;
  if (r > ZOOM_WHEEL_RENDER_RATIO || r < 1 / ZOOM_WHEEL_RENDER_RATIO) {
    renderBuffers(layerdict);
  }
  scheduleZoomSettle(layerdict);
}

function handleMouseMove(e, layerdict) {
  if (!e.hasOwnProperty("offsetX")) { e.offsetX = e.pageX - e.currentTarget.offsetLeft; e.offsetY = e.pageY - e.currentTarget.offsetTop; }
  var v = canvasToBoard(e, layerdict);
  var tooltip = document.getElementById("canvas-tooltip");
  if (!tooltip) return;
  var areaRect = document.getElementById("canvas-area").getBoundingClientRect();
  var tipX = e.clientX - areaRect.left + 14;
  var tipY = e.clientY - areaRect.top + 14;

  var padHit = padHitScan(layerdict.layer, ...v);
  if (padHit) {
    var fp = pcbdata.footprints[padHit.fpIdx];
    var comp = pcbdata.components[padHit.fpIdx];
    var line1 = fp.ref + (comp && comp.val ? " \u2014 " + comp.val : "");
    var line2 = padHit.padLabel + (padHit.net ? " \u2014 " + padHit.net : "");
    tooltip.innerHTML = "<span>" + line1 + "</span><br><span style='color:var(--text-muted)'>" + line2 + "</span>";
    tooltip.style.display = "block";
    tooltip.style.left = tipX + "px";
    tooltip.style.top = tipY + "px";
    return;
  }

  var hit = canvasHitScan(layerdict.layer, ...v);
  if (!hit) { tooltip.style.display = "none"; return; }
  if ("footprint" in hit) {
    var fp = pcbdata.footprints[hit.footprint];
    var comp = pcbdata.components[hit.footprint];
    tooltip.textContent = fp.ref + (comp ? " \u2014 " + comp.val : "");
  } else {
    tooltip.textContent = (hit.zone ? "Zone: " : "Net: ") + hit.net;
  }
  tooltip.style.display = "block";
  tooltip.style.left = tipX + "px";
  tooltip.style.top = tipY + "px";
}

// ---- Zoom/transform functions ----

function resetTransform(layerdict) {
  layerdict.transform.panx = 0;
  layerdict.transform.pany = 0;
  layerdict.transform.zoom = 1;
  renderBuffers(layerdict);
}

function zoomFitBoard(layerdict) {
  resetTransform(layerdict);
}

function zoomFitPoints(layerdict, points) {
  if (!points || points.length === 0) return false;
  var canvasId = layerdict.layer === "B" ? "backcanvas" : "frontcanvas";
  var canvasDiv = document.getElementById(canvasId);
  if (!canvasDiv) return false;
  var canvasW = canvasDiv.clientWidth * devicePixelRatio;
  var canvasH = canvasDiv.clientHeight * devicePixelRatio;
  var t = layerdict.transform;

  var rotated = points.map(function(p) { return rotateVector(p, settings.boardRotation); });
  var minx = rotated.reduce(function(a, p) { return Math.min(a, p[0]); }, Infinity);
  var maxx = rotated.reduce(function(a, p) { return Math.max(a, p[0]); }, -Infinity);
  var miny = rotated.reduce(function(a, p) { return Math.min(a, p[1]); }, Infinity);
  var maxy = rotated.reduce(function(a, p) { return Math.max(a, p[1]); }, -Infinity);

  var margin = 8;
  var bboxW = (maxx - minx) + margin * 2;
  var bboxH = (maxy - miny) + margin * 2;
  if (bboxW <= 0 || bboxH <= 0) return false;

  var targetZoom = Math.min(canvasW / (bboxW * t.s), canvasH / (bboxH * t.s));
  targetZoom = Math.min(Math.max(targetZoom, 1.0), 200);
  var cx = (minx + maxx) / 2;
  var cy = (miny + maxy) / 2;

  t.zoom = targetZoom;
  var flip = layerdict.layer === "B";
  if (flip) {
    t.panx = canvasW / 2 / t.zoom + cx * t.s + t.x;
  } else {
    t.panx = canvasW / 2 / t.zoom - cx * t.s - t.x;
  }
  t.pany = canvasH / 2 / t.zoom - cy * t.s - t.y;
  renderBuffers(layerdict);
  return true;
}

function zoomToFootprint(fpIdx, layerdict) {
  var fp = pcbdata.footprints[fpIdx];
  if (!fp) return;
  var bbox = fp.bbox;
  var cx = bbox.pos[0] + bbox.relpos[0] + bbox.size[0] / 2;
  var cy = bbox.pos[1] + bbox.relpos[1] + bbox.size[1] / 2;
  var rotated = rotateVector([cx, cy], settings.boardRotation);
  cx = rotated[0]; cy = rotated[1];
  var t = layerdict.transform;
  var flip = layerdict.layer === "B";
  var canvasId = flip ? "backcanvas" : "frontcanvas";
  var canvasDiv = document.getElementById(canvasId);
  if (!canvasDiv) return;
  var canvasW = canvasDiv.clientWidth * devicePixelRatio;
  var canvasH = canvasDiv.clientHeight * devicePixelRatio;

  var margin = 8;
  var bboxW = bbox.size[0] + margin * 2;
  var bboxH = bbox.size[1] + margin * 2;
  var targetZoom = Math.min(canvasW / (bboxW * t.s), canvasH / (bboxH * t.s));
  targetZoom = Math.min(Math.max(targetZoom, 1), 50);

  t.zoom = targetZoom;
  if (flip) {
    t.panx = canvasW / 2 / t.zoom + cx * t.s + t.x;
  } else {
    t.panx = canvasW / 2 / t.zoom - cx * t.s - t.x;
  }
  t.pany = canvasH / 2 / t.zoom - cy * t.s - t.y;
  renderBuffers(layerdict);
}

// Visible area of a canvas in board units: centre, width and height. The raw
// transform depends on window size and pixel ratio, so links (#13) store this.
// Null when the canvas is hidden.
function getViewBox(layerdict) {
  var div = document.getElementById(layerdict.layer === "B" ? "backcanvas" : "frontcanvas");
  if (!div || !div.clientWidth || !div.clientHeight) return null;
  var canvasW = div.clientWidth * devicePixelRatio;
  var canvasH = div.clientHeight * devicePixelRatio;
  var t = layerdict.transform;
  var cx = layerdict.layer === "B"
    ? (canvasW / 2 / t.zoom - t.panx + t.x) / -t.s
    : (canvasW / 2 / t.zoom - t.panx - t.x) / t.s;
  var cy = (canvasH / 2 / t.zoom - t.y - t.pany) / t.s;
  var c = rotateVector([cx, cy], -settings.boardRotation);
  return { cx: c[0], cy: c[1], w: canvasW / (t.zoom * t.s), h: canvasH / (t.zoom * t.s) };
}

// Centre a canvas on box and zoom so all of it fits.
function setViewBox(layerdict, box) {
  var div = document.getElementById(layerdict.layer === "B" ? "backcanvas" : "frontcanvas");
  if (!div || !div.clientWidth || !div.clientHeight) return;
  var canvasW = div.clientWidth * devicePixelRatio;
  var canvasH = div.clientHeight * devicePixelRatio;
  var t = layerdict.transform;
  var zoom = Math.min(canvasW / (box.w * t.s), canvasH / (box.h * t.s));
  if (!isFinite(zoom) || zoom <= 0) return;
  var c = rotateVector([box.cx, box.cy], settings.boardRotation);
  t.zoom = zoom;
  if (layerdict.layer === "B") {
    t.panx = canvasW / 2 / t.zoom + c[0] * t.s + t.x;
  } else {
    t.panx = canvasW / 2 / t.zoom - c[0] * t.s - t.x;
  }
  t.pany = canvasH / 2 / t.zoom - c[1] * t.s - t.y;
  renderBuffers(layerdict);
}

// ---- Canvas event handler setup ----

function addCanvasHandlers(div, layerdict) {
  div.addEventListener("pointerdown", (e) => handlePointerDown(e, layerdict));
  div.addEventListener("pointermove", (e) => {
    handlePointerMove(e, layerdict);
    // Skip expensive hit-scanning during drag (16k+ pads/tracks per call)
    if (!layerdict.pointerStates[e.pointerId]) {
      handleMouseMove(e, layerdict);
    }
  });
  div.addEventListener("pointerup", (e) => handlePointerUp(e, layerdict));
  div.addEventListener("pointerleave", (e) => handlePointerLeave(e, layerdict));
  div.addEventListener("wheel", (e) => handleMouseWheel(e, layerdict), { passive: false });
  div.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---- Inner layer list (cached from worker init response) ----
var _innerLayerNames = [];

function getInnerLayers() {
  if (_innerLayerNames.length > 0) return _innerLayerNames;
  // Fallback: compute locally before worker is ready
  var layers = [];
  if (pcbdata.tracks) {
    for (var k of Object.keys(pcbdata.tracks)) {
      if (k !== "F" && k !== "B") layers.push(k);
    }
  }
  if (pcbdata.zones) {
    for (var k of Object.keys(pcbdata.zones)) {
      if (k !== "F" && k !== "B" && !layers.includes(k)) layers.push(k);
    }
  }
  layers.sort(compareLayers);
  return layers;
}

// ---- Initialization ----

function initRender() {
  function makeTransform() {
    return { zoom: 1, panx: 0, pany: 0, s: 1, x: 0, y: 0 };
  }
  function makeLayerDict(layerId, bgId, silkId, fabId, hlId) {
    return {
      layer: layerId,
      bg: document.getElementById(bgId),
      silk: document.getElementById(silkId),
      fab: document.getElementById(fabId),
      highlight: document.getElementById(hlId),
      get canvases() { return [this.bg, this.silk, this.fab, this.highlight]; },
      transform: makeTransform(),
      pointerStates: {},
      anotherPointerTapped: false,
      _bufferState: null,
      _overscan: { x: 0, y: 0 },
      _velocity: { vx: 0, vy: 0, lastTime: 0 },
    };
  }
  allcanvas = {
    front: makeLayerDict("F", "F_bg", "F_silk", "F_fab", "F_hl"),
    back:  makeLayerDict("B", "B_bg", "B_silk", "B_fab", "B_hl"),
    inner: {},
    innerBack: {},
    innerCompBg: null,
    innerCompHl: null,
    innerBackCompBg: null,
    innerBackCompHl: null,
  };

  // Create inner wrapper divs for CSS transform
  var frontStack = document.getElementById("frontcanvas");
  var backStack = document.getElementById("backcanvas");
  function createWrapper(stackDiv, layerdict) {
    if (!stackDiv) return null;
    var wrapper = document.createElement("div");
    wrapper.classList.add("canvas-transform-wrapper");
    var children = Array.from(stackDiv.querySelectorAll("canvas"));
    children.forEach(function(c) { wrapper.appendChild(c); });
    // Before the wrapper, so it is painted under it.
    var backdrop = document.createElement("canvas");
    backdrop.id = layerdict.layer + "_backdrop";
    backdrop.classList.add("backdrop-canvas");
    backdrop.style.display = "none";
    stackDiv.appendChild(backdrop);
    layerdict.backdrop = backdrop;
    stackDiv.appendChild(wrapper);
    layerdict._wrapper = wrapper;
    return wrapper;
  }
  var frontWrapper = createWrapper(frontStack, allcanvas.front);
  var backWrapper = createWrapper(backStack, allcanvas.back);

  // Create single composite inner layer canvases (bg + hl) per side
  function createInnerComposite(wrapper, prefix) {
    var bg = document.createElement("canvas");
    bg.id = prefix + "_comp_bg";
    bg.classList.add("inner-canvas", "inner-bg");
    var hl = document.createElement("canvas");
    hl.id = prefix + "_comp_hl";
    hl.classList.add("inner-canvas", "inner-hl");
    if (wrapper) { wrapper.appendChild(bg); wrapper.appendChild(hl); }
    return { bg: bg, hl: hl };
  }
  var frontInner = createInnerComposite(frontWrapper, "IL");
  allcanvas.innerCompBg = frontInner.bg;
  allcanvas.innerCompHl = frontInner.hl;
  var backInner = createInnerComposite(backWrapper, "ILB");
  allcanvas.innerBackCompBg = backInner.bg;
  allcanvas.innerBackCompHl = backInner.hl;

  addCanvasHandlers(frontStack, allcanvas.front);
  addCanvasHandlers(backStack, allcanvas.back);

  // Initialize worker — sends pcbdata + settings, worker responds with "ready"
  initWorker();
  updateStyleCache();
  _worker.postMessage({
    type: "init",
    pcbdata: pcbdata,
    settings: gatherSettings(),
    styleCache: _styleCache,
  });
}
