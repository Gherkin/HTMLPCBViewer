/* PCBA Bringup Viewer - Utilities
 *
 * Copyright (c) 2026 Gherkin
 * Copyright (c) 2018 qu1ck
 * SPDX-License-Identifier: MIT
 *
 * Derived in part from InteractiveHtmlBom (MIT), web/util.js:
 *   https://github.com/openscopeproject/InteractiveHtmlBom
 * See LICENSE and NOTICE for the full notice.
 */

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

// Copper layers in stack order: F, inner layers, B. Inner layer names come
// from the CAD tool (In2.Cu, LAY2), so numbers compare as numbers: In2 before
// In10. render-worker.js has its own copy.
function compareLayers(a, b) {
  function rank(l) { return l === "F" ? 0 : l === "B" ? 2 : 1; }
  return rank(a) - rank(b) || compareRefs(a, b);
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

// ---- URL hash state (#13) ----
//
// The hash is an ordered list of key=value pairs. Keys may repeat.
//
//   comp=REF        pinned component
//   net=NAME        walked net; comp and net entries keep selection order,
//                   which sets their colours
//   focus=comp:REF | net:NAME
//                   what the detail pane shows; default is the last entry,
//                   empty means nothing
//   side=F|B|FB
//   viewF=cx,cy,w,h viewB=cx,cy,w,h
//                   visible area per side, in board units
//   zoom=board|selected|highlight
//                   preset zoom (W, E, R), used when there is no view
//   layers=NAME     visible inner layer; "layers=" alone means none
//   xray=back-on-front | front-on-back; "xray=" alone means none
//   overlay=silk | fab; "overlay=" alone means none
//   netlayers=1     turn on every layer the linked nets touch
//   component=REF   old form, same as comp=REF
//
// The address bar holds the selection only. View and layers are added by the
// share menu. A hash longer than HASH_COMPRESS_AT is deflated into z=.

var HASH_COMPRESS_AT = 1500;

// Like encodeURIComponent, but keeps / : , @ readable. They are legal in a
// fragment and common in net names.
function encodeHashPart(s) {
  return encodeURIComponent(s).replace(/%(2F|3A|2C|40)/gi, decodeURIComponent);
}

function formatHashPairs(pairs) {
  return pairs.map(function(p) { return encodeHashPart(p[0]) + "=" + encodeHashPart(p[1]); }).join("&");
}

function parseHashPairs(str) {
  var pairs = [];
  str.split("&").forEach(function(part) {
    var i = part.indexOf("=");
    if (i < 0) return;
    try {
      pairs.push([decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))]);
    } catch (e) { /* malformed escape, skip the pair */ }
  });
  return pairs;
}

async function deflateToBase64Url(str) {
  var stream = new Blob([str]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  var bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function inflateFromBase64Url(b64) {
  var bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = Uint8Array.from(bin, function(c) { return c.charCodeAt(0); });
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

// Readable form, or z= when that is long and compressing makes it shorter.
async function encodeHash(pairs) {
  var s = formatHashPairs(pairs);
  if (s.length <= HASH_COMPRESS_AT || typeof CompressionStream === "undefined") return s;
  var z = "z=" + await deflateToBase64Url(s);
  return z.length < s.length ? z : s;
}

async function decodeHash(hash) {
  var pairs = parseHashPairs(hash);
  var z = pairs.find(function(p) { return p[0] === "z"; });
  if (!z) return pairs;
  if (typeof DecompressionStream === "undefined") {
    console.warn("[PCBAViewer] This browser cannot read compressed links");
    return [];
  }
  try {
    return parseHashPairs(await inflateFromBase64Url(z[1]));
  } catch (e) {
    console.warn("[PCBAViewer] Could not read compressed link: " + e);
    return [];
  }
}

// The readable form goes in at once. A compressed form replaces it when ready,
// unless a newer write came first.
var _hashWriteSeq = 0;

function writeHash(pairs) {
  var seq = ++_hashWriteSeq;
  var base = window.location.pathname + window.location.search;
  if (pairs.length === 0) {
    history.replaceState(null, "", base);
    return;
  }
  var s = formatHashPairs(pairs);
  history.replaceState(null, "", base + "#" + s);
  if (s.length > HASH_COMPRESS_AT) {
    encodeHash(pairs).then(function(h) {
      if (seq === _hashWriteSeq && h !== s) history.replaceState(null, "", base + "#" + h);
    });
  }
}

function selectionHashPairs() {
  var pairs = selectionRegistry.map(function(s) {
    return s.type === "comp" ? ["comp", pcbdata.footprints[s.value].ref] : ["net", s.value];
  });
  var focus = selectedFootprintIdx !== null ? "comp:" + pcbdata.footprints[selectedFootprintIdx].ref
            : selectedNet !== null ? "net:" + selectedNet
            : "";
  var last = pairs.length ? pairs[pairs.length - 1].join(":") : "";
  if (focus !== last) pairs.push(["focus", focus]);
  return pairs;
}

function updateHashFromSelection() {
  // While a link is being applied, leave it in the address bar as given.
  if (_applyingLink) return;
  writeHash(selectionHashPairs());
}
