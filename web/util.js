/* PCBA Bringup Viewer - Utilities */

var storagePrefix = 'PcbaBringupViewer__';  // finalized in initStorage()
var storage;

function initStorage() {
  var m = pcbdata.metadata;
  storagePrefix = 'PcbaBringupViewer__' + (m ? m.title + '__' + m.revision : 'default') + '__';
  try { window.localStorage.getItem("_"); storage = window.localStorage; } catch(e) {}
  if (!storage) {
    try { window.sessionStorage.getItem("_"); storage = window.sessionStorage; } catch(e) {}
  }
}

function readStorage(key) {
  return storage ? storage.getItem(storagePrefix + key) : null;
}

function writeStorage(key, value) {
  if (storage) storage.setItem(storagePrefix + key, value);
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;opacity:0;";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch(e) { /* ignore */ }
  document.body.removeChild(ta);
}

function flashElement(el) {
  el.classList.add("flash-success");
  setTimeout(() => el.classList.remove("flash-success"), 600);
}

function naturalSortKey(s) {
  return s.replace(/(\d+)/g, (m, n) => n.padStart(12, '0'));
}

function compareRefs(a, b) {
  return naturalSortKey(a).localeCompare(naturalSortKey(b));
}

// Extract component type prefix (e.g. "TP" from "TP2042", "RSVD_TP_1" → "RSVD")
function getRefPrefix(ref) {
  var m = ref.match(/^([A-Z_]+)/i);
  return m ? m[1].toUpperCase() : ref;
}

// Standard known prefixes — order matters for the type filter buttons
var KNOWN_PREFIXES = ["TP", "R", "C", "L", "U", "Q", "Y", "J", "D", "F", "FB", "BT", "SW", "TR", "K"];

// Get the primary bucket for a ref (TP takes priority in prefix matching)
function getRefType(ref) {
  var upper = ref.toUpperCase();
  for (var p of KNOWN_PREFIXES) {
    if (upper.startsWith(p)) return p;
  }
  return "OTHER";
}

// ---- URL hash state ----

function getHashState() {
  var hash = window.location.hash.slice(1);
  var state = {};
  hash.split("&").forEach(function(part) {
    var kv = part.split("=");
    if (kv.length == 2) state[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
  });
  return state;
}

function setHashState(state) {
  var parts = Object.entries(state).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v));
  history.replaceState(null, "", "#" + parts.join("&"));
}

function updateHashFromSelection() {
  if (selectedFootprintIdx !== null) {
    setHashState({ component: pcbdata.footprints[selectedFootprintIdx].ref });
  } else if (selectedNet !== null) {
    setHashState({ net: selectedNet });
  } else {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function applyHashState() {
  var state = getHashState();
  if (state.component) {
    var idx = componentByRef[state.component.toUpperCase()];
    if (idx !== undefined) {
      selectFootprint(idx, true);
      document.getElementById("tab-components").click();
    }
  } else if (state.net) {
    selectNet(state.net);
    document.getElementById("tab-nets").click();
  }
}
