/* PCBA Bringup Viewer - Application Logic */

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
    renderFabrication: false,
    showBackOnFront: false,
    showFrontOnBack: false,
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

function saveSettings() {
  writeStorage("settings", JSON.stringify(settings));
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
  var safe = layerName.replace(/\//g, "_").replace(/\s/g, "_");
  ["IL_", "ILB_"].forEach(function(prefix) {
    var bgEl = document.getElementById(prefix + safe + "_bg");
    var hlEl = document.getElementById(prefix + safe + "_hl");
    if (bgEl) bgEl.style.display = val ? "block" : "none";
    if (hlEl) hlEl.style.display = val ? "block" : "none";
  });
  saveSettings();
  if (val && initDone) {
    if (allcanvas.inner[layerName]) redrawInnerLayer(allcanvas.inner[layerName]);
    if (allcanvas.innerBack && allcanvas.innerBack[layerName]) redrawInnerLayer(allcanvas.innerBack[layerName]);
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
      _hoverPrev = null; // discard stash so click's own highlight persists
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

var _hoverPrev = null; // stashed {footprints, net} before hover

function hoverFootprint(fpIdx) {
  if (_hoverPrev === null) {
    _hoverPrev = { footprints: highlightedFootprints.slice(), net: highlightedNet };
  }
  highlightedFootprints = [fpIdx];
  highlightedNet = null;
  scheduleRedrawAll();
}

function hoverNet(netName) {
  if (_hoverPrev === null) {
    _hoverPrev = { footprints: highlightedFootprints.slice(), net: highlightedNet };
  }
  highlightedNet = netName;
  highlightedFootprints = [];
  scheduleRedrawAll();
}

// Highlight a net AND a footprint simultaneously (e.g. hovering a net in component detail)
function hoverNetWithFootprint(netName, fpIdx) {
  if (_hoverPrev === null) {
    _hoverPrev = { footprints: highlightedFootprints.slice(), net: highlightedNet, netPath: highlightedNetPath.slice() };
  }
  highlightedNet = netName;
  highlightedFootprints = [fpIdx];
  highlightedNetPath = [];
  scheduleRedrawAll();
}

// Highlight two nets simultaneously + a footprint (e.g. hovering a walk-link while a net is selected)
function hoverTwoNetsWithFootprint(selectedNet, otherNet, fpIdx) {
  if (_hoverPrev === null) {
    _hoverPrev = { footprints: highlightedFootprints.slice(), net: highlightedNet, netPath: highlightedNetPath.slice() };
  }
  highlightedNet = null;
  highlightedFootprints = [fpIdx];
  highlightedNetPath = [selectedNet, otherNet];
  scheduleRedrawAll();
}

function hoverClear() {
  if (_hoverPrev === null) return;
  highlightedFootprints = _hoverPrev.footprints;
  highlightedNet = _hoverPrev.net;
  highlightedNetPath = _hoverPrev.netPath || [];
  _hoverPrev = null;
  scheduleRedrawAll();
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
      _hoverPrev = null; // discard stash so click's own highlight persists
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
  highlightedNetPath = [];

  // Push to walk history if not already the last entry
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
      _hoverPrev = null;
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
    row.addEventListener("mouseenter", (function(idx, n) {
      return function() { hoverNetWithFootprint(n, idx); };
    })(fpIdx, netName));
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
          _hoverPrev = null;
          pushWalkStep({ type: "comp", value: fpIdx });
          addBreadcrumb(fp.ref + " [" + fp.layer + "]", function() { selectFootprint(fpIdx, false); });
          selectNet(otherNet);
          document.getElementById("net-search-input").value = otherNet;
        });
        link.addEventListener("mouseenter", (function(selNet, otNet, idx) {
          return function() { hoverTwoNetsWithFootprint(selNet, otNet, idx); };
        })(netName, otherNet, fpIdx));
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
          _hoverPrev = null;
          pushWalkStep({ type: "comp", value: fpIdx });
          addBreadcrumb(fp.ref + " [" + fp.layer + "]", function() { selectFootprint(fpIdx, false); });
          selectNet(otherNet);
          document.getElementById("net-search-input").value = otherNet;
        });
        link.addEventListener("mouseenter", (function(selNet, otNet, idx) {
          return function() { hoverTwoNetsWithFootprint(selNet, otNet, idx); };
        })(netName, otherNet, fpIdx));
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
          return function() { navigateToNet(n); };
        })(pad.net));
        btn.addEventListener("mouseenter", (function(n, idx) {
          return function() { hoverNetWithFootprint(n, idx); };
        })(pad.net, fpIdx));
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
  redrawAllIfDone();
}

function deselect() {
  selectedFootprintIdx = null;
  selectedNet = null;
  highlightedFootprints = [];
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
    var defaultVisible = settings.innerLayerVisibility[layerName] !== false;
    if (settings.innerLayerVisibility[layerName] === undefined) {
      settings.innerLayerVisibility[layerName] = true;
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

// ---- Resize handling ----

window.addEventListener("resize", function() {
  if (initDone) resizeAll();
});

// ---- Init ----

window.addEventListener("load", async function() {
  var _tLoad = performance.now();
  await pcbdataReady;
  var _tReady = performance.now();
  console.log("[PCBAViewer] pcbdata ready + load event: " + _tReady.toFixed(0) + " ms (waited " + (_tReady - _tLoad).toFixed(0) + "ms in load handler)");
  initStorage();
  loadSettings();
  buildIndexes();
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
    console.log(
      "[PCBAViewer] redrawAll: " + (t1 - t0).toFixed(0) + " ms" +
      " | RAF1 (overlay hidden): " + t2.toFixed(0) + " ms since page load"
    );
    // RAF 2: fires AFTER the browser has actually painted the overlay-hidden frame
    requestAnimationFrame(function() {
      var t3 = performance.now();
      console.log("[PCBAViewer] RAF2 (board visible on screen): " + t3.toFixed(0) + " ms since page load");
      var _tPop = performance.now();
      populateComponentList();
      populateNetSearchList();
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

  // Apply URL hash state
  applyHashState();

  // Net search input
  var netInput = document.getElementById("net-search-input");
  netInput.addEventListener("input", function() { updateNetFilter(this.value); });

  // Component search input
  document.getElementById("comp-search-input").addEventListener("input", function() {
    updateCompFilter(this.value);
  });

  // Keyboard nav in component list
  document.getElementById("comp-search-input").addEventListener("keydown", function(e) {
    if (e.key === "Escape") { this.value = ""; updateCompFilter(""); }
  });

  // Global Escape key — deselect everything
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") deselect();
  });

  // Tab buttons
  document.getElementById("tab-components").addEventListener("click", function() { switchTab("components"); });
  document.getElementById("tab-nets").addEventListener("click", function() { switchTab("nets"); });
});
