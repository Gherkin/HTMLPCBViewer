/* PCBA Bringup Viewer - Application Logic
 *
 * Copyright (c) 2026 Gherkin
 * Copyright (c) 2018 qu1ck
 * SPDX-License-Identifier: MIT
 *
 * Derived in part from InteractiveHtmlBom (MIT), web/ibom.js and web/table-util.js:
 *   https://github.com/openscopeproject/InteractiveHtmlBom
 * See LICENSE and NOTICE for the full notice.
 */

// ---- Global state ----
var allcanvas;
var settings;
var initDone = false;

// Data indexes built at load time
var netToComponents = {};      // net name → [{fpIdx, padIdx}]
var netToLayers = {};          // net name → Set of layer names
var componentToNets = {};      // fpIdx → Set of net names
var componentByRef = {};       // UPPER ref → fpIdx

// Selection state
var selectedFootprintIdx = null;
var selectedNet = null;
var highlightedFootprints = [];
var highlightedNet = null;

// Net walking state
var highlightedNetPath = [];      // array of net names currently highlighted as path
var netWalkHistory = [];          // [{type:'net'|'comp', value: name|idx}, ...]
var netWalkBreadcrumbs = [];      // [{label, action}, ...]

// Load-phase timings, filled during init. Read via window.__pcbaTest.timings().
var _loadTimings = {};
var _hashApplied = false;   // the link in the URL hash has been applied (#13)

// ---- Build indexes ----

function buildIndexes() {
  var _t0 = performance.now();
  for (var i = 0; i < pcbdata.footprints.length; i++) {
    var fp = pcbdata.footprints[i];
    componentByRef[fp.ref.toUpperCase()] = i;
    componentToNets[i] = new Set();
    // Track which nets we've already added an entry for (dedup without .some)
    var seenNets = new Set();
    for (var j = 0; j < fp.pads.length; j++) {
      var net = fp.pads[j].net;
      if (!net) continue;
      componentToNets[i].add(net);
      if (!netToComponents[net]) netToComponents[net] = [];
      if (!seenNets.has(net)) {
        seenNets.add(net);
        netToComponents[net].push({ fpIdx: i, padIdx: j });
      }
    }
  }
  // Build netToLayers from tracks (skip vias) and zones
  var _tl0 = performance.now();
  if (pcbdata.tracks) {
    for (var layer in pcbdata.tracks) {
      var items = pcbdata.tracks[layer];
      for (var k = 0; k < items.length; k++) {
        var item = items[k];
        // Skip vias: zero-length segments (start === end); arcs have no start/end so skip those check
        if (item.start && item.start[0] === item.end[0] && item.start[1] === item.end[1]) continue;
        var net = item.net;
        if (!net) continue;
        if (!netToLayers[net]) netToLayers[net] = new Set();
        netToLayers[net].add(layer);
      }
    }
  }
  if (pcbdata.zones) {
    for (var layer in pcbdata.zones) {
      var items = pcbdata.zones[layer];
      for (var k = 0; k < items.length; k++) {
        var net = items[k].net;
        if (!net) continue;
        if (!netToLayers[net]) netToLayers[net] = new Set();
        netToLayers[net].add(layer);
      }
    }
  }
  var _t1 = performance.now();
  // Pre-compute pad path cache (avoids first-draw stutter)
  if (pcbdata.footprints.length > 0) {
    var _allPads = 0;
    pcbdata.footprints.forEach(function(fp) { _allPads += fp.pads ? fp.pads.length : 0; });
    var _t2 = performance.now();
    console.log("[PCBAViewer] buildIndexes: loop " + (_t1-_t0).toFixed(0) + "ms | total fps=" + pcbdata.footprints.length + " pads=" + _allPads + " | pad count " + (_t2-_t1).toFixed(0) + "ms");
  }
}

// ---- Settings ----

function defaultSettings() {
  return {
    darkMode: true,
    canvaslayout: "F",         // "F" | "B" | "FB"
    canvasDirection: "row",    // "row" | "column"
    boardRotation: 0,
    renderPads: true,
    renderSilkscreen: false,
    renderFabrication: true,
    showBackOnFront: false,
    showFrontOnBack: false,
    defaultInnerLayersVisible: false,
    renderTracks: true,
    renderZones: true,
    renderReferences: true,
    renderValues: false,
    highlightpin1: false,
    redrawOnDrag: true,
    innerLayerVisibility: {},  // layerName → bool
    shadowMode: true,
    shadowBrightness: 50,      // 0–100 % brightness of dimmed elements
    shadowSaturation: 75,      // 0–100 % saturation of dimmed elements
  };
}

function loadSettings() {
  settings = defaultSettings();
  var stored = readStorage("settings");
  if (stored) {
    try { Object.assign(settings, JSON.parse(stored)); } catch(e) {}
  }
}

// Settings a link applies last for this visit only (#13). While the link is
// applied nothing is saved. After that, each setting the link changed is saved
// with its old value, until the user changes it.
var _applyingLink = false;
var _linkOverrides = null;   // { top: {key: {stored, applied}}, inner: {layer: {stored, applied}} }

function saveSettings() {
  if (_applyingLink) return;
  var out = settings;
  if (_linkOverrides) {
    out = JSON.parse(JSON.stringify(settings));
    keepStoredSettings(_linkOverrides.top, settings, out);
    keepStoredSettings(_linkOverrides.inner, settings.innerLayerVisibility, out.innerLayerVisibility);
  }
  writeStorage("settings", JSON.stringify(out));
}

function keepStoredSettings(overrides, current, out) {
  for (var k in overrides) {
    if (JSON.stringify(current[k]) !== JSON.stringify(overrides[k].applied)) delete overrides[k];
    else out[k] = overrides[k].stored;
  }
}

function recordLinkOverrides(before) {
  _linkOverrides = { top: {}, inner: {} };
  Object.keys(settings).forEach(function(k) {
    if (k === "innerLayerVisibility") return;
    if (JSON.stringify(settings[k]) !== JSON.stringify(before[k])) {
      _linkOverrides.top[k] = { stored: before[k], applied: settings[k] };
    }
  });
  Object.keys(settings.innerLayerVisibility).forEach(function(l) {
    if (settings.innerLayerVisibility[l] !== before.innerLayerVisibility[l]) {
      _linkOverrides.inner[l] = { stored: before.innerLayerVisibility[l], applied: settings.innerLayerVisibility[l] };
    }
  });
}

// ---- Dark mode ----

function setDarkMode(on) {
  settings.darkMode = on;
  document.getElementById("topmostdiv").classList.toggle("dark", on);
  document.getElementById("darkmodeCheckbox").checked = on;
  saveSettings();
  redrawAllIfDone();
}

function toggleDarkMode() {
  setDarkMode(!settings.darkMode);
}

// ---- Canvas layout (F / B / FB) ----

function setCanvasLayout(layout) {
  settings.canvaslayout = layout;
  document.getElementById("frontcanvas-wrap").style.display = (layout === "B") ? "none" : "flex";
  document.getElementById("backcanvas-wrap").style.display  = (layout === "F") ? "none" : "flex";
  ["btn-layout-f","btn-layout-b","btn-layout-fb"].forEach(id => document.getElementById(id).classList.remove("active"));
  document.getElementById("btn-layout-" + layout.toLowerCase()).classList.add("active");
  saveSettings();
  if (initDone) resizeAll();
}

function setCanvasDirection(dir) {
  settings.canvasDirection = dir;
  var area = document.getElementById("canvas-area");
  area.style.flexDirection = dir;
  area.classList.toggle("column", dir === "column");
  var fwrap = document.getElementById("frontcanvas-wrap");
  fwrap.style.borderRight = dir === "row" ? "" : "none";
  fwrap.style.borderBottom = dir === "column" ? "2px solid var(--border)" : "";
  ["btn-dir-h","btn-dir-v"].forEach(id => document.getElementById(id).classList.remove("active"));
  document.getElementById(dir === "row" ? "btn-dir-h" : "btn-dir-v").classList.add("active");
  saveSettings();
  if (initDone) resizeAll();
}

// ---- Render toggles ----

function makeToggle(storageKey, settingKey) {
  return function(val) {
    settings[settingKey] = val;
    saveSettings();
    redrawAllIfDone();
  };
}

var padsVisible       = makeToggle("padsVisible",       "renderPads");
var silkscreenVisible = makeToggle("silkscreenVisible", "renderSilkscreen");
var fabricationVisible= makeToggle("fabricationVisible","renderFabrication");
var tracksVisible     = makeToggle("tracksVisible",     "renderTracks");
var zonesVisible      = makeToggle("zonesVisible",      "renderZones");
var referencesVisible = makeToggle("referencesVisible", "renderReferences");
var valuesVisible     = makeToggle("valuesVisible",     "renderValues");

function setShowBackOnFront(val) {
  settings.showBackOnFront = val;
  saveSettings();
  redrawAllIfDone();
}

function setShowFrontOnBack(val) {
  settings.showFrontOnBack = val;
  saveSettings();
  redrawAllIfDone();
}

function setShadowMode(on) {
  settings.shadowMode = on;
  var sliders = document.getElementById("shadow-sliders");
  if (sliders) sliders.style.display = on ? "block" : "none";
  saveSettings();
  redrawAllIfDone();
}

function setShadowBrightness(val) {
  settings.shadowBrightness = parseInt(val);
  document.getElementById("shadow-brightness-val").textContent = val + "%";
  saveSettings();
  redrawAllIfDone();
}

function setShadowSaturation(val) {
  settings.shadowSaturation = parseInt(val);
  document.getElementById("shadow-saturation-val").textContent = val + "%";
  saveSettings();
  redrawAllIfDone();
}

function setInnerLayerVisible(layerName, val) {
  settings.innerLayerVisibility[layerName] = val;
  saveSettings();
  // Inner layers are composited in the worker — trigger a full re-render
  if (initDone) {
    redrawAll();
  }
}

function redrawAllIfDone() {
  if (initDone) redrawAll();
}

// ---- Tab switching ----

function switchTab(tabName) {
  ["components","nets"].forEach(function(t) {
    document.getElementById("tab-" + t).classList.toggle("active", t === tabName);
    document.getElementById("panel-" + t).style.display = (t === tabName) ? "flex" : "none";
  });
}

function setActiveTab(name) { switchTab(name); }

// ---- Component list ----

var compFilter = "";
// pinnedComponents: { fpIdx: colorHex }
var pinnedComponents = {};

// Unified selection registry — shared palette between nets and components.
// Each entry: { type: 'net'|'comp', value: netName|fpIdx, color: hex }
var selectionRegistry = [];

function registerSelection(type, value) {
  if (selectionRegistry.find(function(s) { return s.type === type && s.value === value; })) return;
  var used = new Set(selectionRegistry.map(function(s) { return s.color; }));
  var color = NET_WALK_PALETTE[NET_WALK_PALETTE.length - 1]; // fallback
  for (var i = 0; i < NET_WALK_PALETTE.length; i++) {
    if (!used.has(NET_WALK_PALETTE[i])) { color = NET_WALK_PALETTE[i]; break; }
  }
  selectionRegistry.push({ type: type, value: value, color: color });
}

function unregisterSelection(type, value) {
  var idx = selectionRegistry.findIndex(function(s) { return s.type === type && s.value === value; });
  if (idx >= 0) selectionRegistry.splice(idx, 1);
}

function getSelectionColor(type, value) {
  var entry = selectionRegistry.find(function(s) { return s.type === type && s.value === value; });
  return entry ? entry.color : null;
}

function peekSelectionColor(type, value) {
  var existing = getSelectionColor(type, value);
  if (existing) return existing;
  // Preview: next palette color that would be assigned if this item were registered now
  var used = new Set(selectionRegistry.map(function(s) { return s.color; }));
  for (var i = 0; i < NET_WALK_PALETTE.length; i++) {
    if (!used.has(NET_WALK_PALETTE[i])) return NET_WALK_PALETTE[i];
  }
  return NET_WALK_PALETTE[selectionRegistry.length % NET_WALK_PALETTE.length];
}

function getPinColor(fpIdx) {
  return pinnedComponents[fpIdx] || null;
}

function togglePinComponent(fpIdx) {
  if (pinnedComponents[fpIdx]) {
    delete pinnedComponents[fpIdx];
    unregisterSelection('comp', fpIdx);
  } else {
    registerSelection('comp', fpIdx);
    pinnedComponents[fpIdx] = getSelectionColor('comp', fpIdx);
  }
  updateHashFromSelection();
  populateComponentList();
  if (selectedNet) populateNetResults(selectedNet);
  redrawAllIfDone();
}

function filterComponentList() {
  var el = document.getElementById("comp-search-input");
  if (el) updateCompFilter(el.value);
}

function filterNetSearch() {
  var el = document.getElementById("net-search-input");
  if (el) updateNetFilter(el.value);
}

function updateCompFilter(val) {
  compFilter = val.trim().toLowerCase();
  populateComponentList();
}

function populateComponentList() {
  var tbody = document.getElementById("comp-tbody");
  tbody.innerHTML = "";
  var components = pcbdata.components;
  var footprints = pcbdata.footprints;

  for (var i = 0; i < footprints.length; i++) {
    var fp = footprints[i];
    var comp = components[i];
    if (compFilter) {
      var pn = comp && comp.extra_fields && comp.extra_fields["PART_NUMBER"] ? String(comp.extra_fields["PART_NUMBER"]).toLowerCase() : "";
      var val = comp ? comp.val.toLowerCase() : "";
      var pads = fp.pads || [];
      var netMatch = pads.some(function(p) { return p.net && p.net.toLowerCase().indexOf(compFilter) >= 0; });
      if (fp.ref.toLowerCase().indexOf(compFilter) < 0 &&
          val.indexOf(compFilter) < 0 &&
          pn.indexOf(compFilter) < 0 &&
          !netMatch) continue;
    }

    var tr = document.createElement("tr");
    tr.dataset.idx = i;
    tr.classList.add("comp-row");

    var tdRef = document.createElement("td");
    tdRef.className = "ref-cell";
    // Pin swatch
    var pinColor = getPinColor(i);
    if (pinColor) {
      var psw = document.createElement("span");
      psw.className = "net-walk-swatch";
      psw.style.background = pinColor;
      psw.style.marginRight = "5px";
      psw.style.display = "inline-block";
      tdRef.appendChild(psw);
    }
    tdRef.appendChild(document.createTextNode(fp.ref));
    tr.appendChild(tdRef);

    var tdVal = document.createElement("td");
    tdVal.textContent = comp ? comp.val : "";
    tr.appendChild(tdVal);

    // Net column: single net name (with walk color) or count
    var pads = fp.pads || [];
    var uniqueNets = [];
    pads.forEach(function(p) { if (p.net && uniqueNets.indexOf(p.net) < 0) uniqueNets.push(p.net); });
    var tdNet = document.createElement("td");
    tdNet.className = "comp-net-cell";
    if (uniqueNets.length === 0) {
      tdNet.innerHTML = '<span style="color:var(--text-muted)">—</span>';
    } else if (uniqueNets.length === 1) {
      var ncMap = buildWalkColorMap();
      var nc = ncMap[uniqueNets[0]];
      var inner = document.createElement("span");
      inner.className = "comp-net-inner";
      if (nc) {
        var sw = document.createElement("span");
        sw.className = "net-walk-swatch";
        sw.style.background = nc;
        inner.appendChild(sw);
      }
      var nm = document.createElement("span");
      nm.className = "comp-net-name";
      nm.textContent = uniqueNets[0];
      inner.appendChild(nm);
      tdNet.appendChild(inner);
      tdNet.title = uniqueNets[0];
    } else {
      tdNet.innerHTML = '<span style="color:var(--text-muted)">' + uniqueNets.length + ' nets</span>';
    }
    tr.appendChild(tdNet);

    tr.addEventListener("click", function(e) {
      var idx = parseInt(this.dataset.idx);
      hoverClear(); // the pin shows the part from here on
      togglePinComponent(idx);
      selectFootprint(idx, true);
    });
    tr.addEventListener("mouseenter", (function(idx) {
      return function() { hoverFootprint(idx); };
    })(i));
    tr.addEventListener("mouseleave", hoverClear);

    if (selectedFootprintIdx === i) tr.classList.add("selected");
    tbody.appendChild(tr);
  }
}

// ---- Hover highlight (transient, no selection state change) ----
//
// Hover only adds to what is shown: the walked nets and pinned parts stay, and
// the worker fades them while the hovered items are drawn on top (#35).
// highlightedFootprints holds the hovered parts, hoverNets the hovered nets.
// A hover shows only what its click adds: a walk link or a pad-table net shows
// just the net, since that click does not pin the part.

var hoverNets = [];

function setHover(nets, footprints) {
  hoverNets = nets;
  highlightedFootprints = footprints;
  scheduleRedrawAll();
}

function hoverFootprint(fpIdx) {
  setHover([], [fpIdx]);
}

function hoverNet(netName) {
  setHover([netName], []);
}

// Clicks call this too: a click can rebuild the list under the pointer, and
// then no mouseleave fires.
function hoverClear() {
  if (hoverNets.length === 0 && highlightedFootprints.length === 0) return;
  setHover([], []);
}

// ---- Net panel state ----

var netFilter = "";
var netTypeFilter = "ALL";
var netLayerFilter = "ALL";

function filterNetSearch() {
  var el = document.getElementById("net-search-input");
  netFilter = el ? el.value.trim() : "";
  populateNetSearchList();
}

function updateNetFilter(val) {
  netFilter = val.trim();
  var el = document.getElementById("net-search-input");
  if (el) el.value = val;
  populateNetSearchList();
}

function populateNetSearchList() {
  var container = document.getElementById("net-search-list");
  if (!container || !pcbdata.nets) return;
  container.innerHTML = "";

  var lower = netFilter.toLowerCase();
  var nets = pcbdata.nets.filter(function(n) {
    if (!n || !n.trim()) return false;  // skip unnamed/blank nets
    var entries = netToComponents[n] || [];
    if (entries.length === 0) return false;  // skip nets with no components
    if (netTypeFilter !== "ALL") {
      // filter by whether any component on this net matches the type
      var entries = netToComponents[n] || [];
      if (!entries.some(e => getRefType(pcbdata.footprints[e.fpIdx].ref) === netTypeFilter)) return false;
    }
    if (netLayerFilter !== "ALL") {
      if (!netToLayers[n] || !netToLayers[n].has(netLayerFilter)) return false;
    }
    return !lower || n.toLowerCase().indexOf(lower) >= 0;
  });
  nets.sort();

  // Build a color map from walk history
  var netColorMap = buildWalkColorMap();

  if (nets.length === 0) {
    container.innerHTML = '<div class="empty-state">No nets match</div>';
    return;
  }

  nets.forEach(function(netName) {
    var count = netToComponents[netName] ? netToComponents[netName].length : 0;
    var row = document.createElement("div");
    row.className = "net-search-row";
    if (netName === selectedNet) row.classList.add("selected");

    var color = netColorMap[netName];
    if (color) {
      var swatch = document.createElement("span");
      swatch.className = "net-walk-swatch";
      swatch.style.background = color;
      row.appendChild(swatch);
    }

    var nameSpan = document.createElement("span");
    nameSpan.className = "net-search-name";
    nameSpan.textContent = netName;
    row.appendChild(nameSpan);

    var countSpan = document.createElement("span");
    countSpan.className = "net-search-count";
    countSpan.textContent = count;
    row.appendChild(countSpan);

    row.addEventListener("click", function() {
      hoverClear();
      selectNet(netName);
    });
    row.addEventListener("mouseenter", (function(n) {
      return function() { hoverNet(n); };
    })(netName));
    row.addEventListener("mouseleave", hoverClear);
    container.appendChild(row);
  });
}

function buildWalkColorMap() {
  var map = {};
  netWalkHistory.forEach(function(step) {
    if (step.type === "net") {
      var c = getSelectionColor('net', step.value);
      if (c) map[step.value] = c;
    }
  });
  return map;
}

function netGoBack() {
  document.getElementById("net-search-panel").style.display = "flex";
  document.getElementById("net-detail-panel").style.display = "none";
  populateNetSearchList();
}

function showNetDetailPanel(netName) {
  document.getElementById("net-search-panel").style.display = "none";
  var detail = document.getElementById("net-detail-panel");
  detail.style.display = "flex";
  var title = document.getElementById("net-detail-title");
  var color = buildWalkColorMap()[netName];
  title.textContent = netName;
  title.style.color = color || "";
  title.style.fontWeight = color ? "700" : "";
  buildNetLayerBadges(netName);
}

function layerBadgeLabel(layer) {
  if (layer === "F") return "F";
  if (layer === "B") return "B";
  // Allegro: ETCH/LAY2. KiCad: In1.Cu.
  var m = layer.match(/(?:LAY|In)(\d+)/);
  return m ? m[1] : layer;
}

function sortNetLayers(layers) {
  return layers.slice().sort(function(a, b) {
    if (a === "F") return -1;
    if (b === "F") return 1;
    if (a === "B") return 1;
    if (b === "B") return -1;
    var ma = a.match(/LAY(\d+)/), mb = b.match(/LAY(\d+)/);
    if (ma && mb) return parseInt(ma[1]) - parseInt(mb[1]);
    return a.localeCompare(b);
  });
}

function buildNetLayerBadges(netName) {
  var container = document.getElementById("net-layer-badges");
  if (!container) return;
  container.innerHTML = "";
  var layers = netToLayers[netName];
  if (!layers || layers.size === 0) { container.style.display = "none"; return; }
  var sorted = sortNetLayers(Array.from(layers));
  sorted.forEach(function(layer) {
    var btn = document.createElement("button");
    btn.className = "layer-badge net-layer-badge-btn";
    btn.textContent = layerBadgeLabel(layer);
    btn.title = layer;
    btn.style.background = getLayerColor(layer);
    btn.addEventListener("click", function() { activateNetLayer(layer); });
    container.appendChild(btn);
  });
  container.style.display = "flex";
}

function activateNetLayer(layerName) {
  revealLayer(layerName);
  zoomFitSelected();
}

// Make a copper layer visible: the side's own canvas, x-ray, or an inner layer.
function revealLayer(layerName) {
  if (layerName === "F") {
    if (settings.canvaslayout === "B") {
      // Opposite layer — enable xray instead of switching to both views
      var cb = document.getElementById("cb-front-on-back");
      if (cb) cb.checked = true;
      setShowFrontOnBack(true);
    }
    // If layout is "F" or "FB", front is already visible — nothing to do
  } else if (layerName === "B") {
    if (settings.canvaslayout === "F") {
      // Opposite layer — enable xray instead of switching to both views
      var cb = document.getElementById("cb-back-on-front");
      if (cb) cb.checked = true;
      setShowBackOnFront(true);
    }
    // If layout is "B" or "FB", back is already visible — nothing to do
  } else {
    setInnerLayerVisible(layerName, true);
  }
}

function setNetTypeFilter(type) {
  netTypeFilter = type;
  document.querySelectorAll(".type-filter-btn").forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.type === type);
  });
  populateNetSearchList();
  if (selectedNet) populateNetResults(selectedNet);
}

function setNetLayerFilter(layer) {
  netLayerFilter = layer;
  document.querySelectorAll(".layer-filter-btn").forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.layer === layer);
  });
  populateNetSearchList();
}

function sortCopperLayers(layers) {
  return layers.slice().sort(function(a, b) {
    if (a === "F.Cu") return -1;
    if (b === "F.Cu") return 1;
    if (a === "B.Cu") return 1;
    if (b === "B.Cu") return -1;
    var ma = a.match(/In(\d+)/), mb = b.match(/In(\d+)/);
    if (ma && mb) return parseInt(ma[1]) - parseInt(mb[1]);
    return a.localeCompare(b);
  });
}

function buildLayerFilterButtons() {
  var bar = document.getElementById("layer-filter-bar");
  if (!bar) return;
  // Collect all copper layers that have at least one named net
  var layerSet = new Set();
  for (var net in netToLayers) {
    netToLayers[net].forEach(function(l) { layerSet.add(l); });
  }
  var layers = sortCopperLayers(Array.from(layerSet));
  if (layers.length === 0) { bar.style.display = "none"; return; }

  var allLayers = ["ALL"].concat(layers);
  allLayers.forEach(function(layer) {
    var btn = document.createElement("button");
    btn.className = "type-filter-btn layer-filter-btn" + (layer === "ALL" ? " active" : "");
    btn.dataset.layer = layer;
    // Shorten label: "F.Cu" → "F", "B.Cu" → "B", "In1.Cu" → "In1"
    btn.textContent = layer === "ALL" ? "ALL" : layer.replace(/\.Cu$/, "");
    btn.title = layer;
    btn.addEventListener("click", function() { setNetLayerFilter(layer); });
    bar.appendChild(btn);
  });
}

function selectNet(netName) {
  selectedNet = netName;
  selectedFootprintIdx = null;
  highlightedNet = netName;
  highlightedFootprints = [];
  hoverNets = [];

  // Push to walk history if not already the last entry. Leave
  // highlightedNetPath alone: a repeat step does not rebuild it (#38).
  pushWalkStep({ type: "net", value: netName });

  updateHashFromSelection();
  showNetDetailPanel(netName);
  populateNetResults(netName);
  renderDetailPane(null);
  redrawAllIfDone();
}

function populateNetResults(netName) {
  var container = document.getElementById("net-results");
  container.innerHTML = "";

  var entries = netToComponents[netName] || [];

  // Filter by type
  var filtered = entries.filter(function(e) {
    if (netTypeFilter === "ALL") return true;
    return getRefType(pcbdata.footprints[e.fpIdx].ref) === netTypeFilter;
  });

  // Sort by ref
  filtered.sort((a, b) => compareRefs(
    pcbdata.footprints[a.fpIdx].ref,
    pcbdata.footprints[b.fpIdx].ref
  ));

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No components match filter</div>';
    return;
  }

  var header = document.createElement("div");
  header.className = "net-result-header";
  header.textContent = netName + " — " + filtered.length + " components" + (netTypeFilter !== "ALL" ? " (" + netTypeFilter + ")" : "");
  container.appendChild(header);

  filtered.forEach(function(entry) {
    var fpIdx = entry.fpIdx;
    var fp = pcbdata.footprints[fpIdx];
    var comp = pcbdata.components[fpIdx];

    var row = document.createElement("div");
    row.className = "net-comp-row";
    if (fpIdx === selectedFootprintIdx) row.classList.add("selected");

    // Pin swatch (same as component list)
    var pinColor = getPinColor(fpIdx);
    if (pinColor) {
      var psw = document.createElement("span");
      psw.className = "net-walk-swatch";
      psw.style.background = pinColor;
      psw.style.marginRight = "5px";
      psw.style.display = "inline-block";
      row.appendChild(psw);
    }

    var refSpan = document.createElement("span");
    refSpan.className = "net-comp-ref";
    refSpan.textContent = fp.ref;
    row.appendChild(refSpan);

    var valSpan = document.createElement("span");
    valSpan.className = "net-comp-val";
    valSpan.textContent = comp ? comp.val : "";
    row.appendChild(valSpan);

    var layerSpan = document.createElement("span");
    layerSpan.className = "layer-badge layer-" + fp.layer;
    layerSpan.textContent = fp.layer;
    row.appendChild(layerSpan);

    row.addEventListener("click", function(e) {
      hoverClear();
      togglePinComponent(fpIdx);
      renderDetailPane(fpIdx, false);
      updateCompListSelection(fpIdx);
      redrawAllIfDone();
      var targetLayer = pcbdata.footprints[fpIdx].layer;
      var canvasdict = targetLayer === "B" ? allcanvas.back : allcanvas.front;
      if (settings.canvaslayout !== "FB" && settings.canvaslayout !== targetLayer) {
        setCanvasLayout(targetLayer);
      }
      zoomToFootprint(fpIdx, canvasdict);
    });
    row.addEventListener("mouseenter", (function(idx) {
      return function() { hoverFootprint(idx); };
    })(fpIdx));
    row.addEventListener("mouseleave", hoverClear);

    container.appendChild(row);

    // Net walking: show other nets for this component (if 2-pin, inline; otherwise expandable)
    var nets = Array.from(componentToNets[fpIdx]).filter(n => n !== netName && n !== "");
    if (nets.length > 0 && nets.length <= 3) {
      var walkRow = document.createElement("div");
      walkRow.className = "walk-row";
      nets.forEach(function(otherNet) {
        var link = document.createElement("button");
        link.className = "walk-link";
        link.textContent = "→ " + otherNet;
        link.title = "Navigate to net " + otherNet;
        link.addEventListener("click", function(e) {
          e.stopPropagation();
          hoverClear();
          pushWalkStep({ type: "comp", value: fpIdx });
          addBreadcrumb(fp.ref + " [" + fp.layer + "]", function() { selectFootprint(fpIdx, false); });
          selectNet(otherNet);
          document.getElementById("net-search-input").value = otherNet;
        });
        link.addEventListener("mouseenter", (function(otNet) {
          return function() { hoverNet(otNet); };
        })(otherNet));
        link.addEventListener("mouseleave", hoverClear);
        walkRow.appendChild(link);
      });
      container.appendChild(walkRow);
    } else if (nets.length > 3) {
      var details = document.createElement("details");
      details.className = "walk-details";
      var summary = document.createElement("summary");
      summary.textContent = "Other nets (" + nets.length + ")";
      details.appendChild(summary);
      nets.forEach(function(otherNet) {
        var link = document.createElement("button");
        link.className = "walk-link";
        link.textContent = "→ " + otherNet;
        link.addEventListener("click", function(e) {
          e.stopPropagation();
          hoverClear();
          pushWalkStep({ type: "comp", value: fpIdx });
          addBreadcrumb(fp.ref + " [" + fp.layer + "]", function() { selectFootprint(fpIdx, false); });
          selectNet(otherNet);
          document.getElementById("net-search-input").value = otherNet;
        });
        link.addEventListener("mouseenter", (function(otNet) {
          return function() { hoverNet(otNet); };
        })(otherNet));
        link.addEventListener("mouseleave", hoverClear);
        details.appendChild(link);
      });
      container.appendChild(details);
    }
  });
}

// ---- Component selection ----

function selectFootprint(fpIdx, zoomTo) {
  selectedFootprintIdx = fpIdx;
  // Canvas color comes from pinnedComponents; highlightedFootprints is hover-only.

  var fp = pcbdata.footprints[fpIdx];

  // Don't null out selectedNet — keep net context for breadcrumbs
  updateHashFromSelection();
  renderDetailPane(fpIdx);
  updateCompListSelection(fpIdx);
  if (selectedNet) populateNetResults(selectedNet);
  redrawAllIfDone();

  if (zoomTo) {
    var targetLayer = fp.layer;
    var canvasdict = targetLayer === "B" ? allcanvas.back : allcanvas.front;
    if (settings.canvaslayout !== "FB" && settings.canvaslayout !== targetLayer) {
      setCanvasLayout(targetLayer);
    }
    zoomToFootprint(fpIdx, canvasdict);
  }
}

function updateCompListSelection(fpIdx) {
  document.querySelectorAll(".comp-row").forEach(function(row) {
    row.classList.toggle("selected", parseInt(row.dataset.idx) === fpIdx);
  });
  // Scroll into view
  var row = document.querySelector(".comp-row.selected");
  if (row) row.scrollIntoView({ block: "nearest" });
}

// ---- Detail pane ----

function renderDetailPane(fpIdx, showPads) {
  if (showPads === undefined) showPads = true;
  // When showPads is false we're in net context — render into the net panel's detail area
  var paneId = showPads ? "detail-pane" : "net-comp-detail";
  var pane = document.getElementById(paneId);
  var handle = document.getElementById("detail-resize-handle");
  if (fpIdx === null) {
    pane.innerHTML = ""; pane.style.display = "none";
    if (showPads && handle) handle.style.display = "none";
    return;
  }

  var fp = pcbdata.footprints[fpIdx];
  var comp = pcbdata.components[fpIdx];
  pane.style.display = "block";
  if (showPads && handle) handle.style.display = "block";

  var html = '<div class="detail-header">';
  html += '<span class="detail-ref" id="detail-ref" title="Click to copy">' + escapeHtml(fp.ref) + '</span>';
  html += ' <button class="copy-btn" onclick="copyRef()">⧉</button>';
  html += '</div>';
  html += '<table class="detail-table">';
  html += '<tr><td>Value</td><td>' + escapeHtml(comp ? comp.val : "") + '</td></tr>';
  html += '<tr><td>Footprint</td><td>' + escapeHtml(comp ? (comp.footprint || "") : "") + '</td></tr>';
  html += '<tr><td>Layer</td><td><span class="layer-badge layer-' + fp.layer + '">' + fp.layer + '</span></td></tr>';

  // Extra fields
  if (comp && comp.extra_fields) {
    for (var k of Object.keys(comp.extra_fields)) {
      var v = comp.extra_fields[k];
      if (v) html += '<tr><td>' + escapeHtml(k) + '</td><td>' + escapeHtml(String(v)) + '</td></tr>';
    }
  }
  html += '</table>';

  pane.innerHTML = html;

  // Pads / nets — built as DOM so hover events can be attached
  if (showPads && fp.pads && fp.pads.length > 0) {
    var secTitle = document.createElement("div");
    secTitle.className = "detail-section-title";
    secTitle.textContent = "Pads & Nets";
    pane.appendChild(secTitle);

    var padTable = document.createElement("table");
    padTable.className = "pad-table";
    var thead = document.createElement("tr");
    ["#", "Net", "Type"].forEach(function(h) {
      var th = document.createElement("th");
      th.textContent = h;
      thead.appendChild(th);
    });
    padTable.appendChild(thead);

    fp.pads.forEach(function(pad, i) {
      var tr = document.createElement("tr");

      var tdNum = document.createElement("td");
      tdNum.textContent = i + 1;
      tr.appendChild(tdNum);

      var tdNet = document.createElement("td");
      if (pad.net) {
        var btn = document.createElement("button");
        btn.className = "net-link-btn";
        btn.textContent = pad.net;
        btn.addEventListener("click", (function(n) {
          return function() { hoverClear(); navigateToNet(n); };
        })(pad.net));
        btn.addEventListener("mouseenter", (function(n) {
          return function() { hoverNet(n); };
        })(pad.net));
        btn.addEventListener("mouseleave", hoverClear);
        tdNet.appendChild(btn);
      } else {
        var noNet = document.createElement("span");
        noNet.className = "no-net";
        noNet.textContent = "—";
        tdNet.appendChild(noNet);
      }
      tr.appendChild(tdNet);

      var tdType = document.createElement("td");
      tdType.textContent = pad.type || "";
      tr.appendChild(tdType);

      padTable.appendChild(tr);
    });

    pane.appendChild(padTable);
  }
}

function copyRef() {
  if (selectedFootprintIdx === null) return;
  var ref = pcbdata.footprints[selectedFootprintIdx].ref;
  copyToClipboard(ref);
  flashElement(document.getElementById("detail-ref"));
}

function navigateToNet(netName) {
  document.getElementById("net-search-input").value = netName;
  selectNet(netName);
  switchTab("nets");
  // Breadcrumb: from component
  if (selectedFootprintIdx !== null) {
    var fp = pcbdata.footprints[selectedFootprintIdx];
    addBreadcrumb(fp.ref, function() { selectFootprint(selectedFootprintIdx, true); });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return String(s).replace(/'/g, "\\'");
}

// ---- Net walking breadcrumbs ----

function pushWalkStep(step) {
  // If same as last step, do nothing
  var last = netWalkHistory[netWalkHistory.length - 1];
  if (last && last.type === step.type && last.value === step.value) return;
  // Register net selections in the shared palette (idempotent)
  if (step.type === 'net') registerSelection('net', step.value);
  netWalkHistory.push(step);
  rebuildBreadcrumbs();
}

function addBreadcrumb(label, action) {
  netWalkBreadcrumbs.push({ label, action });
  renderBreadcrumbs();
}

function rebuildBreadcrumbs() {
  // Colors come from the unified selectionRegistry (set by pushWalkStep)
  netWalkBreadcrumbs = netWalkHistory.map(function(step) {
    if (step.type === "net") {
      return {
        label: step.value,
        color: getSelectionColor('net', step.value),
        action: (function(n) { return function() {
          document.getElementById("net-search-input").value = n;
          selectNet(n);
        }; })(step.value)
      };
    } else {
      var ref = pcbdata.footprints[step.value] ? pcbdata.footprints[step.value].ref : "?";
      return {
        label: ref,
        color: null,
        action: (function(idx) { return function() { selectFootprint(idx, true); }; })(step.value)
      };
    }
  });
  renderBreadcrumbs();
  // Update multi-net path highlight
  highlightedNetPath = netWalkHistory.filter(s => s.type === "net").map(s => s.value);
  populateNetSearchList();  // refresh walk colors in search list
  populateComponentList();  // refresh walk colors in net column
  redrawAllIfDone();
}

function renderBreadcrumbs() {
  var bar = document.getElementById("breadcrumb-bar");
  if (netWalkBreadcrumbs.length <= 1) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  bar.innerHTML = "";
  var clearBtn = document.createElement("button");
  clearBtn.className = "breadcrumb-clear";
  clearBtn.textContent = "✕";
  clearBtn.title = "Clear path";
  clearBtn.addEventListener("click", clearWalkHistory);
  bar.appendChild(clearBtn);
  netWalkBreadcrumbs.forEach(function(crumb, i) {
    if (i > 0) {
      var sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = "›";
      bar.appendChild(sep);
    }
    var btn = document.createElement("button");
    btn.className = "breadcrumb-item";
    btn.textContent = crumb.label;
    if (crumb.color) {
      btn.style.background = crumb.color;
      btn.style.borderColor = crumb.color;
      btn.style.color = "#000";
    }
    btn.addEventListener("click", crumb.action);
    bar.appendChild(btn);
  });
}

function clearWalkHistory() {
  netWalkHistory.forEach(function(step) {
    if (step.type === 'net') unregisterSelection('net', step.value);
  });
  netWalkHistory = [];
  netWalkBreadcrumbs = [];
  highlightedNetPath = [];
  renderBreadcrumbs();
  updateHashFromSelection();
  redrawAllIfDone();
}

function deselect() {
  selectedFootprintIdx = null;
  selectedNet = null;
  highlightedFootprints = [];
  hoverNets = [];
  highlightedNet = null;
  highlightedNetPath = [];
  netWalkHistory = [];
  netWalkBreadcrumbs = [];
  renderBreadcrumbs();
  renderDetailPane(null);
  document.querySelectorAll(".comp-row.selected").forEach(r => r.classList.remove("selected"));
  document.querySelectorAll(".net-comp-row.selected").forEach(r => r.classList.remove("selected"));
  // Return to search panel
  netGoBack();
  document.getElementById("net-search-input").value = "";
  netFilter = "";
  populateNetSearchList();
  populateComponentList();
  pinnedComponents = {};
  selectionRegistry = [];
  updateHashFromSelection();
  redrawAllIfDone();
}

// ---- Detail pane resize ----

function initDetailResize() {
  var handle = document.getElementById("detail-resize-handle");
  var pane = document.getElementById("detail-pane");
  if (!handle || !pane) return;

  handle.addEventListener("mousedown", function(e) {
    var startY = e.clientY;
    var startH = pane.offsetHeight;
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";

    function onMove(e) {
      var delta = startY - e.clientY;  // drag up = taller
      var newH = Math.max(60, Math.min(600, startH + delta));
      pane.style.height = newH + "px";
    }

    function onUp() {
      handle.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
}

// ---- Canvas click callbacks (called from render.js) ----

function onNetClickedFromCanvas(netName) {
  document.getElementById("net-search-input").value = netName;
  selectNet(netName);
  switchTab("nets");
}

function onFootprintClickedFromCanvas(fpIdx) {
  togglePinComponent(fpIdx);
  selectFootprint(fpIdx, false);
  // Switch to components tab to show the selection
  switchTab("components");
  updateCompListSelection(fpIdx);
  // Scroll comp list to selected
  var row = document.querySelector("#comp-tbody .comp-row.selected");
  if (row) row.scrollIntoView({ block: "nearest" });
}

// ---- Inner layer controls ----

function buildLayerControls() {
  var container = document.getElementById("inner-layer-toggles");
  if (!container) return;
  var innerLayers = getInnerLayers();
  if (innerLayers.length === 0) { container.style.display = "none"; return; }

  innerLayers.forEach(function(layerName) {
    var defaultVisible = settings.innerLayerVisibility[layerName] !== undefined
      ? settings.innerLayerVisibility[layerName]
      : (settings.defaultInnerLayersVisible !== false);
    if (settings.innerLayerVisibility[layerName] === undefined) {
      settings.innerLayerVisibility[layerName] = defaultVisible;
    }
    var label = document.createElement("label");
    label.className = "layer-toggle-label";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = defaultVisible;
    cb.addEventListener("change", (function(ln) {
      return function() { setInnerLayerVisible(ln, this.checked); };
    })(layerName));
    var swatch = document.createElement("span");
    swatch.className = "layer-swatch";
    swatch.style.background = getLayerColor(layerName);
    var text = document.createElement("span");
    text.textContent = layerName.replace("ETCH/", "");
    label.appendChild(cb);
    label.appendChild(swatch);
    label.appendChild(text);
    container.appendChild(label);
  });
}

// ---- Metadata ----

function populateMetadata() {
  var m = pcbdata.metadata;
  if (!m) return;
  document.getElementById("meta-title").textContent = m.title || "";
  document.getElementById("meta-revision").textContent = m.revision ? ("Rev " + m.revision) : "";
  document.getElementById("meta-company").textContent = m.company || "";
  document.getElementById("meta-date").textContent = m.date || "";
  document.title = (m.title ? m.title + " — " : "") + "PCBA Bringup Viewer";
}

// ---- Type filter buttons in net panel ----

function buildTypeFilterButtons() {
  var bar = document.getElementById("type-filter-bar");
  if (!bar) return;
  var types = ["ALL"].concat(KNOWN_PREFIXES).concat(["OTHER"]);
  types.forEach(function(type) {
    var btn = document.createElement("button");
    btn.className = "type-filter-btn" + (type === "ALL" ? " active" : "");
    btn.dataset.type = type;
    btn.textContent = type;
    btn.addEventListener("click", function() { setNetTypeFilter(type); });
    bar.appendChild(btn);
  });
}

// ---- Help overlay ----

function toggleHelpOverlay() {
  var el = document.getElementById("help-overlay");
  if (el) el.style.display = (el.style.display === "none" || !el.style.display) ? "flex" : "none";
}

// ---- Zoom actions ----

// Apply a zoom function to all currently visible canvases
function zoomAll(fn) {
  if (settings.canvaslayout !== "B") fn(allcanvas.front);
  if (settings.canvaslayout !== "F") fn(allcanvas.back);
}

// W: zoom to fit board in all visible canvases
function zoomFitBoardAll() {
  zoomAll(function(ld) { zoomFitBoard(ld); });
}

// E: zoom to fit all highlighted objects still visible given current layer filters.
function zoomFitSelected() {
  var layout = settings.canvaslayout;

  // Build the set of points visible on a given canvas side ("F" or "B").
  // Respects xray: e.g. showBackOnFront means B-layer things are also visible on the front canvas.
  function buildPoints(canvasSide) {
    var primaryLayer = canvasSide;           // "F" or "B"
    var crossLayer   = canvasSide === "F" ? "B" : "F";
    var showCross    = canvasSide === "F" ? settings.showBackOnFront : settings.showFrontOnBack;
    var pts = [];

    function addFpCorners(fp) {
      if (!fp) return;
      var b = fp.bbox;
      var x0 = b.pos[0] + b.relpos[0];
      var y0 = b.pos[1] + b.relpos[1];
      pts.push([x0, y0]);
      pts.push([x0 + b.size[0], y0]);
      pts.push([x0, y0 + b.size[1]]);
      pts.push([x0 + b.size[0], y0 + b.size[1]]);
    }

    function wantLayer(fpLayer) {
      return fpLayer === primaryLayer || (showCross && fpLayer === crossLayer);
    }

    // Pinned components
    Object.keys(pinnedComponents).forEach(function(idx) {
      var fp = pcbdata.footprints[parseInt(idx)];
      if (fp && wantLayer(fp.layer)) addFpCorners(fp);
    });

    // Collect all active nets
    var activeNets = new Set();
    if (highlightedNet !== null) activeNets.add(highlightedNet);
    selectionRegistry.forEach(function(s) { if (s.type === 'net') activeNets.add(s.value); });

    activeNets.forEach(function(netName) {
      pcbdata.footprints.forEach(function(fp) {
        if (!wantLayer(fp.layer)) return;
        fp.pads.forEach(function(pad) {
          if (pad.net === netName) pts.push(pad.pos);
        });
      });
      if (pcbdata.tracks) {
        Object.keys(pcbdata.tracks).forEach(function(layer) {
          // Only include track layers that are rendered on this canvas side
          // Track layer keys in pcbdata are "F", "B", or inner-layer names ("In1.Cu" etc.)
          var trackSide = layer === "B" ? "B" : "F";
          if (!wantLayer(trackSide)) return;
          pcbdata.tracks[layer].forEach(function(t) {
            if (t.net === netName && t.start) {
              pts.push(t.start);
              if (t.end && (t.start[0] !== t.end[0] || t.start[1] !== t.end[1])) pts.push(t.end);
            }
          });
        });
      }
    });

    return pts;
  }

  if (layout !== "B") {
    var fPts = buildPoints("F");
    if (fPts.length > 0) zoomFitPoints(allcanvas.front, fPts);
    else zoomFitBoard(allcanvas.front);
  }
  if (layout !== "F") {
    var bPts = buildPoints("B");
    if (bPts.length > 0) zoomFitPoints(allcanvas.back, bPts);
    else zoomFitBoard(allcanvas.back);
  }
}

// R: zoom into the currently selected / last highlighted footprint, or fit the current net.
function zoomIntoHighlight() {
  var idx = (typeof selectedFootprintIdx !== 'undefined' && selectedFootprintIdx !== null)
    ? selectedFootprintIdx
    : (typeof highlightedFootprints !== 'undefined' && highlightedFootprints.length > 0 ? highlightedFootprints[0] : null);
  if (idx === null || idx === undefined) {
    // No footprint selected — fall back to net zoom
    zoomFitSelected();
    return;
  }
  var fp = pcbdata.footprints[idx];
  if (!fp) return;
  var targetLayer = fp.layer;
  var ld = targetLayer === "B" ? allcanvas.back : allcanvas.front;
  if (settings.canvaslayout !== "FB" && settings.canvaslayout !== targetLayer) {
    setCanvasLayout(targetLayer);
  }
  zoomToFootprint(idx, ld);
}

// ---- Links (#13) ----
//
// The hash format is described in util.js.

var LINK_ZOOMS = { board: zoomFitBoardAll, selected: zoomFitSelected, highlight: zoomIntoHighlight };

// Set every layer checkbox from settings.
function syncLayerControls() {
  var ids = {
    "cb-silk": settings.renderSilkscreen,
    "cb-fab": settings.renderFabrication,
    "cb-back-on-front": settings.showBackOnFront,
    "cb-front-on-back": settings.showFrontOnBack,
  };
  for (var id in ids) {
    var cb = document.getElementById(id);
    if (cb) cb.checked = ids[id];
  }
  var container = document.getElementById("inner-layer-toggles");
  if (container) {
    var cbs = container.querySelectorAll("input[type=checkbox]");
    getInnerLayers().forEach(function(l, i) {
      if (cbs[i]) cbs[i].checked = settings.innerLayerVisibility[l] !== false;
    });
  }
}

function parseViewBox(s) {
  var v = (s || "").split(",").map(Number);
  if (v.length !== 4 || !v.every(isFinite) || v[2] <= 0 || v[3] <= 0) return null;
  return { cx: v[0], cy: v[1], w: v[2], h: v[3] };
}

function formatViewBox(box) {
  return [box.cx, box.cy, box.w, box.h].map(function(n) { return +n.toFixed(2); }).join(",");
}

async function applyHashState() {
  var pairs = await decodeHash(window.location.hash.slice(1));
  if (pairs.length === 0) return;
  function get(k) {
    var p = pairs.find(function(p) { return p[0] === k; });
    return p ? p[1] : null;
  }
  function all(k) {
    return pairs.filter(function(p) { return p[0] === k && p[1] !== ""; }).map(function(p) { return p[1]; });
  }

  var before = JSON.parse(JSON.stringify(settings));
  _applyingLink = true;
  try {
    var side = get("side");
    if (side === "F" || side === "B" || side === "FB") setCanvasLayout(side);

    if (get("layers") !== null) {
      var visible = new Set(all("layers"));
      getInnerLayers().forEach(function(l) { setInnerLayerVisible(l, visible.has(l)); });
    }
    if (get("xray") !== null) {
      var xray = all("xray");
      setShowBackOnFront(xray.includes("back-on-front"));
      setShowFrontOnBack(xray.includes("front-on-back"));
    }
    if (get("overlay") !== null) {
      var overlay = all("overlay");
      silkscreenVisible(overlay.includes("silk"));
      fabricationVisible(overlay.includes("fab"));
    }

    // Replay the selection in order, so colours come out the same.
    var entries = [];
    pairs.forEach(function(p) {
      if (p[0] === "comp" || p[0] === "component") {
        var idx = componentByRef[p[1].toUpperCase()];
        if (idx === undefined) { console.warn("[PCBAViewer] Link: no component " + p[1]); return; }
        if (!pinnedComponents[idx]) togglePinComponent(idx);
        entries.push("comp:" + p[1]);
      } else if (p[0] === "net") {
        if (!netToComponents[p[1]]) { console.warn("[PCBAViewer] Link: no net " + p[1]); return; }
        selectNet(p[1]);
        entries.push("net:" + p[1]);
      }
    });

    var view = { F: parseViewBox(get("viewF")), B: parseViewBox(get("viewB")) };
    var zoom = LINK_ZOOMS[get("zoom")] || null;
    var focus = get("focus");
    if (focus === null) focus = entries.length ? entries[entries.length - 1] : "";
    if (focus.startsWith("comp:")) {
      var fidx = componentByRef[focus.slice(5).toUpperCase()];
      if (fidx !== undefined) {
        // Zoom to the part, as old links did, unless the link gives a view.
        selectFootprint(fidx, !view.F && !view.B && !zoom);
        switchTab("components");
      }
    } else if (focus.startsWith("net:")) {
      var fnet = focus.slice(4);
      if (netToComponents[fnet]) {
        if (selectedNet !== fnet) selectNet(fnet);
        switchTab("nets");
      }
    }

    if (get("netlayers") === "1") {
      var layers = new Set();
      all("net").forEach(function(n) {
        if (netToLayers[n]) netToLayers[n].forEach(function(l) { layers.add(l); });
      });
      layers.forEach(revealLayer);
    }

    if (view.F || view.B) {
      if (view.F && settings.canvaslayout !== "B") setViewBox(allcanvas.front, view.F);
      if (view.B && settings.canvaslayout !== "F") setViewBox(allcanvas.back, view.B);
    } else if (zoom) {
      zoom();
    }
  } finally {
    _applyingLink = false;
  }
  recordLinkOverrides(before);
  syncLayerControls();
}

// Pairs for a shared link: the selection, plus view and layers if asked for.
function shareLinkPairs(opts) {
  var pairs = selectionHashPairs();
  if (opts.view) {
    var layout = settings.canvaslayout;
    pairs.push(["side", layout]);
    var vf = layout !== "B" ? getViewBox(allcanvas.front) : null;
    var vb = layout !== "F" ? getViewBox(allcanvas.back) : null;
    if (vf) pairs.push(["viewF", formatViewBox(vf)]);
    if (vb) pairs.push(["viewB", formatViewBox(vb)]);
  } else if (opts.zoom) {
    pairs.push(["zoom", opts.zoom]);
  }
  if (opts.layers) {
    var inner = getInnerLayers().filter(function(l) { return settings.innerLayerVisibility[l] !== false; });
    var xray = [];
    if (settings.showBackOnFront) xray.push("back-on-front");
    if (settings.showFrontOnBack) xray.push("front-on-back");
    var overlay = [];
    if (settings.renderSilkscreen) overlay.push("silk");
    if (settings.renderFabrication) overlay.push("fab");
    [["layers", inner], ["xray", xray], ["overlay", overlay]].forEach(function(kv) {
      if (kv[1].length === 0) pairs.push([kv[0], ""]);
      else kv[1].forEach(function(v) { pairs.push([kv[0], v]); });
    });
  }
  return pairs;
}

function shareLinkOptions() {
  var zoom = document.querySelector("input[name=link-zoom]:checked");
  return {
    view: document.getElementById("cb-link-view").checked,
    layers: document.getElementById("cb-link-layers").checked,
    zoom: zoom ? zoom.value : "",
  };
}

async function buildShareLink() {
  var opts = shareLinkOptions();
  var hash = await encodeHash(shareLinkPairs(opts));
  return window.location.href.split("#")[0] + (hash ? "#" + hash : "");
}

// A preset zoom does not apply when the link carries the current view.
async function updateShareLink() {
  var useView = document.getElementById("cb-link-view").checked;
  document.querySelectorAll("input[name=link-zoom]").forEach(function(r) { r.disabled = useView; });
  document.getElementById("share-link-text").value = await buildShareLink();
}

async function copyShareLink() {
  await updateShareLink();
  copyToClipboard(document.getElementById("share-link-text").value);
  flashElement(document.getElementById("btn-copy-link"));
}

// ---- List keyboard navigation ----

function getCurrentTab() {
  return document.getElementById("tab-nets") && document.getElementById("tab-nets").classList.contains("active") ? "net" : "comp";
}

// Navigate up/down in the comp or net search results. delta = +1 (down) or -1 (up).
function navigateList(tabType, delta) {
  if (tabType === "comp") {
    var rows = Array.from(document.querySelectorAll("#comp-tbody .comp-row"));
    if (rows.length === 0) return;
    var cur = rows.findIndex(function(r) { return r.classList.contains("selected"); });
    var next = Math.max(0, Math.min(rows.length - 1, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta));
    var row = rows[next];
    var idx = parseInt(row.dataset.idx);
    togglePinComponent(idx);
    selectFootprint(idx, false);
    updateCompListSelection(idx);
    row.scrollIntoView({ block: "nearest" });
  } else {
    // Net panel
    var netDetail = document.getElementById("net-detail-panel");
    if (netDetail && netDetail.style.display !== "none") {
      // Navigate components within net detail
      var rows = Array.from(document.querySelectorAll("#net-results .net-comp-row"));
      if (rows.length === 0) return;
      var cur = rows.findIndex(function(r) { return r.classList.contains("focused"); });
      var next = Math.max(0, Math.min(rows.length - 1, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta));
      rows.forEach(function(r) { r.classList.remove("focused"); });
      rows[next].classList.add("focused");
      rows[next].scrollIntoView({ block: "nearest" });
    } else {
      var rows = Array.from(document.querySelectorAll("#net-search-list .net-search-row"));
      if (rows.length === 0) return;
      var cur = rows.findIndex(function(r) { return r.classList.contains("focused"); });
      var next = Math.max(0, Math.min(rows.length - 1, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta));
      rows.forEach(function(r) { r.classList.remove("focused"); });
      rows[next].classList.add("focused");
      rows[next].scrollIntoView({ block: "nearest" });
    }
  }
}

function activateListSelection(tabType) {
  if (tabType === "comp") {
    var row = document.querySelector("#comp-tbody .comp-row.selected") ||
              document.querySelector("#comp-tbody .comp-row");
    if (row) {
      var idx = parseInt(row.dataset.idx);
      hoverClear();
      if (!pinnedComponents[idx]) togglePinComponent(idx);
      selectFootprint(idx, true);
    }
  } else {
    var netDetail = document.getElementById("net-detail-panel");
    if (netDetail && netDetail.style.display !== "none") {
      var row = document.querySelector("#net-results .net-comp-row.focused");
      if (row) row.click();
    } else {
      var row = document.querySelector("#net-search-list .net-search-row.focused");
      if (row) row.click();
    }
  }
}

// ---- Resize handling ----

window.addEventListener("resize", function() {
  if (initDone) resizeAll();
});

// ---- Init ----

window.addEventListener("load", async function() {
  var _tLoad = performance.now();
  await pcbdataReady;
  var _tReady = performance.now();
  _loadTimings.pcbdataReady = _tReady;
  _loadTimings.waitedInLoadHandler = _tReady - _tLoad;
  console.log("[PCBAViewer] pcbdata ready + load event: " + _tReady.toFixed(0) + " ms (waited " + (_tReady - _tLoad).toFixed(0) + "ms in load handler)");
  initStorage();
  loadSettings();
  buildIndexes();
  _loadTimings.buildIndexes = performance.now() - _tReady;
  console.log("[PCBAViewer] indexes built: " + (performance.now() - _tReady).toFixed(0) + " ms after pcbdata ready");

  // Apply dark mode
  document.getElementById("topmostdiv").classList.toggle("dark", settings.darkMode);
  document.getElementById("darkmodeCheckbox").checked = settings.darkMode;

  populateMetadata();
  buildTypeFilterButtons();
  buildLayerFilterButtons();
  initRender();
  buildLayerControls();

  // Sync render overlay checkboxes to loaded settings
  var cbSilk = document.getElementById("cb-silk");
  var cbFab = document.getElementById("cb-fab");
  if (cbSilk) cbSilk.checked = settings.renderSilkscreen;
  if (cbFab) cbFab.checked = settings.renderFabrication;
  var cbBonF = document.getElementById("cb-back-on-front");
  var cbFonB = document.getElementById("cb-front-on-back");
  if (cbBonF) cbBonF.checked = settings.showBackOnFront;
  if (cbFonB) cbFonB.checked = settings.showFrontOnBack;

  // Sync canvas direction — initDone is false so resizeAll is skipped inside
  setCanvasDirection(settings.canvasDirection || "row");

  // Sync shadow mode controls
  var cbShadow = document.getElementById("cb-shadow");
  if (cbShadow) cbShadow.checked = settings.shadowMode;
  var slSB = document.getElementById("shadow-brightness");
  var slSS = document.getElementById("shadow-saturation");
  if (slSB) { slSB.value = settings.shadowBrightness; document.getElementById("shadow-brightness-val").textContent = settings.shadowBrightness + "%"; }
  if (slSS) { slSS.value = settings.shadowSaturation; document.getElementById("shadow-saturation-val").textContent = settings.shadowSaturation + "%"; }
  var sliders = document.getElementById("shadow-sliders");
  if (sliders) sliders.style.display = settings.shadowMode ? "block" : "none";

  // Set canvas layout — initDone is false so resizeAll is skipped inside
  setCanvasLayout(settings.canvaslayout);

  initDone = true;
  resizeAll(true); // skip per-canvas redraws — redrawAll() below covers it
  var t0 = performance.now();
  redrawAll();
  var t1 = performance.now();

  // RAF 1: hide overlay — this schedules the "overlay hidden" frame to be painted
  requestAnimationFrame(function() {
    var ov = document.getElementById("loading-overlay");
    if (ov) ov.style.display = "none";
    var t2 = performance.now();
    _loadTimings.redrawAll = t1 - t0;
    _loadTimings.overlayHidden = t2;
    console.log(
      "[PCBAViewer] redrawAll: " + (t1 - t0).toFixed(0) + " ms" +
      " | RAF1 (overlay hidden): " + t2.toFixed(0) + " ms since page load"
    );
    // RAF 2: fires AFTER the browser has actually painted the overlay-hidden frame
    requestAnimationFrame(function() {
      var t3 = performance.now();
      _loadTimings.boardVisible = t3;
      console.log("[PCBAViewer] RAF2 (board visible on screen): " + t3.toFixed(0) + " ms since page load");
      var _tPop = performance.now();
      populateComponentList();
      populateNetSearchList();
      _loadTimings.listsPopulated = performance.now() - _tPop;
      console.log("[PCBAViewer] lists populated: " + (performance.now() - _tPop).toFixed(0) + " ms");
    });
  });

  initDetailResize();

  // Restore inner layer visibility (checkbox + canvas display)
  Object.keys(settings.innerLayerVisibility).forEach(function(layerName) {
    if (!settings.innerLayerVisibility[layerName]) {
      setInnerLayerVisible(layerName, false);
    }
  });

  // Apply URL hash state. A bad link must not stop the rest of init.
  try {
    await applyHashState();
  } catch (e) {
    console.error("[PCBAViewer] Could not apply link: " + e);
  }
  _hashApplied = true;

  // Net search input
  var netInput = document.getElementById("net-search-input");
  netInput.addEventListener("input", function() { updateNetFilter(this.value); });

  // Component search input
  document.getElementById("comp-search-input").addEventListener("input", function() {
    updateCompFilter(this.value);
  });

  // Keyboard nav in component list
  document.getElementById("comp-search-input").addEventListener("keydown", function(e) {
    if (e.key === "Escape") { e.stopPropagation(); this.value = ""; updateCompFilter(""); this.blur(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); navigateList("comp", 1); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); navigateList("comp", -1); }
    else if (e.key === "Enter")     { e.preventDefault(); activateListSelection("comp"); this.blur(); }
  });

  document.getElementById("net-search-input").addEventListener("keydown", function(e) {
    if (e.key === "Escape") { e.stopPropagation(); this.value = ""; updateNetFilter(""); this.blur(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); navigateList("net", 1); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); navigateList("net", -1); }
    else if (e.key === "Enter")     { e.preventDefault(); activateListSelection("net"); this.blur(); }
  });

  // Blur search inputs when clicking outside them (capture phase so canvas stopPropagation doesn't block it)
  document.addEventListener("pointerdown", function(e) {
    var active = document.activeElement;
    if (active && (active.id === "comp-search-input" || active.id === "net-search-input")) {
      if (e.target !== active) active.blur();
    }
  }, true);

  // Global keyboard shortcuts
  document.addEventListener("keydown", function(e) {
    // Don't fire shortcuts when typing in an input/textarea
    var tag = document.activeElement && document.activeElement.tagName;
    var inInput = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");

    if (e.key === "Escape") {
      var helpEl = document.getElementById("help-overlay");
      if (helpEl && helpEl.style.display === "flex") { helpEl.style.display = "none"; return; }
      deselect();
      if (inInput) document.activeElement.blur();
      return;
    }

    if (inInput) return;

    if (e.key === "?") { toggleHelpOverlay(); return; }

    switch (e.key.toUpperCase()) {
      // Views
      case "F": setCanvasLayout("F"); break;
      case "B": setCanvasLayout("B"); break;
      case "G": setCanvasLayout("FB"); break;

      // Overlays
      case "S": {
        var cb = document.getElementById("cb-silk");
        if (cb) { var v = !settings.renderSilkscreen; cb.checked = v; silkscreenVisible(v); }
        break;
      }
      case "O": {
        var cb = document.getElementById("cb-fab");
        if (cb) { var v = !settings.renderFabrication; cb.checked = v; fabricationVisible(v); }
        break;
      }

      // X-ray see-through
      case "X": {
        var layout = settings.canvaslayout;
        if (layout === "F") {
          var cb = document.getElementById("cb-back-on-front");
          if (cb) { var v = !settings.showBackOnFront; cb.checked = v; setShowBackOnFront(v); }
        } else if (layout === "B") {
          var cb = document.getElementById("cb-front-on-back");
          if (cb) { var v = !settings.showFrontOnBack; cb.checked = v; setShowFrontOnBack(v); }
        } else {
          var cbBF = document.getElementById("cb-back-on-front");
          var cbFB = document.getElementById("cb-front-on-back");
          // Toggle both: if either is off, turn both on; if both on, turn both off
          var anyOff = !settings.showBackOnFront || !settings.showFrontOnBack;
          if (cbBF) { cbBF.checked = anyOff; setShowBackOnFront(anyOff); }
          if (cbFB) { cbFB.checked = anyOff; setShowFrontOnBack(anyOff); }
        }
        break;
      }

      // All copper layers toggle — smart: if net selected, toggle only that net's layers
      case "A": {
        var inner = getInnerLayers();
        var layout = settings.canvaslayout;

        if (selectedNet && netToLayers[selectedNet] && netToLayers[selectedNet].size > 0) {
          // Collect the toggleable things this net touches
          var netLayers = netToLayers[selectedNet];
          // xray booleans to toggle: B on front canvas, F on back canvas
          var needsBonF = netLayers.has("B") && layout !== "B"; // B visible on front only via xray
          var needsFonB = netLayers.has("F") && layout !== "F"; // F visible on back only via xray
          // inner layers this net touches
          var netInner = inner.filter(function(l) { return netLayers.has(l); });

          // Check if all toggleable items are currently active
          var xrayAllOn = (!needsBonF || settings.showBackOnFront) &&
                          (!needsFonB || settings.showFrontOnBack);
          var innerAllOn = netInner.every(function(l) { return settings.innerLayerVisibility[l] !== false; });
          var allOn = xrayAllOn && innerAllOn;
          var newVal = !allOn;

          // Apply
          if (needsBonF) {
            var cb = document.getElementById("cb-back-on-front");
            if (cb) cb.checked = newVal;
            setShowBackOnFront(newVal);
          }
          if (needsFonB) {
            var cb = document.getElementById("cb-front-on-back");
            if (cb) cb.checked = newVal;
            setShowFrontOnBack(newVal);
          }
          netInner.forEach(function(layerName) {
            setInnerLayerVisible(layerName, newVal);
            var container = document.getElementById("inner-layer-toggles");
            if (container) {
              var idx = inner.indexOf(layerName);
              var cbs = container.querySelectorAll("input[type=checkbox]");
              if (idx >= 0 && cbs[idx]) cbs[idx].checked = newVal;
            }
          });
        } else {
          // No net selected — toggle all inner layers + xray
          // "none active → activate all; any active → deactivate all"
          var innerNoneOn = inner.every(function(l) { return settings.innerLayerVisibility[l] === false; });
          var xrayNoneOn = !settings.showBackOnFront && !settings.showFrontOnBack;
          var noneOn = (inner.length === 0 || innerNoneOn) && xrayNoneOn;
          var newVal = noneOn; // true = activate all, false = deactivate all

          var cbBF = document.getElementById("cb-back-on-front");
          var cbFB = document.getElementById("cb-front-on-back");
          if (cbBF) { cbBF.checked = newVal; setShowBackOnFront(newVal); }
          if (cbFB) { cbFB.checked = newVal; setShowFrontOnBack(newVal); }
          inner.forEach(function(layerName) {
            setInnerLayerVisible(layerName, newVal);
            var container = document.getElementById("inner-layer-toggles");
            if (container) {
              container.querySelectorAll("input[type=checkbox]").forEach(function(cb, i) {
                if (i < inner.length) cb.checked = newVal;
              });
            }
          });
        }
        break;
      }

      // Inner layer number keys: 1-9 → LAY2-LAY10, 0 → LAY11
      case "1": case "2": case "3": case "4": case "5":
      case "6": case "7": case "8": case "9": case "0": {
        var n = e.key === "0" ? 10 : parseInt(e.key);
        var inner = getInnerLayers();
        var targetLayer = inner[n - 1];
        if (targetLayer) {
          var vis = settings.innerLayerVisibility[targetLayer] !== false;
          setInnerLayerVisible(targetLayer, !vis);
          var container = document.getElementById("inner-layer-toggles");
          if (container) {
            var cbs = container.querySelectorAll("input[type=checkbox]");
            if (cbs[n - 1]) cbs[n - 1].checked = !vis;
          }
        }
        break;
      }

      // Tabs
      case "C":
        switchTab("components");
        setTimeout(function() {
          var inp = document.getElementById("comp-search-input");
          if (inp) { inp.focus(); inp.select(); }
        }, 0);
        break;
      case "N":
        switchTab("nets");
        // Close net detail if open
        var detail = document.getElementById("net-detail-panel");
        if (detail && detail.style.display !== "none") netGoBack();
        setTimeout(function() {
          var inp = document.getElementById("net-search-input");
          if (inp) { inp.focus(); inp.select(); }
        }, 0);
        break;

      // Dark / light mode
      case "M": {
        var cb = document.getElementById("darkmodeCheckbox");
        if (cb) cb.checked = !settings.darkMode;
        toggleDarkMode();
        break;
      }

      // Shadow mode
      case "H": {
        var cb = document.getElementById("cb-shadow");
        if (cb) { var v = !settings.shadowMode; cb.checked = v; setShadowMode(v); }
        break;
      }

      // Zoom: fit board
      case "W":
        zoomAll(function(ld) { zoomFitBoard(ld); });
        break;

      // Zoom: fit visible highlights
      case "E":
        zoomFitSelected();
        break;

      // Zoom: into current/last highlight
      case "R":
        zoomIntoHighlight();
        break;

      // Arrow keys outside input: navigate lists
      case "ARROWDOWN": navigateList(getCurrentTab(), 1); break;
      case "ARROWUP":   navigateList(getCurrentTab(), -1); break;
      case "ENTER":     activateListSelection(getCurrentTab()); break;
    }
  });

  // Tab buttons
  document.getElementById("tab-components").addEventListener("click", function() { switchTab("components"); });
  document.getElementById("tab-nets").addEventListener("click", function() { switchTab("nets"); });
});


// ---- Test API ----
//
// Stable surface for automated tests. Everything above is internal and free to
// change; this object is the contract. Bump `version` on a breaking change.
//
// Values are plain JSON-safe data — Sets are converted to arrays — because
// Playwright serialises whatever page.evaluate() returns.
//
// This exists because the numbers it exposes were previously only reachable by
// scraping console.log output, which breaks whenever a format string changes.
// It reads state, it never writes it.

function _statsSummary(s) {
  if (!s || s.count === 0) return null;
  var n = s.count;
  var phases = {};
  for (var name in s.phases) {
    var arr = s.phases[name];
    if (!arr || arr.length === 0) continue;
    phases[name] = {
      p50: quantile(arr, n, 0.50),
      p90: quantile(arr, n, 0.90),
    };
  }
  return {
    // Sample count since load, not the ring size. The percentiles below are
    // over the last STATS_WINDOW samples only.
    count: n,
    windowSize: Math.min(n, STATS_WINDOW),
    // Wall-clock, so machine dependent. Trend material, not a CI gate.
    total: {
      p50: quantile(s.total, n, 0.50),
      p90: quantile(s.total, n, 0.90),
      p99: quantile(s.total, n, 0.99),
      min: arrMin(s.total, n),
      max: arrMax(s.total, n),
    },
    roundTrip: {
      p50: quantile(s.roundTrip, n, 0.50),
      p90: quantile(s.roundTrip, n, 0.90),
    },
    phases: phases,
    // Derived from elapsed > 100ms, so also wall-clock dependent.
    droppedFrames: s.droppedFrames,
  };
}

window.__pcbaTest = {
  version: 1,

  // True once the load handler has finished, the link in the URL has been
  // applied and the board is interactive.
  ready: function() { return initDone === true && _hashApplied; },

  // Load-phase milestones in ms. Keys appear as each phase completes, so poll
  // until the one you need is present rather than assuming it is there.
  timings: function() {
    return JSON.parse(JSON.stringify(_loadTimings));
  },

  // True when no render is in flight or scheduled. Wait for this between
  // scripted input steps so render counts do not depend on machine speed.
  idle: function() { return initDone === true && renderIdle(); },

  // Which canvas sides have recorded renders. Usually ["F"], ["B"] or both.
  sides: function() { return Object.keys(_stats); },

  // Render stats for one side, or null if that side has not rendered yet.
  renderStats: function(side) { return _statsSummary(_stats[side]); },

  // Counters that do not depend on machine speed. These are the ones worth
  // gating CI on; everything in renderStats() is wall-clock.
  counters: function() {
    var totalRenders = 0, drawCalls = 0, workerPosts = 0;
    for (var side in _stats) {
      totalRenders += _stats[side].count;
      drawCalls += _stats[side].drawCalls;
      workerPosts += _stats[side].posts;
    }
    return {
      renders: totalRenders,
      drawCalls: drawCalls,
      workerPosts: workerPosts,
      // Decompressed board JSON handed to JSON.parse. Null in split mode.
      pcbdataBytes: typeof pcbdataBytes === "number" ? pcbdataBytes : null,
      footprints: pcbdata && pcbdata.footprints ? pcbdata.footprints.length : 0,
      nets: Object.keys(netToComponents).length,
      innerLayers: getInnerLayers().length,
    };
  },

  // Selection, highlight and filter state, for interaction tests. The board is
  // drawn to canvas, so this is what to assert on instead of pixels.
  state: function() {
    return {
      selectedNet: selectedNet,
      selectedFootprintIdx: selectedFootprintIdx,
      highlightedNet: highlightedNet,
      highlightedFootprints: highlightedFootprints.slice(),
      hoverNets: hoverNets.slice(),
      highlightedNetPath: highlightedNetPath.slice(),
      netWalkHistory: JSON.parse(JSON.stringify(netWalkHistory)),
      compFilter: compFilter,
      netFilter: netFilter,
      netTypeFilter: netTypeFilter,
      netLayerFilter: netLayerFilter,
      canvasLayout: settings ? settings.canvaslayout : null,
      darkMode: settings ? settings.darkMode === true : null,
      innerLayerVisibility: settings
        ? JSON.parse(JSON.stringify(settings.innerLayerVisibility || {}))
        : {},
      innerLayers: getInnerLayers().slice(),
      showBackOnFront: settings ? settings.showBackOnFront : null,
      showFrontOnBack: settings ? settings.showFrontOnBack : null,
      renderSilkscreen: settings ? settings.renderSilkscreen : null,
      renderFabrication: settings ? settings.renderFabrication : null,
      // Pinned components and walked nets in selection order, with colours.
      selection: selectionRegistry.map(function(s) {
        return {
          type: s.type,
          value: s.type === "comp" ? pcbdata.footprints[s.value].ref : s.value,
          color: s.color,
        };
      }),
    };
  },

  // Visible area of a side in board units, or null when it is hidden.
  viewBox: function(side) {
    return getViewBox(side === "B" ? allcanvas.back : allcanvas.front);
  },

  // Settings as saved in browser storage, or null if nothing is saved.
  storedSettings: function() {
    var s = readStorage("settings");
    return s ? JSON.parse(s) : null;
  },

  // Layers a net touches. netToLayers holds Sets, which do not survive
  // serialisation, so convert.
  netLayers: function(netName) {
    var s = netToLayers[netName];
    return s ? Array.from(s) : [];
  },
};
