/* PCBA Viewer - Render Worker
 *
 * Copyright (c) 2026 Gherkin
 * Copyright (c) 2018 qu1ck
 * SPDX-License-Identifier: MIT
 *
 * Derived from InteractiveHtmlBom (MIT), web/render.js:
 *   https://github.com/openscopeproject/InteractiveHtmlBom
 * See LICENSE and NOTICE for the full notice.
 *
 * Runs all Canvas 2D drawing in a dedicated Web Worker thread.
 * Owns OffscreenCanvas buffers, renders board content, and transfers
 * ImageBitmaps back to the main thread for zero-cost display.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: "init", pcbdata, settings, styleCache }
 *     { type: "render", side, transform, settings, styleCache, highlights, viewportW, viewportH, dpr }
 *     { type: "backdrop", side, transform, settings, styleCache, viewportW, viewportH }
 *     { type: "updateSettings", settings, styleCache }
 *     { type: "updateHighlights", highlights }
 *
 *   Worker → Main:
 *     { type: "ready", innerLayers }
 *     { type: "rendered", side, gen, rect, bitmaps: {bg, silk, fab, highlight}, bufferState, elapsed, phases, drawCalls, itemsVisited, done }
 *     { type: "piece", side, gen, rect, bitmaps, innerComposite, elapsed, drawCalls, itemsVisited, done }
 *     { type: "backdrop", side, bitmap, elapsed, drawCalls, itemsVisited }
 *
 *   "rendered" holds the viewport, and "piece" one part of the overscan
 *   around it. Each bitmap is rect sized and goes at rect in the buffer.
 *   done is set on the last message of a render.
 */

"use strict";

// ---- State ----
var pcbdata = null;
var _settings = {};
var _styleCache = {};
var _highlights = { net: null, netPath: [], pinned: {}, hover: { nets: [], footprints: [] }, selectionColors: {} };
var _boardOutlinePath = undefined; // undefined = not computed, null = computed but no closed loops found

// ---- Draw call counter ----
//
// Counts canvas draw calls per render, reported in the "rendered" message.
// Unlike the timings this does not depend on machine speed, so the perf tests
// gate on it. Wrapping the prototype once covers every call site.
var _drawCalls = 0;
// Board items the culling looked at, drawn or not, per render. Also machine
// independent. With the spatial index it follows what is in view.
var _itemsVisited = 0;
(function() {
  var proto = self.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype;
  if (!proto) return;
  ["fill", "stroke", "fillRect", "strokeRect", "drawImage"].forEach(function(name) {
    var orig = proto[name];
    proto[name] = function() {
      _drawCalls++;
      return orig.apply(this, arguments);
    };
  });
})();

// ---- Layer color palette ----
var NET_WALK_PALETTE = ["#b58900","#2aa198","#d33682","#859900","#6c71c4","#cb4b16","#dc322f","#268bd2"];
// While something is hovered, the selection is faded to this alpha so the
// hovered items stand out on top of it.
var HOVER_DIM_ALPHA = 0.3;
var LAYER_COLORS = {
  "F":           "#268bd2",
  "B":           "#dc322f",
  "ETCH/LAY2":   "#2aa198",
  "ETCH/LAY3":   "#859900",
  "ETCH/LAY4":   "#b58900",
  "ETCH/LAY5":   "#cb4b16",
  "ETCH/LAY6":   "#d33682",
  "ETCH/LAY7":   "#6c71c4",
  "ETCH/LAY8":   "#5aaee8",
  "ETCH/LAY9":   "#4ec8be",
  "ETCH/LAY10":  "#a8c418",
  "ETCH/LAY11":  "#d4aa18",
};
var LAYER_COLORS_HIGHLIGHT = {
  "F":           "#4da8e8",
  "B":           "#e85555",
  "ETCH/LAY2":   "#36c8be",
  "ETCH/LAY3":   "#a0be00",
  "ETCH/LAY4":   "#d4a800",
  "ETCH/LAY5":   "#e06030",
  "ETCH/LAY6":   "#e04898",
  "ETCH/LAY7":   "#8088d8",
};

function getLayerColor(layer) {
  if (LAYER_COLORS[layer]) return LAYER_COLORS[layer];
  // Extract layer number from names like ETCH/L2_GND or ETCH/LAY3 and map to palette
  var m = layer.match(/(\d+)/);
  if (m) {
    var key = "ETCH/LAY" + m[1];
    if (LAYER_COLORS[key]) return LAYER_COLORS[key];
  }
  // Last resort: hash by full name (use charCode sum for better spread)
  var h = 0;
  for (var i = 0; i < layer.length; i++) h = (h * 31 + layer.charCodeAt(i)) >>> 0;
  return "#" + Math.floor(Math.abs(Math.sin(h * 7919) * 0xffffff)).toString(16).padStart(6, "0");
}
function getLayerHighlightColor(layer) {
  if (LAYER_COLORS_HIGHLIGHT[layer]) return LAYER_COLORS_HIGHLIGHT[layer];
  var m = layer.match(/(\d+)/);
  if (m) {
    var key = "ETCH/LAY" + m[1];
    if (LAYER_COLORS_HIGHLIGHT[key]) return LAYER_COLORS_HIGHLIGHT[key];
  }
  return getLayerColor(layer);
}

// ---- Tuning ----
var OVERSCAN_RATIO = 2.0;
var MAX_CANVAS_DIM = 16384;

// ---- Utility functions ----

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
  corners = corners.map(function(v) { return rotateVector(v, _settings.boardRotation); });
  return {
    minx: corners.reduce(function(a, v) { return Math.min(a, v[0]); }, Infinity),
    miny: corners.reduce(function(a, v) { return Math.min(a, v[1]); }, Infinity),
    maxx: corners.reduce(function(a, v) { return Math.max(a, v[0]); }, -Infinity),
    maxy: corners.reduce(function(a, v) { return Math.max(a, v[1]); }, -Infinity),
  };
}

// ---- Spatial index ----
//
// A uniform grid over the boxes of one list of items. gridQuery() returns the
// indices of the items whose box overlaps the clip, in list order, so the
// drawing order stays the same. It only looks at the cells under the clip, so
// the cost follows what is in view and not the size of the board.
//
// An item with no box (null) is always returned. An item that covers more than
// GRID_BIG_ITEM cells, a ground plane say, is kept in a short list that every
// query tests, instead of in all its cells.

var GRID_ITEMS_PER_CELL = 8;
var GRID_MAX_CELLS = 65536;
var GRID_BIG_ITEM = 64;

function buildGrid(boxes) {
  var n = boxes.length;
  var box = new Float64Array(4 * n);
  var loose = [];
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  var nBoxed = 0;
  for (var i = 0; i < n; i++) {
    var b = boxes[i];
    if (!b || !(b.minx <= b.maxx && b.miny <= b.maxy) ||
        !isFinite(b.minx) || !isFinite(b.miny) || !isFinite(b.maxx) || !isFinite(b.maxy)) {
      box[4 * i] = -Infinity; box[4 * i + 1] = -Infinity;
      box[4 * i + 2] = Infinity; box[4 * i + 3] = Infinity;
      continue;
    }
    box[4 * i] = b.minx; box[4 * i + 1] = b.miny;
    box[4 * i + 2] = b.maxx; box[4 * i + 3] = b.maxy;
    if (b.minx < minx) minx = b.minx;
    if (b.miny < miny) miny = b.miny;
    if (b.maxx > maxx) maxx = b.maxx;
    if (b.maxy > maxy) maxy = b.maxy;
    nBoxed++;
  }

  var g = {
    n: n, box: box, loose: loose,
    minx: minx, miny: miny, maxx: maxx, maxy: maxy,
    nx: 0, ny: 0, cellW: 1, cellH: 1,
    cellStart: null, cellItems: null,
    all: null, stamp: new Uint32Array(n), queryId: 0,
  };
  var all = new Array(n);
  for (var i = 0; i < n; i++) all[i] = i;
  g.all = all;

  if (nBoxed === 0) {
    for (var i = 0; i < n; i++) loose.push(i);
    return g;
  }

  // Cells about square, with GRID_ITEMS_PER_CELL items each on average.
  var w = Math.max(maxx - minx, 1e-6), h = Math.max(maxy - miny, 1e-6);
  var cells = Math.min(Math.max(Math.ceil(nBoxed / GRID_ITEMS_PER_CELL), 1), GRID_MAX_CELLS);
  var nx = Math.min(Math.max(Math.round(Math.sqrt(cells * w / h)), 1), cells);
  var ny = Math.max(Math.ceil(cells / nx), 1);
  g.nx = nx; g.ny = ny;
  g.cellW = w / nx; g.cellH = h / ny;

  // Two passes: count per cell, then fill. The cell lists end up in index
  // order because items are added in index order.
  var counts = new Uint32Array(nx * ny + 1);
  var range = new Int32Array(4);
  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < n; i++) {
      if (box[4 * i] === -Infinity) { if (pass === 0) loose.push(i); continue; }
      gridCellRange(g, box[4 * i], box[4 * i + 1], box[4 * i + 2], box[4 * i + 3], range);
      if ((range[2] - range[0] + 1) * (range[3] - range[1] + 1) > GRID_BIG_ITEM) {
        if (pass === 0) loose.push(i);
        continue;
      }
      for (var cy = range[1]; cy <= range[3]; cy++) {
        for (var cx = range[0]; cx <= range[2]; cx++) {
          var c = cy * nx + cx;
          if (pass === 0) counts[c + 1]++;
          else g.cellItems[g.cellStart[c] + counts[c]++] = i;
        }
      }
    }
    if (pass === 0) {
      loose.sort(function(a, b) { return a - b; });
      for (var c = 1; c <= nx * ny; c++) counts[c] += counts[c - 1];
      g.cellStart = counts;
      g.cellItems = new Int32Array(counts[nx * ny]);
      counts = new Uint32Array(nx * ny);
    }
  }
  return g;
}

// The cells a box touches, clamped to the grid: [cx0, cy0, cx1, cy1].
function gridCellRange(g, minx, miny, maxx, maxy, out) {
  out[0] = Math.min(Math.max(Math.floor((minx - g.minx) / g.cellW), 0), g.nx - 1);
  out[1] = Math.min(Math.max(Math.floor((miny - g.miny) / g.cellH), 0), g.ny - 1);
  out[2] = Math.min(Math.max(Math.floor((maxx - g.minx) / g.cellW), 0), g.nx - 1);
  out[3] = Math.min(Math.max(Math.floor((maxy - g.miny) / g.cellH), 0), g.ny - 1);
}

var _gridRange = new Int32Array(4);

// Indices of the items whose box overlaps clip, in list order. No clip: all.
function gridQuery(g, clip) {
  if (!g) return [];
  if (!clip || (clip.minx <= g.minx && clip.miny <= g.miny &&
                clip.maxx >= g.maxx && clip.maxy >= g.maxy)) {
    _itemsVisited += g.n;
    return g.all;
  }
  var box = g.box, out = [];
  for (var k = 0; k < g.loose.length; k++) {
    var i = g.loose[k];
    if (box[4 * i] <= clip.maxx && box[4 * i + 2] >= clip.minx &&
        box[4 * i + 1] <= clip.maxy && box[4 * i + 3] >= clip.miny) out.push(i);
  }
  _itemsVisited += g.loose.length;
  if (g.nx === 0 || clip.maxx < g.minx || clip.minx > g.maxx ||
      clip.maxy < g.miny || clip.miny > g.maxy) return out;

  // An item in several cells must be returned once. The stamp says whether
  // this query has seen it.
  g.queryId++;
  if (g.queryId === 0xffffffff) { g.stamp.fill(0); g.queryId = 1; }
  var id = g.queryId, stamp = g.stamp;
  var nLoose = out.length;
  gridCellRange(g, clip.minx, clip.miny, clip.maxx, clip.maxy, _gridRange);
  var cx0 = _gridRange[0], cy0 = _gridRange[1], cx1 = _gridRange[2], cy1 = _gridRange[3];
  for (var cy = cy0; cy <= cy1; cy++) {
    for (var cx = cx0; cx <= cx1; cx++) {
      var c = cy * g.nx + cx;
      for (var p = g.cellStart[c], end = g.cellStart[c + 1]; p < end; p++) {
        var i = g.cellItems[p];
        if (stamp[i] === id) continue;
        stamp[i] = id;
        _itemsVisited++;
        if (box[4 * i] <= clip.maxx && box[4 * i + 2] >= clip.minx &&
            box[4 * i + 1] <= clip.maxy && box[4 * i + 3] >= clip.miny) out.push(i);
      }
    }
  }
  // Items from more than one cell, or from the loose list, come out of order.
  if (out.length > 1 && (nLoose > 0 || cx1 > cx0 || cy1 > cy0)) {
    out.sort(function(a, b) { return a - b; });
  }
  return out;
}

// ---- Item boxes ----
//
// Each box holds everything the item draws, including half the line width.
// A box may be larger than needed, never smaller. null means unknown: the
// item is then drawn every time, as before the index.

function growBox(b, d) {
  if (!b) return null;
  return { minx: b.minx - d, miny: b.miny - d, maxx: b.maxx + d, maxy: b.maxy + d };
}

function pointsBox(points) {
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var pt of points) {
    if (!pt) return null;
    if (pt[0] < minx) minx = pt[0];
    if (pt[0] > maxx) maxx = pt[0];
    if (pt[1] < miny) miny = pt[1];
    if (pt[1] > maxy) maxy = pt[1];
  }
  return minx === Infinity ? null : { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
}

function circleBox(c, r) {
  if (!c) return null;
  return { minx: c[0] - r, miny: c[1] - r, maxx: c[0] + r, maxy: c[1] + r };
}

// Box of an SVG path with absolute M, L and A commands, which is what the
// exporters write. Anything else gives null.
function svgPathBox(svgpath) {
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  var px = null, py = null;
  // No SVG command is e or E, so those stay with the number (1e-05).
  var re = /([A-DF-Za-df-z])([^A-DF-Za-df-z]*)/g;
  var m;
  function add(x, y, d) {
    if (x - d < minx) minx = x - d; if (x + d > maxx) maxx = x + d;
    if (y - d < miny) miny = y - d; if (y + d > maxy) maxy = y + d;
  }
  while ((m = re.exec(svgpath)) !== null) {
    var cmd = m[1];
    if (cmd === "Z" || cmd === "z") continue;
    var nums = m[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    var nf = nums ? nums.map(parseFloat) : [];
    if (cmd === "M" || cmd === "L") {
      for (var i = 0; i + 1 < nf.length; i += 2) {
        px = nf[i]; py = nf[i + 1];
        add(px, py, 0);
      }
    } else if (cmd === "A") {
      // A rx ry rotation largeArc sweep x y. The arc stays within its
      // diameter of the end point, and a too small radius is scaled up to
      // half the chord, so grow by both. Flags run into the next number
      // ("0 012 3") break the groups of seven: give up.
      if (nf.length === 0 || nf.length % 7 !== 0) return null;
      for (var i = 0; i + 6 < nf.length; i += 7) {
        var x = nf[i + 5], y = nf[i + 6];
        var chord = px === null ? 0 : Math.hypot(x - px, y - py);
        add(x, y, 2 * Math.max(Math.abs(nf[i]), Math.abs(nf[i + 1])) + chord);
        px = x; py = y;
      }
    } else {
      return null;
    }
  }
  return minx === Infinity ? null : { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
}

// Box of one drawing as drawDrawing() and drawBgLayer() draw it.
function drawingBox(d) {
  if (["segment", "arc", "circle", "curve", "rect"].includes(d.type)) {
    var hw = (d.width || 0) / 2;
    if ("svgpath" in d) return growBox(svgPathBox(d.svgpath), hw);
    if (d.type == "segment" || d.type == "rect") return growBox(pointsBox([d.start, d.end]), hw);
    if (d.type == "curve") return growBox(pointsBox([d.start, d.cpa, d.cpb, d.end]), hw);
    return circleBox(d.start, d.radius + hw); // arc, circle: start is the centre
  }
  if (d.type == "polygon") {
    var hw = ("filled" in d && !d.filled) ? (d.width || 0) / 2 : 0;
    if ("svgpath" in d) return growBox(svgPathBox(d.svgpath), hw);
    if (!d.polygons || !d.pos) return null;
    var a = deg2rad(-(d.angle || 0)), cosA = Math.cos(a), sinA = Math.sin(a);
    var pts = [];
    for (var poly of d.polygons) {
      for (var p of poly) {
        pts.push([p[0] * cosA - p[1] * sinA + d.pos[0], p[0] * sinA + p[1] * cosA + d.pos[1]]);
      }
    }
    return growBox(pointsBox(pts), hw);
  }
  return textBox(d);
}

function textBox(t) {
  var hw = (t.thickness || 0) / 2;
  if ("svgpath" in t) return growBox(svgPathBox(t.svgpath), hw);
  if ("polygons" in t) {
    var pts = [];
    for (var poly of t.polygons) for (var p of poly) pts.push(p);
    return pointsBox(pts);
  }
  // Stroke font. A circle round pos that holds every line at any angle and
  // justification. Each character counts as at least a space, a tab as four.
  var font = pcbdata.font_data;
  if (!font || !font[' '] || !t.pos || typeof t.text !== "string") return null;
  var space = font[' '].w * t.width;
  var lines = t.text.split("\n");
  var w = 0;
  for (var line of lines) {
    var lw = 0;
    for (var ch of line) {
      var g = font[ch];
      lw += ch == '\t' ? 4 * space : Math.max(g ? g.w * t.width : 0, space);
    }
    if (lw > w) w = lw;
  }
  var h = lines.length * (t.height * 1.5 + t.thickness) + t.height * 1.4;
  return circleBox(t.pos, 1.5 * (w + h) + 2 * t.thickness);
}

function trackBox(t) {
  var hw = t.width / 2;
  if ('radius' in t) return circleBox(t.center, t.radius + hw);
  return growBox(pointsBox([t.start, t.end]), hw);
}

function viaBox(v) {
  return circleBox(v.start, Math.max(v.width, v._drillSize) / 2);
}

// Whether to draw one kind of thing on a copper layer: all, tracks, zones,
// vias, pads, silk or fab. The main thread works this out from the layer
// table, see layerShows() in app.js.
function show(layer, kind) {
  var s = _settings.show && _settings.show[layer];
  return !!(s && s[kind]);
}

// ---- Pre-built indices ----
// Each track batch also has .items (segments, then arcs) and .grid over them.
var _trackBatches = {};
var _vias = {};
// Spatial indices, see buildGrid(): layer -> grid over _vias[layer],
// layer -> grid over pcbdata.zones[layer], one over pcbdata.footprints, and
// "silkscreen"/"fabrication" -> layer -> grid over pcbdata.drawings.
var _viaGrids = {};
var _zoneGrids = {};
var _footprintGrid = null;
var _drawingGrids = {};
var _viaDrillSizeCache = null;

function getViaDrillSize(x, y) {
  if (!_viaDrillSizeCache) {
    _viaDrillSizeCache = {};
    if (pcbdata.tracks) {
      for (var _l in pcbdata.tracks) {
        for (var _t of pcbdata.tracks[_l]) {
          if (!_t.start || _t.start[0] !== _t.end[0] || _t.start[1] !== _t.end[1]) continue;
          if ('drillsize' in _t && _t.drillsize > 0) {
            _viaDrillSizeCache[_t.start[0] + ',' + _t.start[1]] = _t.drillsize;
          }
        }
      }
      for (var _l of ["F", "B"]) {
        if (!pcbdata.tracks[_l]) continue;
        for (var _t of pcbdata.tracks[_l]) {
          if (!_t.start || _t.start[0] !== _t.end[0] || _t.start[1] !== _t.end[1]) continue;
          var _k = _t.start[0] + ',' + _t.start[1];
          if (!(_k in _viaDrillSizeCache) && _t.width > 0) {
            _viaDrillSizeCache[_k] = _t.width * 0.55;
          }
        }
      }
      for (var _l in pcbdata.tracks) {
        if (_l === "F" || _l === "B") continue;
        for (var _t of pcbdata.tracks[_l]) {
          if (!_t.start || _t.start[0] !== _t.end[0] || _t.start[1] !== _t.end[1]) continue;
          var _k = _t.start[0] + ',' + _t.start[1];
          if (!(_k in _viaDrillSizeCache) && _t.width > 0) {
            _viaDrillSizeCache[_k] = _t.width * 0.55;
          }
        }
      }
    }
  }
  return _viaDrillSizeCache[x + ',' + y] || 0.25;
}

function buildDrawingIndices() {
  _trackBatches = {};
  _vias = {};
  _viaGrids = {};
  _zoneGrids = {};
  _drawingGrids = {};

  for (var i = 0; i < pcbdata.footprints.length; i++) {
    var fp = pcbdata.footprints[i];
    if (fp.bbox && !fp._worldBBox) fp._worldBBox = computeFootprintWorldBBox(fp);
  }
  _footprintGrid = buildGrid(pcbdata.footprints.map(function(fp) { return fp._worldBBox || null; }));

  for (var layername of ["silkscreen", "fabrication"]) {
    var byLayer = pcbdata.drawings && pcbdata.drawings[layername];
    if (!byLayer) continue;
    _drawingGrids[layername] = {};
    for (var layer in byLayer) {
      _drawingGrids[layername][layer] = buildGrid(byLayer[layer].map(drawingBox));
    }
  }

  if (pcbdata.zones) {
    for (var layer in pcbdata.zones) {
      for (var zone of pcbdata.zones[layer]) {
        if (!zone._bbox) zone._bbox = computeZoneBBox(zone);
      }
      _zoneGrids[layer] = buildGrid(pcbdata.zones[layer].map(function(z) {
        return z.width > 0 ? growBox(z._bbox, z.width / 2) : z._bbox;
      }));
    }
  }

  if (!pcbdata.tracks) return;

  getViaDrillSize(0, 0);

  for (var layer in pcbdata.tracks) {
    var trackMap = new Map();
    var viaList = [];
    for (var track of pcbdata.tracks[layer]) {
      var isVia = track.start && track.start[0] === track.end[0] && track.start[1] === track.end[1];
      if (isVia) {
        track._drillSize = getViaDrillSize(track.start[0], track.start[1]);
        viaList.push(track);
      } else {
        var w = track.width;
        if (!trackMap.has(w)) trackMap.set(w, { segments: [], arcs: [] });
        var batch = trackMap.get(w);
        if ('radius' in track) batch.arcs.push(track);
        else batch.segments.push(track);
      }
    }
    for (var batch of trackMap.values()) {
      batch.items = batch.segments.concat(batch.arcs);
      batch.grid = buildGrid(batch.items.map(trackBox));
    }
    _trackBatches[layer] = trackMap;
    _vias[layer] = viaList;
    _viaGrids[layer] = buildGrid(viaList.map(viaBox));
  }
}

function computeZoneBBox(zone) {
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  if (zone.polygons) {
    for (var poly of zone.polygons) {
      for (var pt of poly) {
        if (pt[0] < minx) minx = pt[0];
        if (pt[0] > maxx) maxx = pt[0];
        if (pt[1] < miny) miny = pt[1];
        if (pt[1] > maxy) maxy = pt[1];
      }
    }
  }
  if (minx === Infinity && zone.svgpath) {
    var sb = svgPathBox(zone.svgpath);
    if (sb) { minx = sb.minx; miny = sb.miny; maxx = sb.maxx; maxy = sb.maxy; }
  }
  if (minx === Infinity && pcbdata.edges_bbox) {
    return { minx: pcbdata.edges_bbox.minx, miny: pcbdata.edges_bbox.miny,
             maxx: pcbdata.edges_bbox.maxx, maxy: pcbdata.edges_bbox.maxy };
  }
  return { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
}

function computeFootprintWorldBBox(fp) {
  var b = fp.bbox;
  var corners = [
    [b.relpos[0], b.relpos[1]],
    [b.relpos[0] + b.size[0], b.relpos[1]],
    [b.relpos[0], b.relpos[1] + b.size[1]],
    [b.relpos[0] + b.size[0], b.relpos[1] + b.size[1]],
  ];
  var angle = -b.angle;
  var cosA = Math.cos(deg2rad(angle)), sinA = Math.sin(deg2rad(angle));
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var c of corners) {
    var rx = c[0] * cosA - c[1] * sinA + b.pos[0];
    var ry = c[0] * sinA + c[1] * cosA + b.pos[1];
    if (rx < minx) minx = rx; if (rx > maxx) maxx = rx;
    if (ry < miny) miny = ry; if (ry > maxy) maxy = ry;
  }
  return { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
}

// ---- Path2D helpers (identical to main thread versions but in Worker scope) ----

function calcFontPoint(linepoint, text, offsetx, offsety, tilt) {
  var point = [
    linepoint[0] * text.width + offsetx,
    linepoint[1] * text.height + offsety
  ];
  point[0] -= (linepoint[1] + 0.5 * (1 + text.justify[0])) * text.height * tilt;
  return point;
}

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
      path.moveTo(polygon[0][0], polygon[0][1]);
      for (var i = 1; i < polygon.length; i++) path.lineTo(polygon[i][0], polygon[i][1]);
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
      pad.path2d.rect(-pad.size[0] * 0.5, -pad.size[1] * 0.5, pad.size[0], pad.size[1]);
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

// ---- Drawing primitives ----

function drawText(ctx, text, color) {
  if ("ref" in text && !_settings.renderReferences) return;
  if ("val" in text && !_settings.renderValues) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if ("svgpath" in text) {
    if (!text._path2d) text._path2d = new Path2D(text.svgpath);
    if ("thickness" in text) {
      ctx.lineWidth = text.thickness;
      ctx.stroke(text._path2d);
    } else if ("fillrule" in text) {
      ctx.fill(text._path2d, text.fillrule);
    }
    ctx.restore();
    return;
  }
  ctx.lineWidth = text.thickness;
  if ("polygons" in text) {
    ctx.fill(getPolygonsPath(text));
    ctx.restore();
    return;
  }
  ctx.translate(text.pos[0], text.pos[1]);
  ctx.translate(text.thickness * 0.5, 0);
  var angle = -text.angle;
  if (text.attr.includes("mirrored")) {
    ctx.scale(-1, 1);
    angle = -angle;
  }
  var tilt = 0;
  if (text.attr.includes("italic")) tilt = 0.125;
  var interline = text.height * 1.5 + text.thickness;
  var txt = text.text.split("\n");
  if (txt[txt.length - 1] == '') txt.pop();
  ctx.rotate(deg2rad(angle));
  var offsety = (1 - text.justify[1]) / 2 * text.height;
  offsety -= (txt.length - 1) * (text.justify[1] + 1) / 2 * interline;
  for (var i in txt) {
    var lineWidth = text.thickness + interline / 2 * tilt;
    for (var j = 0; j < txt[i].length; j++) {
      if (txt[i][j] == '\t') {
        var fourSpaces = 4 * pcbdata.font_data[' '].w * text.width;
        lineWidth += fourSpaces - lineWidth % fourSpaces;
      } else {
        if (txt[i][j] == '~') { j++; if (j == txt[i].length) break; }
        lineWidth += pcbdata.font_data[txt[i][j]].w * text.width;
      }
    }
    var offsetx = -lineWidth * (text.justify[0] + 1) / 2;
    var inOverbar = false;
    var lastHadOverbar = false;
    for (var j = 0; j < txt[i].length; j++) {
      if (txt[i][j] == '\t') {
        var fourSpaces = 4 * pcbdata.font_data[' '].w * text.width;
        offsetx += fourSpaces - offsetx % fourSpaces;
        continue;
      } else if (txt[i][j] == '~') {
        j++;
        if (j == txt[i].length) break;
        if (txt[i][j] != '~') inOverbar = !inOverbar;
      }
      var glyph = pcbdata.font_data[txt[i][j]];
      if (!glyph) { offsetx += pcbdata.font_data[' '].w * text.width; continue; }
      if (inOverbar) {
        var overbarStart = [offsetx, -text.height * 1.4 + offsety];
        var overbarEnd = [offsetx + text.width * glyph.w, overbarStart[1]];
        if (!lastHadOverbar) { overbarStart[0] += text.height * 1.4 * tilt; lastHadOverbar = true; }
        ctx.beginPath();
        ctx.moveTo(overbarStart[0], overbarStart[1]);
        ctx.lineTo(overbarEnd[0], overbarEnd[1]);
        ctx.stroke();
      } else {
        lastHadOverbar = false;
      }
      for (var line of glyph.l) {
        ctx.beginPath();
        ctx.moveTo.apply(ctx, calcFontPoint(line[0], text, offsetx, offsety, tilt));
        for (var k = 1; k < line.length; k++) {
          ctx.lineTo.apply(ctx, calcFontPoint(line[k], text, offsetx, offsety, tilt));
        }
        ctx.stroke();
      }
      offsetx += glyph.w * text.width;
    }
    offsety += interline;
  }
  ctx.restore();
}

function drawedge(ctx, scalefactor, edge, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1 / scalefactor, edge.width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if ("svgpath" in edge) {
    if (!edge._path2d) edge._path2d = new Path2D(edge.svgpath);
    ctx.stroke(edge._path2d);
  } else {
    ctx.beginPath();
    if (edge.type == "segment") {
      ctx.moveTo(edge.start[0], edge.start[1]);
      ctx.lineTo(edge.end[0], edge.end[1]);
    } else if (edge.type == "rect") {
      ctx.moveTo(edge.start[0], edge.start[1]);
      ctx.lineTo(edge.start[0], edge.end[1]);
      ctx.lineTo(edge.end[0], edge.end[1]);
      ctx.lineTo(edge.end[0], edge.start[1]);
      ctx.lineTo(edge.start[0], edge.start[1]);
    } else if (edge.type == "arc") {
      ctx.arc(edge.start[0], edge.start[1], edge.radius, deg2rad(edge.startangle), deg2rad(edge.endangle));
    } else if (edge.type == "circle") {
      ctx.arc(edge.start[0], edge.start[1], edge.radius, 0, 2 * Math.PI);
      ctx.closePath();
    } else if (edge.type == "curve") {
      ctx.moveTo(edge.start[0], edge.start[1]);
      ctx.bezierCurveTo(edge.cpa[0], edge.cpa[1], edge.cpb[0], edge.cpb[1], edge.end[0], edge.end[1]);
    }
    if ("filled" in edge && edge.filled) ctx.fill();
    else ctx.stroke();
  }
}

function drawPolygonShape(ctx, scalefactor, shape, color) {
  ctx.save();
  if (!("svgpath" in shape)) {
    ctx.translate(shape.pos[0], shape.pos[1]);
    ctx.rotate(deg2rad(-shape.angle));
  }
  if ("filled" in shape && !shape.filled) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1 / scalefactor, shape.width);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(getPolygonsPath(shape));
  } else {
    ctx.fillStyle = color;
    ctx.fill(getPolygonsPath(shape));
  }
  ctx.restore();
}

function drawDrawing(ctx, scalefactor, drawing, color) {
  if (["segment", "arc", "circle", "curve", "rect"].includes(drawing.type)) {
    drawedge(ctx, scalefactor, drawing, color);
  } else if (drawing.type == "polygon") {
    drawPolygonShape(ctx, scalefactor, drawing, color);
  } else {
    drawText(ctx, drawing, color);
  }
}

function drawPad(ctx, pad, color, outline) {
  ctx.save();
  ctx.translate(pad.pos[0], pad.pos[1]);
  ctx.rotate(-deg2rad(pad.angle));
  if (pad.offset) ctx.translate(pad.offset[0], pad.offset[1]);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  var path = getCachedPadPath(pad);
  if (outline) ctx.stroke(path);
  else ctx.fill(path);
  ctx.restore();
}

function drawPadHole(ctx, pad, padHoleColor) {
  if (pad.type != "th") return;
  ctx.save();
  ctx.translate(pad.pos[0], pad.pos[1]);
  ctx.rotate(-deg2rad(pad.angle));
  ctx.fillStyle = padHoleColor;
  if (pad.drillshape == "oblong") ctx.fill(getOblongPath(pad.drillsize));
  else if (pad.drillshape == "rect") ctx.fill(getChamferedRectPath(pad.drillsize, 0, 0, 0));
  else ctx.fill(getCirclePath(pad.drillsize[0] / 2));
  ctx.restore();
}

// Whether a pad may show inside clip, grown by d. A footprint can cross
// several pieces of a render, and each piece then skips the pads outside it.
// Custom pads have no box that is known to hold them, so they always draw.
function padInClip(pad, clip, d) {
  if (!clip || pad.shape == "custom") return true;
  var r = Math.hypot(pad.size[0], pad.size[1]) / 2;
  if (pad.drillsize) r = Math.max(r, Math.hypot(pad.drillsize[0], pad.drillsize[1]) / 2);
  if (pad.offset) r += Math.hypot(pad.offset[0], pad.offset[1]);
  r += d;
  return pad.pos[0] + r >= clip.minx && pad.pos[0] - r <= clip.maxx &&
         pad.pos[1] + r >= clip.miny && pad.pos[1] - r <= clip.maxy;
}

function drawFootprint(ctx, layer, scalefactor, footprint, padColor, padHoleColor, outlineColor, highlight, dnpOutline, clip) {
  if (highlight) {
    if (footprint.layer == layer) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(footprint.bbox.pos[0], footprint.bbox.pos[1]);
      ctx.rotate(deg2rad(-footprint.bbox.angle));
      ctx.translate(footprint.bbox.relpos[0], footprint.bbox.relpos[1]);
      ctx.fillStyle = padColor;
      ctx.fillRect(0, 0, footprint.bbox.size[0], footprint.bbox.size[1]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = padColor;
      ctx.lineWidth = 3 / scalefactor;
      ctx.strokeRect(0, 0, footprint.bbox.size[0], footprint.bbox.size[1]);
      ctx.restore();
    }
  }
  if (!show(layer, "all")) return;
  for (var drawing of footprint.drawings) {
    if (drawing.layer == layer) {
      drawDrawing(ctx, scalefactor, drawing.drawing, padColor);
    }
  }
  ctx.lineWidth = 3 / scalefactor;
  if (show(layer, "pads")) {
    for (var pad of footprint.pads) {
      if (pad.layers.includes(layer) && padInClip(pad, clip, ctx.lineWidth)) {
        drawPad(ctx, pad, padColor, dnpOutline);
        if (pad.pin1 && _settings.highlightpin1) {
          drawPad(ctx, pad, outlineColor, true);
        }
      }
    }
    for (var pad of footprint.pads) {
      if (padInClip(pad, clip, 0)) drawPadHole(ctx, pad, padHoleColor);
    }
  }
}

function drawEdgeCuts(ctx, scalefactor) {
  var edgecolor = _styleCache.pcbEdgeColor;
  for (var edge of pcbdata.edges) {
    drawDrawing(ctx, scalefactor, edge, edgecolor);
  }
}

// Build a Path2D tracing only the closed loops formed by board edge cuts.
// Degenerate edges (zero-length segments, isolated points) are skipped.
// Returns a Path2D suitable for ctx.fill(path, "evenodd"), or null if no
// closed loops are found (fallback to edges_bbox fillRect).
function buildBoardOutlinePath() {
  if (_boardOutlinePath !== undefined) return _boardOutlinePath;
  if (!pcbdata.edges || !pcbdata.edges.length) { _boardOutlinePath = null; return null; }

  var EPS = 0.1; // mm — tolerance for endpoint matching
  var edges = pcbdata.edges;
  var n = edges.length;
  var used = new Uint8Array(n);
  var path = new Path2D();
  var foundAny = false;

  // Geometric start/end points of an edge in board coordinates.
  // arc.start is the ARC CENTER; endpoints are derived from center+radius+angle.
  // Returns {s, e} or null for degenerate/self-contained edges.
  function getEP(e) {
    if (e.type === "segment") {
      var dx = e.end[0] - e.start[0], dy = e.end[1] - e.start[1];
      if (dx * dx + dy * dy < EPS * EPS) return null;
      return { s: e.start, e: e.end };
    }
    if (e.type === "arc") {
      var sa = deg2rad(e.startangle), ea = deg2rad(e.endangle);
      var cx = e.start[0], cy = e.start[1], r = e.radius;
      return {
        s: [cx + r * Math.cos(sa), cy + r * Math.sin(sa)],
        e: [cx + r * Math.cos(ea), cy + r * Math.sin(ea)]
      };
    }
    if (e.type === "curve") return { s: e.start, e: e.end };
    return null; // circle, rect: self-contained closed shapes, skip for chaining
  }

  function ptEq(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return dx * dx + dy * dy < EPS * EPS;
  }

  function addFwd(p, e) {
    if (e.type === "segment") {
      p.lineTo(e.end[0], e.end[1]);
    } else if (e.type === "arc") {
      p.arc(e.start[0], e.start[1], e.radius, deg2rad(e.startangle), deg2rad(e.endangle));
    } else if (e.type === "curve") {
      p.bezierCurveTo(e.cpa[0], e.cpa[1], e.cpb[0], e.cpb[1], e.end[0], e.end[1]);
    }
  }

  function addBwd(p, e) {
    if (e.type === "segment") {
      p.lineTo(e.start[0], e.start[1]);
    } else if (e.type === "arc") {
      p.arc(e.start[0], e.start[1], e.radius, deg2rad(e.endangle), deg2rad(e.startangle), true);
    } else if (e.type === "curve") {
      p.bezierCurveTo(e.cpb[0], e.cpb[1], e.cpa[0], e.cpa[1], e.start[0], e.start[1]);
    }
  }

  for (var si = 0; si < n; si++) {
    if (used[si]) continue;
    var ep0 = getEP(edges[si]);
    if (!ep0) { used[si] = 1; continue; }

    var chain = [{ idx: si, fwd: true }];
    used[si] = 1;
    var chainStart = ep0.s;
    var cur = ep0.e;

    for (var iter = 0; iter < n; iter++) {
      if (ptEq(cur, chainStart)) break; // closed!
      var found = false;
      for (var i = 0; i < n; i++) {
        if (used[i]) continue;
        var ep = getEP(edges[i]);
        if (!ep) continue;
        if (ptEq(cur, ep.s)) {
          chain.push({ idx: i, fwd: true }); used[i] = 1; cur = ep.e; found = true; break;
        }
        if (ptEq(cur, ep.e)) {
          chain.push({ idx: i, fwd: false }); used[i] = 1; cur = ep.s; found = true; break;
        }
      }
      if (!found) break;
    }

    if (!ptEq(cur, chainStart)) continue; // open chain — skip

    // Emit closed loop into the Path2D
    var firstEP = getEP(edges[chain[0].idx]);
    var startPt = chain[0].fwd ? firstEP.s : firstEP.e;
    path.moveTo(startPt[0], startPt[1]);
    for (var li of chain) {
      if (li.fwd) addFwd(path, edges[li.idx]);
      else addBwd(path, edges[li.idx]);
    }
    path.closePath();
    foundAny = true;
  }

  _boardOutlinePath = foundAny ? path : null;
  return _boardOutlinePath;
}

function drawBgLayer(layername, ctx, layer, scalefactor, edgeColor, polygonColor, textColor, noText, clip) {
  if (!pcbdata.drawings[layername] || !pcbdata.drawings[layername][layer]) return;
  var drawings = pcbdata.drawings[layername][layer];
  // drawedge() draws lines at least one pixel wide, which the boxes do not
  // know about.
  if (clip) clip = growBox(clip, 1 / scalefactor);
  for (var i of gridQuery(_drawingGrids[layername][layer], clip)) {
    var d = drawings[i];
    if (["segment", "arc", "circle", "curve", "rect"].includes(d.type)) {
      drawedge(ctx, scalefactor, d, edgeColor);
    } else if (d.type == "polygon") {
      drawPolygonShape(ctx, scalefactor, d, polygonColor);
    } else if (!noText) {
      drawText(ctx, d, textColor);
    }
  }
}

// ---- Batched draw functions ----

function drawTracks(ctx, layer, color, highlight, highlightNet, clip) {
  var batches = _trackBatches[layer];
  if (!batches) return;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  for (var entry of batches) {
    var width = entry[0], batch = entry[1];
    ctx.lineWidth = width;
    ctx.beginPath();
    // A batch with nothing in view is not stroked. That matters with many
    // small pieces per render.
    var any = false;
    for (var i of gridQuery(batch.grid, clip)) {
      var t = batch.items[i];
      if (highlight && t.net !== highlightNet) continue;
      any = true;
      if ('radius' in t) {
        var sa = deg2rad(t.startangle);
        ctx.moveTo(t.center[0] + t.radius * Math.cos(sa), t.center[1] + t.radius * Math.sin(sa));
        ctx.arc(t.center[0], t.center[1], t.radius, sa, deg2rad(t.endangle));
      } else {
        ctx.moveTo(t.start[0], t.start[1]);
        ctx.lineTo(t.end[0], t.end[1]);
      }
    }
    if (any) ctx.stroke();
  }
}

function drawVias(ctx, layer, ringColor, holeColor, highlight, highlightNet, clip) {
  var viaList = _vias[layer];
  if (!viaList || viaList.length === 0) return;
  ctx.lineCap = "round";
  var ringBatches = new Map();
  var drillBatches = new Map();
  for (var i of gridQuery(_viaGrids[layer], clip)) {
    var via = viaList[i];
    if (highlight && via.net !== highlightNet) continue;
    if (via.width > 0) {
      if (!ringBatches.has(via.width)) ringBatches.set(via.width, []);
      ringBatches.get(via.width).push(via);
    }
    var ds = via._drillSize;
    if (!drillBatches.has(ds)) drillBatches.set(ds, []);
    drillBatches.get(ds).push(via);
  }
  ctx.globalAlpha = 1.0;
  for (var entry of ringBatches) {
    ctx.strokeStyle = ringColor;
    strokeDots(ctx, entry[1], entry[0]);
  }
  for (var entry of drillBatches) {
    ctx.strokeStyle = holeColor;
    strokeDots(ctx, entry[1], entry[0]);
  }
}

// A via is a zero length line with round caps. Chrome can skip the stroke
// when no line in the path has any length, which happens when a piece holds
// only a few vias, so each line gets a length far below a pixel.
var VIA_DOT_LENGTH = 1e-4;

function strokeDots(ctx, vias, width) {
  ctx.lineWidth = width;
  ctx.beginPath();
  for (var v of vias) {
    ctx.moveTo(v.start[0], v.start[1]);
    ctx.lineTo(v.end[0] + VIA_DOT_LENGTH, v.end[1]);
  }
  ctx.stroke();
}

function drawZones(ctx, layer, color, highlight, highlightNet, clip) {
  if (!pcbdata.zones || !pcbdata.zones[layer]) return;
  ctx.lineJoin = "round";
  var zones = pcbdata.zones[layer];
  for (var i of gridQuery(_zoneGrids[layer], clip)) {
    var zone = zones[i];
    if (highlight && zone.net !== highlightNet) continue;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (!zone.path2d) zone.path2d = getPolygonsPath(zone);
    ctx.fill(zone.path2d, zone.fillrule || "nonzero");
    if (zone.width > 0) { ctx.lineWidth = zone.width; ctx.stroke(zone.path2d); }
  }
}

// ---- X-ray cache ----
// The far side, seen through the board, is drawn faded under the viewed side.
// It is expensive (~150ms) but changes only when settings toggle, so cache it
// as a separate OffscreenCanvas.

var _xrayCache = {};  // side or "backdrop_" + side -> { canvas, settingsHash, done, ... }

// Everything the cached far side is drawn from, other than buffer and view.
function getXraySettingsHash(side) {
  var xLayer = side === "F" ? "B" : "F";
  return JSON.stringify([
    _settings.show && _settings.show[xLayer],
    _settings.renderReferences, _settings.renderValues, _settings.highlightpin1,
    _settings.boardRotation, _styleCache,
  ]);
}

// The cache covers the whole buffer and is filled one piece at a time, see
// renderSide(). done holds the pieces already drawn at this view.
function renderXrayCache(key, side, transform, bufW, bufH, overscanX, overscanY, rect, clip) {
  var xLayer = side === "F" ? "B" : "F";
  if (!show(xLayer, "all")) { _xrayCache[key] = null; return; }

  var hash = getXraySettingsHash(side);
  var cached = _xrayCache[key];
  var rectKey = rect.x + "," + rect.y + "," + rect.w + "," + rect.h;
  if (!(cached && cached.settingsHash === hash &&
        cached.bufW === bufW && cached.bufH === bufH &&
        cached.zoom === transform.zoom && cached.panx === transform.panx && cached.pany === transform.pany)) {
    var xCanvas = cached && cached.canvas && cached.canvas.width === bufW && cached.canvas.height === bufH
      ? cached.canvas : new OffscreenCanvas(bufW, bufH);
    cached = _xrayCache[key] = {
      canvas: xCanvas, settingsHash: hash, done: {},
      bufW: bufW, bufH: bufH,
      zoom: transform.zoom, panx: transform.panx, pany: transform.pany,
    };
  }
  if (cached.done[rectKey]) return;
  cached.done[rectKey] = true;

  var xCtx = cached.canvas.getContext("2d");
  xCtx.save();
  xCtx.setTransform(1, 0, 0, 1, 0, 0);
  xCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
  xCtx.beginPath();
  xCtx.rect(rect.x, rect.y, rect.w, rect.h);
  xCtx.clip();

  // Apply same transform as main canvases
  var flip = (side === "B");
  xCtx.translate(overscanX, overscanY);
  xCtx.scale(transform.zoom, transform.zoom);
  xCtx.translate(transform.panx, transform.pany);
  if (flip) xCtx.scale(-1, 1);
  xCtx.translate(transform.x, transform.y);
  xCtx.rotate(deg2rad(_settings.boardRotation));
  xCtx.scale(transform.s, transform.s);

  var scalefactor = transform.s * transform.zoom;
  var xColor = getLayerColor(xLayer);
  var sc = _styleCache;

  xCtx.globalAlpha = 1.0; // We apply 0.28 alpha when compositing, not here
  if (show(xLayer, "zones")) drawZones(xCtx, xLayer, xColor, false, null, clip);
  if (show(xLayer, "tracks")) drawTracks(xCtx, xLayer, xColor, false, null, clip);
  for (var i of gridQuery(_footprintGrid, clip)) {
    drawFootprint(xCtx, xLayer, scalefactor, pcbdata.footprints[i], xColor, sc.padHoleColor, sc.pin1Outline, false, false, clip);
  }
  if (show(xLayer, "vias")) drawVias(xCtx, xLayer, xColor, sc.padHoleColor, false, null, clip);
  if (show(xLayer, "fab")) {
    drawBgLayer("fabrication", xCtx, xLayer, scalefactor, sc.fabEdge, sc.fabPoly, sc.fabText, true, clip);
  }
  if (show(xLayer, "silk")) {
    drawBgLayer("silkscreen", xCtx, xLayer, scalefactor, sc.silkEdge, sc.silkPoly, sc.silkText, false, clip);
  }
  xCtx.restore();
}

// ---- Inner layer drawing ----

function drawInnerLayer(ctx, layer, highlight, clip) {
  if (!highlight) {
    var color = getLayerColor(layer);
    ctx.globalAlpha = 0.6;
    if (show(layer, "zones")) drawZones(ctx, layer, color, false, null, clip);
    if (show(layer, "tracks")) drawTracks(ctx, layer, color, false, null, clip);
    ctx.globalAlpha = 1.0;
    if (show(layer, "vias")) drawVias(ctx, layer, color, _styleCache.padHoleColor, false, null, clip);
    return;
  }

  var hlColor = getLayerHighlightColor(layer);
  ctx.globalAlpha = 1.0;

  if (_highlights.net !== null) {
    var color = _highlights.selectionColors['net:' + _highlights.net] || hlColor;
    if (show(layer, "zones")) drawZones(ctx, layer, color + "66", true, _highlights.net, clip);
    if (show(layer, "tracks")) drawTracks(ctx, layer, color, true, _highlights.net, clip);
    if (show(layer, "vias")) drawVias(ctx, layer, color, _styleCache.padHoleColor, true, _highlights.net, clip);
  }

  if (_highlights.netPath && _highlights.netPath.length > 0) {
    _highlights.netPath.forEach(function(netName, colorIdx) {
      var color = _highlights.selectionColors['net:' + netName]
                  || NET_WALK_PALETTE[colorIdx % NET_WALK_PALETTE.length];
      drawInnerNet(ctx, layer, netName, color, clip);
    });
  }
  ctx.globalAlpha = 1.0;
}

function drawInnerNet(ctx, layer, netName, color, clip) {
  if (show(layer, "zones")) drawZones(ctx, layer, color + "bb", true, netName, clip);
  if (show(layer, "tracks")) drawTracks(ctx, layer, color, true, netName, clip);
  if (show(layer, "vias")) drawVias(ctx, layer, color, _styleCache.padHoleColor, true, netName, clip);
}

// Hovered nets on one inner layer, drawn over the faded selection.
function drawInnerHover(ctx, layer, clip) {
  var hlColor = getLayerHighlightColor(layer);
  for (var netName of _highlights.hover.nets) {
    drawInnerNet(ctx, layer, netName, _highlights.selectionColors['net:' + netName] || hlColor, clip);
  }
  ctx.globalAlpha = 1.0;
}

function hasHover() {
  var h = _highlights.hover;
  return !!h && (h.nets.length > 0 || h.footprints.length > 0);
}

// Multiply the alpha of everything already on the canvas by HOVER_DIM_ALPHA.
function fadeCanvas(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = "rgba(0,0,0," + HOVER_DIM_ALPHA + ")";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

// ---- Highlight drawing ----

function drawHighlightsOnLayer(ctx, side, scalefactor, clip) {
  var layer = side;
  var sc = _styleCache;
  var xLayer = layer === "F" ? "B" : "F";
  var showCross = show(xLayer, "all");
  var xLayerColor = showCross ? getLayerColor(xLayer) : null;

  function drawXrayHighlight(fp) {
    if (fp.layer !== xLayer || !show(xLayer, "pads")) return;
    ctx.save();
    ctx.globalAlpha = 1.0;
    for (var pad of fp.pads) {
      if (pad.layers.includes(xLayer)) drawPad(ctx, pad, xLayerColor, false);
    }
    for (var pad of fp.pads) drawPadHole(ctx, pad, sc.padHoleColor);
    ctx.restore();
  }

  // Pinned components
  if (_highlights.pinned) {
    for (var pidx in _highlights.pinned) {
      var pfp = pcbdata.footprints[parseInt(pidx)];
      if (!pfp) continue;
      var pc = _highlights.pinned[pidx];
      drawFootprint(ctx, layer, scalefactor, pfp, pc, sc.padHoleColor, pc, true, false);
      drawXrayHighlight(pfp);
    }
  }

  // Highlighted net — pads
  if (_highlights.net !== null) {
    var netPadColor = _highlights.selectionColors['net:' + _highlights.net] || getLayerHighlightColor(layer);
    for (var fp of pcbdata.footprints) {
      var padDrawn = false;
      for (var pad of fp.pads) {
        if (pad.net !== _highlights.net || !show(layer, "pads")) continue;
        if (pad.layers.includes(layer)) { drawPad(ctx, pad, netPadColor, false); padDrawn = true; }
      }
      if (padDrawn) {
        for (var pad of fp.pads) drawPadHole(ctx, pad, sc.padHoleColor);
      }
      if (show(xLayer, "pads") && fp.layer === xLayer) {
        var xPadDrawn = false;
        ctx.save(); ctx.globalAlpha = 1.0;
        for (var pad of fp.pads) {
          if (pad.net !== _highlights.net) continue;
          if (pad.layers.includes(xLayer)) { drawPad(ctx, pad, xLayerColor, false); xPadDrawn = true; }
        }
        if (xPadDrawn) { for (var pad of fp.pads) drawPadHole(ctx, pad, sc.padHoleColor); }
        ctx.restore();
      }
    }
  }

  // Highlighted net — tracks & zones
  if (_highlights.net !== null) {
    var hlColor = _highlights.selectionColors['net:' + _highlights.net] || getLayerHighlightColor(layer);
    if (show(layer, "zones")) drawZones(ctx, layer, hlColor + "66", true, _highlights.net, clip);
    if (show(layer, "tracks")) drawTracks(ctx, layer, hlColor, true, _highlights.net, clip);
    if (show(layer, "vias")) drawVias(ctx, layer, hlColor, sc.padHoleColor, true, _highlights.net, clip);
    if (showCross) {
      ctx.save(); ctx.globalAlpha = 1.0;
      if (show(xLayer, "zones")) drawZones(ctx, xLayer, xLayerColor + "99", true, _highlights.net, clip);
      if (show(xLayer, "tracks")) drawTracks(ctx, xLayer, xLayerColor, true, _highlights.net, clip);
      if (show(xLayer, "vias")) drawVias(ctx, xLayer, xLayerColor, sc.padHoleColor, true, _highlights.net, clip);
      ctx.restore();
    }
  }

  // Multi-net path highlights
  if (_highlights.netPath && _highlights.netPath.length > 0) {
    _highlights.netPath.forEach(function(netName, colorIdx) {
      var color = _highlights.selectionColors['net:' + netName]
                  || NET_WALK_PALETTE[colorIdx % NET_WALK_PALETTE.length];
      drawPathNet(netName, color);
    });
  }

  // Hover: fade the selection, then draw the hovered items on top of it.
  if (!hasHover()) return;
  fadeCanvas(ctx);
  for (var idx of _highlights.hover.footprints) {
    var fp = pcbdata.footprints[idx];
    if (!fp) continue;
    var hoverColor = _highlights.selectionColors['comp:' + idx] || getLayerHighlightColor(layer);
    drawFootprint(ctx, layer, scalefactor, fp, hoverColor, sc.padHoleColor, sc.pin1Outline, true, false);
    drawXrayHighlight(fp);
  }
  for (var netName of _highlights.hover.nets) {
    drawPathNet(netName, _highlights.selectionColors['net:' + netName] || getLayerHighlightColor(layer));
  }

  // One net of the walked path, or a hovered net: zones, tracks, vias, pads.
  function drawPathNet(netName, color) {
    var alphaColor = color + "bb";
    if (show(layer, "zones")) drawZones(ctx, layer, alphaColor, true, netName, clip);
    if (show(layer, "tracks")) drawTracks(ctx, layer, alphaColor, true, netName, clip);
    if (show(layer, "vias")) drawVias(ctx, layer, color, sc.padHoleColor, true, netName, clip);
    if (showCross) {
      ctx.save(); ctx.globalAlpha = 1.0;
      if (show(xLayer, "zones")) drawZones(ctx, xLayer, xLayerColor + "99", true, netName, clip);
      if (show(xLayer, "tracks")) drawTracks(ctx, xLayer, xLayerColor, true, netName, clip);
      if (show(xLayer, "vias")) drawVias(ctx, xLayer, xLayerColor, sc.padHoleColor, true, netName, clip);
      ctx.restore();
    }
    if (show(layer, "pads")) {
      for (var fp of pcbdata.footprints) {
        for (var pad of fp.pads) {
          if (pad.net !== netName) continue;
          if (pad.layers.includes(layer)) drawPad(ctx, pad, color, false);
        }
      }
    }
    if (show(xLayer, "pads")) {
      ctx.save(); ctx.globalAlpha = 1.0;
      for (var fp of pcbdata.footprints) {
        if (fp.layer !== xLayer) continue;
        for (var pad of fp.pads) {
          if (pad.net !== netName) continue;
          if (pad.layers.includes(xLayer)) drawPad(ctx, pad, xLayerColor, false);
        }
      }
      ctx.restore();
    }
  }
}

// ---- Main render pipeline ----

// Same as compareLayers in util.js, which the worker cannot load.
function compareLayers(a, b) {
  function rank(l) { return l === "F" ? 0 : l === "B" ? 2 : 1; }
  function key(s) { return s.replace(/(\d+)/g, (m, n) => n.padStart(12, '0')); }
  return rank(a) - rank(b) || key(a).localeCompare(key(b));
}

function getInnerLayers() {
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

function computeClipBBox(transform, flip, overscanX, overscanY, bufW, bufH) {
  function pixelToBoard(px, py) {
    var ux = (px - overscanX) / transform.zoom - transform.panx;
    var uy = (py - overscanY) / transform.zoom - transform.pany;
    if (flip) ux = -ux;
    var bx = (ux - transform.x) / transform.s;
    var by = (uy - transform.y) / transform.s;
    return rotateVector([bx, by], -_settings.boardRotation);
  }
  var corners = [
    pixelToBoard(0, 0), pixelToBoard(bufW, 0),
    pixelToBoard(0, bufH), pixelToBoard(bufW, bufH)
  ];
  return {
    minx: Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0]),
    miny: Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1]),
    maxx: Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0]),
    maxy: Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]),
  };
}

function prepareCtx(ctx, flip, transform, overscanX, overscanY) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(overscanX, overscanY);
  ctx.scale(transform.zoom, transform.zoom);
  ctx.translate(transform.panx, transform.pany);
  if (flip) ctx.scale(-1, 1);
  ctx.translate(transform.x, transform.y);
  ctx.rotate(deg2rad(_settings.boardRotation));
  ctx.scale(transform.s, transform.s);
}

// Buffer canvases owned by the worker
var _buffers = {};  // side -> { bg, silk, fab, highlight, inner: {layerName: {bg, hl}} }

function getOrCreateBuffer(side, name, w, h) {
  if (!_buffers[side]) _buffers[side] = {};
  var buf = _buffers[side];
  if (!buf[name] || buf[name].width !== w || buf[name].height !== h) {
    buf[name] = new OffscreenCanvas(w, h);
  }
  return buf[name];
}

// ---- Pieces ----
//
// A render draws the viewport first and posts it on its own, so it is on
// screen without waiting for the overscan. The overscan follows in pieces,
// one per task, nearest the viewport first. Messages are handled between the
// pieces: a new render for the same side drops the pieces still waiting, and
// a backdrop is drawn before them.

var _renderGen = {};    // side -> number of the last render request
var _pieceQueue = [];   // { side, gen, msg, rect, ... } waiting to be drawn
var _pieceTimer = null;

// The viewport and the overscan pieces of a bufW x bufH buffer, in drawing
// order. Rects are in whole buffer pixels. The overscan is cut into the four
// corners and the four sides, and each side again in two along its length,
// so no piece is much more than a quarter of the viewport.
function bufferPieces(bufW, bufH, overscanX, overscanY, pxW, pxH) {
  function clampX(v) { return Math.min(Math.max(v, 0), bufW); }
  function clampY(v) { return Math.min(Math.max(v, 0), bufH); }
  var x0 = clampX(Math.floor(overscanX)), x1 = clampX(Math.ceil(overscanX + pxW));
  var y0 = clampY(Math.floor(overscanY)), y1 = clampY(Math.ceil(overscanY + pxH));
  var xm = Math.round((x0 + x1) / 2), ym = Math.round((y0 + y1) / 2);
  var xs = [0, x0, x1, bufW], ys = [0, y0, y1, bufH];

  var out = [];
  function add(xa, xb, ya, yb) {
    if (xb > xa && yb > ya) out.push({ x: xa, y: ya, w: xb - xa, h: yb - ya });
  }
  for (var j = 0; j < 3; j++) {
    for (var i = 0; i < 3; i++) {
      if (i === 1 && j === 1) continue;  // the viewport
      if (i === 1) { add(x0, xm, ys[j], ys[j + 1]); add(xm, x1, ys[j], ys[j + 1]); }
      else if (j === 1) { add(xs[i], xs[i + 1], y0, ym); add(xs[i], xs[i + 1], ym, y1); }
      else add(xs[i], xs[i + 1], ys[j], ys[j + 1]);
    }
  }
  // Nearest the viewport centre first, in units of the buffer size.
  var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  function dist(r) {
    var dx = (r.x + r.w / 2 - cx) / bufW, dy = (r.y + r.h / 2 - cy) / bufH;
    return dx * dx + dy * dy;
  }
  out.sort(function(a, b) { return dist(a) - dist(b); });

  var viewport = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  return { viewport: viewport.w > 0 && viewport.h > 0 ? viewport : null, overscan: out };
}

function renderSide(msg) {
  var side = msg.side;
  var transform = msg.transform;
  var vpW = msg.viewportW;  // already in device pixels (CSS px * dpr)
  var vpH = msg.viewportH;

  var gen = _renderGen[side] = (_renderGen[side] || 0) + 1;
  _pieceQueue = _pieceQueue.filter(function(p) { return p.side !== side; });

  var pxW = vpW;
  var pxH = vpH;
  var bufW = Math.min(Math.round(pxW * OVERSCAN_RATIO), MAX_CANVAS_DIM);
  var bufH = Math.min(Math.round(pxH * OVERSCAN_RATIO), MAX_CANVAS_DIM);

  // Guard: skip render if the viewport has no area (e.g. hidden tab)
  if (bufW <= 0 || bufH <= 0) {
    self.postMessage({ type: "rendered", side: side, gen: gen, bitmaps: null, innerBitmaps: null,
      bufferState: { zoom: transform.zoom, panx: transform.panx, pany: transform.pany },
      overscan: { x: 0, y: 0 }, bufW: 0, bufH: 0, elapsed: 0, hasShadow: false, done: true });
    return;
  }
  var overscanX = (bufW - pxW) / 2;
  var overscanY = (bufH - pxH) / 2;

  var pieces = bufferPieces(bufW, bufH, overscanX, overscanY, pxW, pxH);
  var first = pieces.viewport || { x: 0, y: 0, w: bufW, h: bufH };
  var rest = pieces.viewport ? pieces.overscan : [];

  var _t0 = performance.now();
  _drawCalls = 0;
  _itemsVisited = 0;
  var d = drawSide(side, side, transform, bufW, bufH, overscanX, overscanY, true, first);
  var _elapsed = performance.now() - _t0;

  var out = pieceBitmaps(d);
  self.postMessage({
    type: "rendered",
    side: side,
    gen: gen,
    rect: first,
    bitmaps: out.bitmaps,
    innerComposite: out.innerComposite,
    bufferState: { zoom: transform.zoom, panx: transform.panx, pany: transform.pany },
    overscan: { x: overscanX, y: overscanY },
    bufW: bufW,
    bufH: bufH,
    elapsed: _elapsed,
    phases: d.phases,
    drawCalls: _drawCalls,
    itemsVisited: _itemsVisited,
    hasShadow: d.hasHighlights,
    done: rest.length === 0,
  }, out.transfer);

  for (var i = 0; i < rest.length; i++) {
    _pieceQueue.push({
      side: side, gen: gen, msg: msg, rect: rest[i], last: i === rest.length - 1,
      bufW: bufW, bufH: bufH, overscanX: overscanX, overscanY: overscanY,
    });
  }
  schedulePiece();
}

function schedulePiece() {
  if (_pieceTimer !== null || _pieceQueue.length === 0) return;
  _pieceTimer = setTimeout(function() {
    _pieceTimer = null;
    var p = _pieceQueue.shift();
    if (p && p.gen === _renderGen[p.side]) renderPiece(p);
    schedulePiece();
  }, 0);
}

function renderPiece(p) {
  // Draw with the state of the render this piece belongs to. A backdrop in
  // between may have replaced it.
  _settings = p.msg.settings;
  _styleCache = p.msg.styleCache;
  _highlights = p.msg.highlights || _highlights;

  var t0 = performance.now();
  _drawCalls = 0;
  _itemsVisited = 0;
  var d = drawSide(p.side, p.side, p.msg.transform, p.bufW, p.bufH, p.overscanX, p.overscanY, true, p.rect);
  var out = pieceBitmaps(d);
  self.postMessage({
    type: "piece",
    side: p.side,
    gen: p.gen,
    rect: p.rect,
    bitmaps: out.bitmaps,
    innerComposite: out.innerComposite,
    elapsed: performance.now() - t0,
    drawCalls: _drawCalls,
    itemsVisited: _itemsVisited,
    done: p.last,
  }, out.transfer);
}

// The bitmaps of the canvases drawSide() filled, and the list to transfer.
function pieceBitmaps(d) {
  var bitmaps = {
    bg: d.bg.transferToImageBitmap(),
    silk: d.silk ? d.silk.transferToImageBitmap() : null,
    fab: d.fab ? d.fab.transferToImageBitmap() : null,
    highlight: d.hl ? d.hl.transferToImageBitmap() : null,
  };
  // Inner: single composite bitmaps (or null)
  var innerBg = d.innerBg ? d.innerBg.transferToImageBitmap() : null;
  var innerHl = d.innerHl ? d.innerHl.transferToImageBitmap() : null;
  var transfer = [bitmaps.bg, bitmaps.silk, bitmaps.fab, bitmaps.highlight, innerBg, innerHl]
    .filter(function(b) { return b; });
  return {
    bitmaps: bitmaps,
    innerComposite: d.innerVisible ? { bg: innerBg, hl: innerHl } : null,
    transfer: transfer,
  };
}

// The whole board at the fit zoom, drawn once and kept under the normal
// layers. Zooming out faster than the renders arrive shrinks the buffer
// below the screen size, and this shows around it instead of the background.
// Highlights are left out, so it only changes with layers, rotation, colours
// and canvas size.
function renderBackdrop(msg) {
  var side = msg.side;
  var w = msg.viewportW, h = msg.viewportH;
  if (w <= 0 || h <= 0) return;
  var key = "backdrop_" + side;

  var t0 = performance.now();
  _drawCalls = 0;
  _itemsVisited = 0;
  var d = drawSide(key, side, msg.transform, w, h, 0, 0, false, { x: 0, y: 0, w: w, h: h });

  // One canvas, stacked in the same order as the canvases on the page.
  var out = getOrCreateBuffer(key, "out", w, h);
  var ctx = out.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  for (var c of [d.bg, d.innerBg, d.fab, d.silk]) {
    if (c) ctx.drawImage(c, 0, 0);
  }
  var bitmap = out.transferToImageBitmap();

  self.postMessage({
    type: "backdrop",
    side: side,
    bitmap: bitmap,
    elapsed: performance.now() - t0,
    drawCalls: _drawCalls,
    itemsVisited: _itemsVisited,
  }, [bitmap]);
}

// Draws the part rect of one side's bufW x bufH buffer into the canvases
// stored under key. The canvases are rect sized. Returns the ones that have
// content, null for the rest.
function drawSide(key, side, transform, fullW, fullH, fullOverscanX, fullOverscanY, withHighlights, rect) {
  var bufW = rect.w, bufH = rect.h;
  var overscanX = fullOverscanX - rect.x, overscanY = fullOverscanY - rect.y;
  var flip = (side === "B");
  var clip = computeClipBBox(transform, flip, overscanX, overscanY, bufW, bufH);
  var scalefactor = transform.s * transform.zoom;
  var sc = _styleCache;

  var _phases = {};
  var _tp;

  // ---- Background canvas ----
  var bgCanvas = getOrCreateBuffer(key, "bg", bufW, bufH);
  var bgCtx = bgCanvas.getContext("2d");
  bgCtx.clearRect(0, 0, bufW, bufH);
  prepareCtx(bgCtx, flip, transform, overscanX, overscanY);

  if (sc.boardBg) {
    bgCtx.fillStyle = sc.boardBg;
    var boardPath = buildBoardOutlinePath();
    if (boardPath) {
      bgCtx.fill(boardPath, "evenodd");
    } else if (pcbdata.edges_bbox) {
      var bb = pcbdata.edges_bbox;
      bgCtx.fillRect(bb.minx, bb.miny, bb.maxx - bb.minx, bb.maxy - bb.miny);
    }
  }

  // X-ray: the far side through the board (cached), under the viewed side.
  _tp = performance.now();
  renderXrayCache(key, side, transform, fullW, fullH, fullOverscanX, fullOverscanY, rect, clip);
  var xc = _xrayCache[key];
  if (xc && xc.canvas && xc.canvas.width > 0 && xc.canvas.height > 0) {
    bgCtx.save();
    bgCtx.setTransform(1, 0, 0, 1, 0, 0);
    bgCtx.globalAlpha = 0.28;
    bgCtx.drawImage(xc.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    bgCtx.restore();
  }
  _phases.xray = performance.now() - _tp;

  var layerColor = getLayerColor(side);
  _tp = performance.now();
  if (show(side, "zones")) {
    bgCtx.globalAlpha = 0.6;
    drawZones(bgCtx, side, layerColor, false, null, clip);
    bgCtx.globalAlpha = 1.0;
  }
  _phases.zones = performance.now() - _tp;

  _tp = performance.now();
  if (show(side, "tracks")) {
    bgCtx.globalAlpha = 0.6;
    drawTracks(bgCtx, side, layerColor, false, null, clip);
    bgCtx.globalAlpha = 1.0;
  }
  _phases.tracks = performance.now() - _tp;

  _tp = performance.now();
  var visibleFps = show(side, "pads") || show(side, "all") ? gridQuery(_footprintGrid, clip) : [];
  if (show(side, "pads")) {
    bgCtx.globalAlpha = 0.75;
    for (var i of visibleFps) {
      drawFootprint(bgCtx, side, scalefactor, pcbdata.footprints[i], layerColor, sc.padHoleColor, sc.pin1Outline, false, false, clip);
    }
    bgCtx.globalAlpha = 1.0;
    for (var i of visibleFps) {
      for (var pad of pcbdata.footprints[i].pads) {
        if (padInClip(pad, clip, 0)) drawPadHole(bgCtx, pad, sc.padHoleColor);
      }
    }
  } else if (show(side, "all")) {
    for (var i of visibleFps) {
      drawFootprint(bgCtx, side, scalefactor, pcbdata.footprints[i], layerColor, sc.padHoleColor, sc.pin1Outline, false, false, clip);
    }
  }
  _phases.footprints = performance.now() - _tp;

  _tp = performance.now();
  if (show(side, "vias")) {
    drawVias(bgCtx, side, layerColor, sc.padHoleColor, false, null, clip);
  }
  _phases.vias = performance.now() - _tp;

  drawEdgeCuts(bgCtx, scalefactor);

  // ---- Silkscreen canvas ----
  _tp = performance.now();
  var silkCanvas = null;
  if (show(side, "silk")) {
    silkCanvas = getOrCreateBuffer(key, "silk", bufW, bufH);
    var silkCtx = silkCanvas.getContext("2d");
    silkCtx.clearRect(0, 0, bufW, bufH);
    prepareCtx(silkCtx, flip, transform, overscanX, overscanY);
    drawBgLayer("silkscreen", silkCtx, side, scalefactor, sc.silkEdge, sc.silkPoly, sc.silkText, false, clip);
  }
  _phases.silk = performance.now() - _tp;

  // ---- Fabrication canvas ----
  _tp = performance.now();
  var fabCanvas = null;
  if (show(side, "fab")) {
    fabCanvas = getOrCreateBuffer(key, "fab", bufW, bufH);
    var fabCtx = fabCanvas.getContext("2d");
    fabCtx.clearRect(0, 0, bufW, bufH);
    prepareCtx(fabCtx, flip, transform, overscanX, overscanY);
    drawBgLayer("fabrication", fabCtx, side, scalefactor, sc.fabEdge, sc.fabPoly, sc.fabText, true, clip);
  }
  _phases.fab = performance.now() - _tp;

  // ---- Highlight canvas ----
  _tp = performance.now();
  var hlCanvas = null;
  var hasHighlights = withHighlights && (_highlights.net !== null ||
    hasHover() ||
    (_highlights.netPath && _highlights.netPath.length > 0) ||
    (_highlights.pinned && Object.keys(_highlights.pinned).length > 0));
  if (hasHighlights) {
    hlCanvas = getOrCreateBuffer(key, "highlight", bufW, bufH);
    var hlCtx = hlCanvas.getContext("2d");
    hlCtx.clearRect(0, 0, bufW, bufH);
    prepareCtx(hlCtx, flip, transform, overscanX, overscanY);
    drawHighlightsOnLayer(hlCtx, side, scalefactor, clip);
  }
  _phases.highlights = performance.now() - _tp;

  // ---- Inner layers (composited into single bg + hl canvases) ----
  _tp = performance.now();
  var innerBg = null;
  var innerHl = null;
  var innerLayers = getInnerLayers();
  var innerCount = 0;
  var anyInnerVisible = false;
  for (var ln of innerLayers) {
    if (!show(ln, "all")) continue;
    anyInnerVisible = true;
    innerCount++;

    // Lazily create inner canvases on first visible layer
    if (!innerBg) {
      innerBg = getOrCreateBuffer(key, "inner_bg", bufW, bufH);
      var ibgCtx = innerBg.getContext("2d");
      ibgCtx.clearRect(0, 0, bufW, bufH);
      prepareCtx(ibgCtx, flip, transform, overscanX, overscanY);
    }
    drawInnerLayer(innerBg.getContext("2d"), ln, false, clip);

    if (hasHighlights) {
      if (!innerHl) {
        innerHl = getOrCreateBuffer(key, "inner_hl", bufW, bufH);
        var ihlCtx = innerHl.getContext("2d");
        ihlCtx.clearRect(0, 0, bufW, bufH);
        prepareCtx(ihlCtx, flip, transform, overscanX, overscanY);
      }
      drawInnerLayer(innerHl.getContext("2d"), ln, true, clip);
    }
  }
  // All inner layers share one highlight canvas, so the hover goes on top
  // once every layer's selection is drawn.
  if (innerHl && hasHover()) {
    var ihCtx = innerHl.getContext("2d");
    fadeCanvas(ihCtx);
    for (var ln of innerLayers) {
      if (!show(ln, "all")) continue;
      drawInnerHover(ihCtx, ln, clip);
    }
  }
  _phases.inner = performance.now() - _tp;
  _phases.innerCount = innerCount;

  return {
    bg: bgCanvas, silk: silkCanvas, fab: fabCanvas, hl: hlCanvas,
    innerBg: innerBg, innerHl: innerHl, innerVisible: anyInnerVisible,
    hasHighlights: hasHighlights, phases: _phases,
  };
}

// ---- Message handler ----

self.onmessage = function(e) {
  var msg = e.data;

  if (msg.type === "init") {
    pcbdata = msg.pcbdata;
    _settings = msg.settings || {};
    _styleCache = msg.styleCache || {};
    _highlights = msg.highlights || _highlights;
    _boardOutlinePath = undefined; // reset cache for new board
    buildDrawingIndices();
    self.postMessage({ type: "ready", innerLayers: getInnerLayers() });
  }
  else if (msg.type === "render") {
    _settings = msg.settings;
    _styleCache = msg.styleCache;
    _highlights = msg.highlights || _highlights;
    renderSide(msg);
  }
  else if (msg.type === "backdrop") {
    _settings = msg.settings;
    _styleCache = msg.styleCache;
    renderBackdrop(msg);
  }
  else if (msg.type === "updateSettings") {
    _settings = msg.settings;
    _styleCache = msg.styleCache;
    // Invalidate x-ray caches
    _xrayCache = {};
  }
  else if (msg.type === "updateHighlights") {
    _highlights = msg.highlights;
  }
};
