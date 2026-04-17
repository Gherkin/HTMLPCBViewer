/* PCBA Bringup Viewer - Rendering Engine
 * Ported and adapted from InteractiveHtmlBom (MIT License)
 */

var emptyContext2d = document.createElement("canvas").getContext("2d");

// ---- Render scheduling ----
// Cancel-and-reschedule RAF on every event so the redraw always fires
// *after* the last event in a burst, not during it.
var _rafHandles = {};  // { 'F': rafId, 'B': rafId }

function scheduleRedraw(canvasdict) {
  var key = canvasdict.layer;
  if (_rafHandles[key]) cancelAnimationFrame(_rafHandles[key]);
  _rafHandles[key] = requestAnimationFrame(function() {
    delete _rafHandles[key];
    redrawCanvas(canvasdict);
  });
}

// Schedule a full redraw of all visible canvases, cancelling any pending one.
// Use this for state changes (hover, highlight) so rapid updates coalesce into
// a single frame rather than queueing up behind a slow 100ms redraw.
function scheduleRedrawAll() {
  scheduleRedraw(allcanvas.front);
  scheduleRedraw(allcanvas.back);
}

// Layer color palette — Solarized (https://ethanschoonover.com/solarized/)
// Extended for boards with > 8 inner layers using lighter Solarized-family variants.
var NET_WALK_PALETTE = ["#b58900","#2aa198","#d33682","#859900","#6c71c4","#cb4b16","#dc322f","#268bd2"];
var LAYER_COLORS = {
  // Outer layers — Solarized blue/red for unambiguous F/B distinction
  "F":           "#268bd2",  // Solarized blue   — front
  "B":           "#dc322f",  // Solarized red    — back
  // Inner layers — remaining 6 Solarized accents
  "ETCH/LAY2":   "#2aa198",  // Solarized cyan
  "ETCH/LAY3":   "#859900",  // Solarized green
  "ETCH/LAY4":   "#b58900",  // Solarized yellow
  "ETCH/LAY5":   "#cb4b16",  // Solarized orange
  "ETCH/LAY6":   "#d33682",  // Solarized magenta
  "ETCH/LAY7":   "#6c71c4",  // Solarized violet
  // Extended: lighter Solarized-family variants for boards with > 8 inner layers
  "ETCH/LAY8":   "#5aaee8",  // lighter blue
  "ETCH/LAY9":   "#4ec8be",  // lighter cyan
  "ETCH/LAY10":  "#a8c418",  // lighter green
  "ETCH/LAY11":  "#d4aa18",  // lighter yellow
};

var LAYER_COLORS_HIGHLIGHT = {
  "F":           "#4da8e8",  // bright blue
  "B":           "#e85555",  // bright red
  "ETCH/LAY2":   "#36c8be",  // bright cyan
  "ETCH/LAY3":   "#a0be00",  // bright green
  "ETCH/LAY4":   "#d4a800",  // bright yellow
  "ETCH/LAY5":   "#e06030",  // bright orange
  "ETCH/LAY6":   "#e04898",  // bright magenta
  "ETCH/LAY7":   "#8088d8",  // bright violet
};

function getLayerColor(layer) {
  return LAYER_COLORS[layer] || "#" + Math.floor(Math.abs(Math.sin(layer.length * 7919) * 0xffffff)).toString(16).padStart(6, "0");
}

function getLayerHighlightColor(layer) {
  return LAYER_COLORS_HIGHLIGHT[layer] || getLayerColor(layer);
}

function deg2rad(deg) {
  return deg * Math.PI / 180;
}

function calcFontPoint(linepoint, text, offsetx, offsety, tilt) {
  var point = [
    linepoint[0] * text.width + offsetx,
    linepoint[1] * text.height + offsety
  ];
  point[0] -= (linepoint[1] + 0.5 * (1 + text.justify[0])) * text.height * tilt;
  return point;
}

function drawText(ctx, text, color) {
  if ("ref" in text && !settings.renderReferences) return;
  if ("val" in text && !settings.renderValues) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if ("svgpath" in text) {
    if ("thickness" in text) {
      ctx.lineWidth = text.thickness;
      ctx.stroke(new Path2D(text.svgpath));
    } else if ("fillrule" in text) {
      ctx.fill(new Path2D(text.svgpath), text.fillrule);
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
  ctx.translate(...text.pos);
  ctx.translate(text.thickness * 0.5, 0);
  var angle = -text.angle;
  if (text.attr.includes("mirrored")) {
    ctx.scale(-1, 1);
    angle = -angle;
  }
  var tilt = 0;
  if (text.attr.includes("italic")) {
    tilt = 0.125;
  }
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
        if (txt[i][j] == '~') {
          j++;
          if (j == txt[i].length) break;
        }
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
        if (txt[i][j] != '~') {
          inOverbar = !inOverbar;
        }
      }
      var glyph = pcbdata.font_data[txt[i][j]];
      if (!glyph) { offsetx += pcbdata.font_data[' '].w * text.width; continue; }
      if (inOverbar) {
        var overbarStart = [offsetx, -text.height * 1.4 + offsety];
        var overbarEnd = [offsetx + text.width * glyph.w, overbarStart[1]];
        if (!lastHadOverbar) {
          overbarStart[0] += text.height * 1.4 * tilt;
          lastHadOverbar = true;
        }
        ctx.beginPath();
        ctx.moveTo(...overbarStart);
        ctx.lineTo(...overbarEnd);
        ctx.stroke();
      } else {
        lastHadOverbar = false;
      }
      for (var line of glyph.l) {
        ctx.beginPath();
        ctx.moveTo(...calcFontPoint(line[0], text, offsetx, offsety, tilt));
        for (var k = 1; k < line.length; k++) {
          ctx.lineTo(...calcFontPoint(line[k], text, offsetx, offsety, tilt));
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
    ctx.stroke(new Path2D(edge.svgpath));
  } else {
    ctx.beginPath();
    if (edge.type == "segment") {
      ctx.moveTo(...edge.start);
      ctx.lineTo(...edge.end);
    } else if (edge.type == "rect") {
      ctx.moveTo(...edge.start);
      ctx.lineTo(edge.start[0], edge.end[1]);
      ctx.lineTo(...edge.end);
      ctx.lineTo(edge.end[0], edge.start[1]);
      ctx.lineTo(...edge.start);
    } else if (edge.type == "arc") {
      ctx.arc(...edge.start, edge.radius, deg2rad(edge.startangle), deg2rad(edge.endangle));
    } else if (edge.type == "circle") {
      ctx.arc(...edge.start, edge.radius, 0, 2 * Math.PI);
      ctx.closePath();
    } else if (edge.type == "curve") {
      ctx.moveTo(...edge.start);
      ctx.bezierCurveTo(...edge.cpa, ...edge.cpb, ...edge.end);
    }
    if ("filled" in edge && edge.filled)
      ctx.fill();
    else
      ctx.stroke();
  }
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
      path.moveTo(...polygon[0]);
      for (var i = 1; i < polygon.length; i++) path.lineTo(...polygon[i]);
      path.closePath();
    }
    shape.path2d = path;
  }
  return shape.path2d;
}

function drawPolygonShape(ctx, scalefactor, shape, color) {
  ctx.save();
  if (!("svgpath" in shape)) {
    ctx.translate(...shape.pos);
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

function drawPad(ctx, pad, color, outline) {
  ctx.save();
  ctx.translate(...pad.pos);
  ctx.rotate(-deg2rad(pad.angle));
  if (pad.offset) ctx.translate(...pad.offset);
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
  ctx.translate(...pad.pos);
  ctx.rotate(-deg2rad(pad.angle));
  ctx.fillStyle = padHoleColor;
  if (pad.drillshape == "oblong") ctx.fill(getOblongPath(pad.drillsize));
  else if (pad.drillshape == "rect") ctx.fill(getChamferedRectPath(pad.drillsize, 0, 0, 0));
  else ctx.fill(getCirclePath(pad.drillsize[0] / 2));
  ctx.restore();
}

function drawFootprint(ctx, layer, scalefactor, footprint, padColor, padHoleColor, outlineColor, highlight, dnpOutline) {
  if (highlight) {
    if (footprint.layer == layer) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(...footprint.bbox.pos);
      ctx.rotate(deg2rad(-footprint.bbox.angle));
      ctx.translate(...footprint.bbox.relpos);
      ctx.fillStyle = padColor;
      ctx.fillRect(0, 0, ...footprint.bbox.size);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = padColor;
      ctx.lineWidth = 3 / scalefactor;
      ctx.strokeRect(0, 0, ...footprint.bbox.size);
      ctx.restore();
    }
  }
  for (var drawing of footprint.drawings) {
    if (drawing.layer == layer) {
      drawDrawing(ctx, scalefactor, drawing.drawing, padColor);
    }
  }
  ctx.lineWidth = 3 / scalefactor;
  if (settings.renderPads) {
    for (var pad of footprint.pads) {
      if (pad.layers.includes(layer)) {
        var color = dnpOutline ? "transparent" : padColor;
        drawPad(ctx, pad, padColor, dnpOutline);
        if (pad.pin1 && settings.highlightpin1) {
          drawPad(ctx, pad, outlineColor, true);
        }
      }
    }
    for (var pad of footprint.pads) {
      drawPadHole(ctx, pad, padHoleColor);
    }
  }
}

function drawEdgeCuts(ctx, scalefactor) {
  var edgecolor = getComputedStyle(topmostdiv).getPropertyValue('--pcb-edge-color');
  for (var edge of pcbdata.edges) {
    drawDrawing(ctx, scalefactor, edge, edgecolor);
  }
}

function drawBgLayer(layername, ctx, layer, scalefactor, edgeColor, polygonColor, textColor, noText) {
  if (!pcbdata.drawings[layername] || !pcbdata.drawings[layername][layer]) return;
  for (var d of pcbdata.drawings[layername][layer]) {
    if (["segment", "arc", "circle", "curve", "rect"].includes(d.type)) {
      drawedge(ctx, scalefactor, d, edgeColor);
    } else if (d.type == "polygon") {
      drawPolygonShape(ctx, scalefactor, d, polygonColor);
    } else if (!noText) {
      drawText(ctx, d, textColor);
    }
  }
}

// Via drill-size cache: keyed by "x,y", populated lazily
var _viaDrillSizeCache = null;
function getViaDrillSize(x, y) {
  if (!_viaDrillSizeCache) {
    _viaDrillSizeCache = {};
    if (pcbdata.tracks) {
      // Pass 1: explicit drillsize field (most accurate)
      for (var _l in pcbdata.tracks) {
        for (var _t of pcbdata.tracks[_l]) {
          if (!_t.start || _t.start[0] !== _t.end[0] || _t.start[1] !== _t.end[1]) continue;
          if ('drillsize' in _t && _t.drillsize > 0) {
            _viaDrillSizeCache[_t.start[0] + ',' + _t.start[1]] = _t.drillsize;
          }
        }
      }
      // Pass 2: infer from F or B layer pad width (always populated for all vias)
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
      // Pass 3: fall back to any inner layer with width > 0
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

function drawTracks(ctx, layer, color, highlight, highlightNet) {
  if (!pcbdata.tracks || !pcbdata.tracks[layer]) return;
  ctx.lineCap = "round";
  for (var track of pcbdata.tracks[layer]) {
    // Skip vias (zero-length segments) — handled separately by drawVias
    if (track.start && track.start[0] === track.end[0] && track.start[1] === track.end[1]) continue;
    if (highlight && track.net !== highlightNet) continue;
    ctx.strokeStyle = color;
    ctx.lineWidth = track.width;
    ctx.beginPath();
    if ('radius' in track) {
      ctx.arc(...track.center, track.radius, deg2rad(track.startangle), deg2rad(track.endangle));
    } else {
      ctx.moveTo(...track.start);
      ctx.lineTo(...track.end);
    }
    ctx.stroke();
  }
}

// drawVias: annular rings where connected (width > 0), drill holes on ALL vias.
function drawVias(ctx, layer, ringColor, holeColor, highlight, highlightNet) {
  if (!pcbdata.tracks || !pcbdata.tracks[layer]) return;
  ctx.lineCap = "round";
  // Pass 1: copper annular ring at full opacity — stands out from 0.6-alpha tracks/zones
  ctx.globalAlpha = 1.0;
  for (var track of pcbdata.tracks[layer]) {
    if (!track.start || track.start[0] !== track.end[0] || track.start[1] !== track.end[1]) continue;
    if (track.width <= 0) continue;
    if (highlight && track.net !== highlightNet) continue;
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = track.width;
    ctx.beginPath();
    ctx.moveTo(...track.start);
    ctx.lineTo(...track.end);
    ctx.stroke();
  }
  // Pass 2: drill holes on ALL vias regardless of connection or net filter
  for (var track of pcbdata.tracks[layer]) {
    if (!track.start || track.start[0] !== track.end[0] || track.start[1] !== track.end[1]) continue;
    ctx.strokeStyle = holeColor;
    ctx.lineWidth = getViaDrillSize(track.start[0], track.start[1]);
    ctx.beginPath();
    ctx.moveTo(...track.start);
    ctx.lineTo(...track.end);
    ctx.stroke();
  }
}

function drawZones(ctx, layer, color, highlight, highlightNet) {
  if (!pcbdata.zones || !pcbdata.zones[layer]) return;
  ctx.lineJoin = "round";
  for (var zone of pcbdata.zones[layer]) {
    if (highlight && zone.net !== highlightNet) continue;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (!zone.path2d) zone.path2d = getPolygonsPath(zone);
    ctx.fill(zone.path2d, zone.fillrule || "nonzero");
    if (zone.width > 0) {
      ctx.lineWidth = zone.width;
      ctx.stroke(zone.path2d);
    }
  }
}

function clearCanvas(canvas, color) {
  var ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

// ---- Per-layer canvas dict ----
// allcanvas.front / .back each contain: { layer, bg, silk, fab, highlight, transform, pointerStates, anotherPointerTapped }
// Inner layers go into allcanvas.inner[layername]

function prepareCanvas(canvas, flip, transform) {
  var ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(transform.zoom, transform.zoom);
  ctx.translate(transform.panx, transform.pany);
  if (flip) ctx.scale(-1, 1);
  ctx.translate(transform.x, transform.y);
  ctx.rotate(deg2rad(settings.boardRotation));
  ctx.scale(transform.s, transform.s);
}

function prepareLayer(canvasdict) {
  var flip = (canvasdict.layer === "B") || !!canvasdict.flip;
  for (var c of canvasdict.canvases) {
    prepareCanvas(c, flip, canvasdict.transform);
  }
}

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

function recalcLayerScale(layerdict, width, height) {
  var flip = (layerdict.layer === "B");
  var bbox = applyRotation(pcbdata.edges_bbox);
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
  for (var c of layerdict.canvases) {
    c.width = width;
    c.height = height;
    c.style.width = (width / devicePixelRatio) + "px";
    c.style.height = (height / devicePixelRatio) + "px";
  }
}

// Draw all nets (tracks + zones) on a single canvas for an inner layer
function drawInnerLayer(canvasdict, highlight) {
  var layer = canvasdict.layer;
  var ctx = canvasdict.canvases[0].getContext("2d");
  var style = getComputedStyle(topmostdiv);
  var holeColor = style.getPropertyValue('--pad-hole-color');
  var color = highlight
    ? getLayerHighlightColor(layer)
    : getLayerColor(layer);
  ctx.globalAlpha = highlight ? 1.0 : 0.6;
  if (settings.renderZones) drawZones(ctx, layer, color, highlight, highlightedNet);
  if (settings.renderTracks) drawTracks(ctx, layer, color, highlight, highlightedNet);
  // Vias drawn at full opacity: rings where connected stand out over 0.6-alpha zone fill;
  // drill holes punch through on every layer at a consistent neutral color.
  if (settings.renderTracks) {
    ctx.globalAlpha = 1.0;
    drawVias(ctx, layer, color, holeColor, highlight, highlightedNet);
  }
  ctx.globalAlpha = 1.0;
}

function drawBackground(canvasdict) {
  var layer = canvasdict.layer;
  var scalefactor = canvasdict.transform.s * canvasdict.transform.zoom;
  var style = getComputedStyle(topmostdiv);

  // bg canvas
  var bgCtx = canvasdict.bg.getContext("2d");

  // Board interior fill — drawn first, behind all copper
  var boardBgColor = style.getPropertyValue('--board-bg').trim();
  if (boardBgColor && pcbdata.edges_bbox) {
    var bb = pcbdata.edges_bbox;
    bgCtx.fillStyle = boardBgColor;
    bgCtx.fillRect(bb.minx, bb.miny, bb.maxx - bb.minx, bb.maxy - bb.miny);
  }

  var padHoleColor = style.getPropertyValue('--pad-hole-color');
  var outlineColor = style.getPropertyValue('--pin1-outline-color');

  // Tracks and zones (own layer only) — color derived from layer identity
  var layerColor = getLayerColor(layer);
  if (settings.renderZones) {
    bgCtx.globalAlpha = 0.6;
    drawZones(bgCtx, layer, layerColor, false, null);
    bgCtx.globalAlpha = 1.0;
  }
  if (settings.renderTracks) {
    bgCtx.globalAlpha = 0.6;
    drawTracks(bgCtx, layer, layerColor, false, null);
    bgCtx.globalAlpha = 1.0;
  }

  // Footprints at 75% alpha so pads read as distinct from tracks (0.6) but
  // still clearly lighter than via annular rings (1.0).
  if (settings.renderPads) {
    bgCtx.globalAlpha = 0.75;
    for (var i = 0; i < pcbdata.footprints.length; i++) {
      drawFootprint(bgCtx, layer, scalefactor, pcbdata.footprints[i], layerColor, padHoleColor, outlineColor, false, false);
    }
    bgCtx.globalAlpha = 1.0;
    // Overdraw all TH holes at 100% alpha — creates solid-dark holes so the
    // copper ring around each drill is visually distinct from the pad fill.
    for (var i = 0; i < pcbdata.footprints.length; i++) {
      for (var pad of pcbdata.footprints[i].pads) {
        drawPadHole(bgCtx, pad, padHoleColor);
      }
    }
  } else {
    // Pads disabled — still draw drawings/courtyard etc via drawFootprint
    for (var i = 0; i < pcbdata.footprints.length; i++) {
      drawFootprint(bgCtx, layer, scalefactor, pcbdata.footprints[i], layerColor, padHoleColor, outlineColor, false, false);
    }
  }

  // Vias drawn last so routing-via annular rings (100% alpha) sit on top of
  // any pad fills beneath them (via-in-pad), making rings clearly visible.
  if (settings.renderTracks) {
    drawVias(bgCtx, layer, layerColor, padHoleColor, false, null);
  }

  drawEdgeCuts(bgCtx, scalefactor);

  // Cross-layer (X-ray) copper overlay
  var xLayer = layer === "F" ? "B" : "F";
  var showCross = layer === "F" ? settings.showBackOnFront : settings.showFrontOnBack;
  if (showCross) {
    bgCtx.save();
    bgCtx.globalAlpha = 0.28;
    var xColor = getLayerColor(xLayer);
    if (settings.renderZones) drawZones(bgCtx, xLayer, xColor, false, null);
    if (settings.renderTracks) drawTracks(bgCtx, xLayer, xColor, false, null);
    for (var _xfp of pcbdata.footprints) {
      drawFootprint(bgCtx, xLayer, scalefactor, _xfp, xColor, padHoleColor, outlineColor, false, false);
    }
    bgCtx.restore();
  }

  // Silkscreen
  if (settings.renderSilkscreen) {
    var silkCtx = canvasdict.silk.getContext("2d");
    var edgeColor = style.getPropertyValue('--silkscreen-edge-color');
    var polyColor = style.getPropertyValue('--silkscreen-polygon-color');
    var textColor = style.getPropertyValue('--silkscreen-text-color');
    drawBgLayer("silkscreen", silkCtx, layer, scalefactor, edgeColor, polyColor, textColor);
  }

  // Fabrication
  if (settings.renderFabrication) {
    var fabCtx = canvasdict.fab.getContext("2d");
    var fabEdgeColor = style.getPropertyValue('--fabrication-edge-color');
    var fabPolyColor = style.getPropertyValue('--fabrication-polygon-color');
    var fabTextColor = style.getPropertyValue('--fabrication-text-color');
    drawBgLayer("fabrication", fabCtx, layer, scalefactor, fabEdgeColor, fabPolyColor, fabTextColor, true);
  }
}

function drawHighlightsOnLayer(canvasdict) {
  var layer = canvasdict.layer;
  var scalefactor = canvasdict.transform.s * canvasdict.transform.zoom;
  var style = getComputedStyle(topmostdiv);
  var hlCtx = canvasdict.highlight.getContext("2d");
  var padHoleColor = style.getPropertyValue('--pad-hole-color');

  // Whether the cross (xray) layer is visible on this canvas
  var xLayer = layer === "F" ? "B" : "F";
  var showCross = layer === "F" ? settings.showBackOnFront : settings.showFrontOnBack;
  // Color to use for cross-layer highlights: the native render color of that layer, full opacity
  var xLayerColor = showCross ? getLayerColor(xLayer) : null;

  // Helper: draw a cross-layer highlight for a footprint using the xray layer color.
  // Only draws pads (no bbox rectangle) so it reads clearly as "other side".
  function drawXrayHighlight(fp) {
    if (!showCross || fp.layer !== xLayer || !settings.renderPads) return;
    hlCtx.save();
    hlCtx.globalAlpha = 1.0;
    for (var pad of fp.pads) {
      if (pad.layers.includes(xLayer)) {
        drawPad(hlCtx, pad, xLayerColor, false);
      }
    }
    for (var pad of fp.pads) drawPadHole(hlCtx, pad, padHoleColor);
    hlCtx.restore();
  }

  // Pinned components (multi-color)
  if (typeof pinnedComponents !== 'undefined') {
    for (var pidx in pinnedComponents) {
      var pfp = pcbdata.footprints[parseInt(pidx)];
      if (!pfp) continue;
      var pc = pinnedComponents[pidx];
      drawFootprint(hlCtx, layer, scalefactor, pfp, pc, padHoleColor, pc, true, false);
      drawXrayHighlight(pfp);
    }
  }

  // Highlighted footprints (hover) — use peekSelectionColor so pinned items stay their pin color
  if (highlightedFootprints.length > 0) {
    var outlineColor = style.getPropertyValue('--pin1-outline-color');
    for (var idx of highlightedFootprints) {
      var fp = pcbdata.footprints[idx];
      if (!fp) continue;
      var hoverColor = (typeof peekSelectionColor === 'function')
        ? peekSelectionColor('comp', idx)
        : getLayerHighlightColor(layer);
      drawFootprint(hlCtx, layer, scalefactor, fp, hoverColor, padHoleColor, outlineColor, true, false);
      drawXrayHighlight(fp);
    }
  }

  // Highlighted net — pads
  if (highlightedNet !== null && settings.renderPads) {
    var netPadColor = (typeof peekSelectionColor === 'function')
      ? peekSelectionColor('net', highlightedNet)
      : getLayerHighlightColor(layer);
    for (var fp of pcbdata.footprints) {
      var padDrawn = false;
      // Own-layer pads
      for (var pad of fp.pads) {
        if (pad.net !== highlightedNet) continue;
        if (pad.layers.includes(layer)) {
          drawPad(hlCtx, pad, netPadColor, false);
          padDrawn = true;
        }
      }
      if (padDrawn) {
        for (var pad of fp.pads) drawPadHole(hlCtx, pad, padHoleColor);
      }
      // Cross-layer pads for this net
      if (showCross && fp.layer === xLayer) {
        var xPadDrawn = false;
        hlCtx.save();
        hlCtx.globalAlpha = 1.0;
        for (var pad of fp.pads) {
          if (pad.net !== highlightedNet) continue;
          if (pad.layers.includes(xLayer)) {
            drawPad(hlCtx, pad, xLayerColor, false);
            xPadDrawn = true;
          }
        }
        if (xPadDrawn) {
          for (var pad of fp.pads) drawPadHole(hlCtx, pad, padHoleColor);
        }
        hlCtx.restore();
      }
    }
  }

  // Highlighted net — tracks & zones on this layer
  if (highlightedNet !== null) {
    var hlColor = (typeof peekSelectionColor === 'function')
      ? peekSelectionColor('net', highlightedNet)
      : getLayerHighlightColor(layer);
    var hlHoleColor = style.getPropertyValue('--pad-hole-color');
    if (settings.renderZones) drawZones(hlCtx, layer, hlColor + "66", true, highlightedNet);
    if (settings.renderTracks) drawTracks(hlCtx, layer, hlColor, true, highlightedNet);
    if (settings.renderTracks) drawVias(hlCtx, layer, hlColor, hlHoleColor, true, highlightedNet);
  }

  // Multi-net path highlights (for net walking)
  if (highlightedNetPath && highlightedNetPath.length > 0) {
    var palette = NET_WALK_PALETTE;
    highlightedNetPath.forEach(function(netName, colorIdx) {
      // Use the unified selection registry color so canvas matches UI swatches
      var color = (typeof getSelectionColor === 'function' && getSelectionColor('net', netName))
                  || palette[colorIdx % palette.length];
      var alphaColor = color + "bb";
      var pathHoleColor = style.getPropertyValue('--pad-hole-color');
      if (settings.renderZones) drawZones(hlCtx, layer, alphaColor, true, netName);
      if (settings.renderTracks) drawTracks(hlCtx, layer, alphaColor, true, netName);
      if (settings.renderTracks) drawVias(hlCtx, layer, color, pathHoleColor, true, netName);
      if (settings.renderPads) {
        for (var fp of pcbdata.footprints) {
          for (var pad of fp.pads) {
            if (pad.net !== netName) continue;
            if (pad.layers.includes(layer)) drawPad(hlCtx, pad, color, false);
          }
        }
        // Cross-layer pads for this net
        if (showCross) {
          hlCtx.save();
          hlCtx.globalAlpha = 1.0;
          for (var fp of pcbdata.footprints) {
            if (fp.layer !== xLayer) continue;
            for (var pad of fp.pads) {
              if (pad.net !== netName) continue;
              if (pad.layers.includes(xLayer)) drawPad(hlCtx, pad, xLayerColor, false);
            }
          }
          hlCtx.restore();
        }
      }
    });
  }
}

function applyShadowFilter(canvasdict) {
  var active = settings.shadowMode &&
    (highlightedFootprints.length > 0 || highlightedNet !== null ||
     (highlightedNetPath && highlightedNetPath.length > 0) ||
     (typeof pinnedComponents !== 'undefined' && Object.keys(pinnedComponents).length > 0));
  var filter = active
    ? "brightness(" + settings.shadowBrightness + "%) saturate(" + settings.shadowSaturation + "%)"
    : "";
  // Apply to bg, silk, fab and all inner layer canvases
  for (var c of [canvasdict.bg, canvasdict.silk, canvasdict.fab]) {
    if (c) c.style.filter = filter;
  }
  var innerDict2 = canvasdict === allcanvas.front ? allcanvas.inner : (canvasdict === allcanvas.back ? allcanvas.innerBack : null);
  if (innerDict2) {
    for (var ln in innerDict2) {
      for (var ic of innerDict2[ln].canvases) ic.style.filter = filter;
    }
  }
}

function redrawCanvas(canvasdict) {
  // Skip if canvas has zero dimensions (e.g. hidden by layout setting)
  if (!canvasdict.bg || canvasdict.bg.width === 0 || canvasdict.bg.height === 0) return;
  // Clear all canvases
  clearCanvas(canvasdict.bg);
  clearCanvas(canvasdict.silk);
  clearCanvas(canvasdict.fab);
  clearCanvas(canvasdict.highlight);
  prepareLayer(canvasdict);
  drawBackground(canvasdict);
  drawHighlightsOnLayer(canvasdict);
  applyShadowFilter(canvasdict);
  // Inner layers — redraw front-side when front redraws, back-side when back redraws
  if (canvasdict === allcanvas.front && allcanvas.inner) {
    for (var _ln in allcanvas.inner) {
      if (settings.innerLayerVisibility[_ln] !== false) {
        redrawInnerLayer(allcanvas.inner[_ln]);
      }
    }
  }
  if (canvasdict === allcanvas.back && allcanvas.innerBack) {
    for (var _ln in allcanvas.innerBack) {
      if (settings.innerLayerVisibility[_ln] !== false) {
        redrawInnerLayer(allcanvas.innerBack[_ln]);
      }
    }
  }
}

function redrawInnerLayer(canvasdict) {
  clearCanvas(canvasdict.canvases[0]);
  prepareLayer(canvasdict);
  if (settings.renderTracks || settings.renderZones) {
    drawInnerLayer(canvasdict, false);
  }
  // If this inner layer has a highlighted net, draw on highlight canvas too
  if (canvasdict.canvases.length > 1) {
    clearCanvas(canvasdict.canvases[1]);
    if (highlightedNet !== null || (highlightedNetPath && highlightedNetPath.length > 0)) {
      drawInnerLayer(canvasdict, true);  // redraw will overlay the highlight
    }
  }
}

function redrawAll() {
  redrawCanvas(allcanvas.front);  // also redraws inner layers
  redrawCanvas(allcanvas.back);
}

function resizeFrontBack(canvasdict, skipRedraw) {
  var divId = canvasdict.layer === "F" ? "frontcanvas" : "backcanvas";
  var div = document.getElementById(divId);
  if (!div) return;
  var width = div.clientWidth * devicePixelRatio;
  var height = div.clientHeight * devicePixelRatio;
  recalcLayerScale(canvasdict, width, height);
  // Resize inner layer canvases to match their respective side
  var innerDict = canvasdict.layer === "F" ? allcanvas.inner : allcanvas.innerBack;
  if (innerDict) {
    for (var ln in innerDict) {
      for (var c of innerDict[ln].canvases) {
        c.width = width;
        c.height = height;
        c.style.width = (width / devicePixelRatio) + "px";
        c.style.height = (height / devicePixelRatio) + "px";
      }
    }
  }
  if (!skipRedraw) redrawCanvas(canvasdict);
}

function resizeAll(skipRedraw) {
  resizeFrontBack(allcanvas.front, skipRedraw);
  resizeFrontBack(allcanvas.back, skipRedraw);
}

// ---- Hit-testing ----

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

function netHitScan(layer, x, y) {
  if (settings.renderTracks && pcbdata.tracks && pcbdata.tracks[layer]) {
    for (var track of pcbdata.tracks[layer]) {
      if ('radius' in track) {
        if (pointWithinDistanceToArc(x, y, ...track.center, track.radius, track.startangle, track.endangle, track.width / 2))
          return track.net;
      } else {
        if (pointWithinDistanceToSegment(x, y, ...track.start, ...track.end, track.width / 2))
          return track.net;
      }
    }
  }
  if (settings.renderPads) {
    for (var fp of pcbdata.footprints) {
      for (var pad of fp.pads) {
        if (pad.layers.includes(layer) && pointWithinPad(x, y, pad))
          return pad.net;
      }
    }
  }
  return null;
}

// Returns {fpIdx, padLabel, net} for the first pad hit, or null.
function padHitScan(layer, x, y) {
  if (!settings.renderPads) return null;
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

// Returns the net name of the first zone polygon hit, or null.
function zoneHitScan(layer, x, y) {
  if (!settings.renderZones || !pcbdata.zones || !pcbdata.zones[layer]) return null;
  for (var zone of pcbdata.zones[layer]) {
    if (!zone.path2d) zone.path2d = getPolygonsPath(zone);
    if (emptyContext2d.isPointInPath(zone.path2d, x, y, zone.fillrule || "nonzero")) return zone.net;
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
  var net = netHitScan(layerdict.layer, ...v);
  if (net !== null && net !== "") {
    onNetClickedFromCanvas(net);
    return;
  }
  var footprints = bboxHitScan(layerdict.layer, ...v);
  if (footprints.length > 0) {
    onFootprintClickedFromCanvas(footprints[0]);
    return;
  }
  var zoneNet = zoneHitScan(layerdict.layer, ...v);
  if (zoneNet !== null && zoneNet !== "") {
    onNetClickedFromCanvas(zoneNet);
  }
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
    if (!settings.redrawOnDrag) redrawCanvas(layerdict);
    layerdict.anotherPointerTapped = false;
  }
  delete layerdict.pointerStates[e.pointerId];
}

function handlePointerLeave(e, layerdict) {
  e.preventDefault(); e.stopPropagation();
  if (!settings.redrawOnDrag) redrawCanvas(layerdict);
  delete layerdict.pointerStates[e.pointerId];
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
  if (settings.redrawOnDrag) scheduleRedraw(layerdict);
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
  // RAF-throttle wheel zoom redraws
  scheduleRedraw(layerdict);
}

function handleMouseMove(e, layerdict) {
  // Tooltip on hover
  if (!e.hasOwnProperty("offsetX")) { e.offsetX = e.pageX - e.currentTarget.offsetLeft; e.offsetY = e.pageY - e.currentTarget.offsetTop; }
  var v = canvasToBoard(e, layerdict);
  var tooltip = document.getElementById("canvas-tooltip");
  if (!tooltip) return;
  // Position relative to #canvas-area so it works in Both view
  var areaRect = document.getElementById("canvas-area").getBoundingClientRect();
  var tipX = e.clientX - areaRect.left + 14;
  var tipY = e.clientY - areaRect.top + 14;

  // Priority: pad > track/net > footprint bbox > zone
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

  var net = netHitScan(layerdict.layer, ...v);
  if (net !== null) {
    tooltip.textContent = "Net: " + net;
    tooltip.style.display = "block";
    tooltip.style.left = tipX + "px";
    tooltip.style.top = tipY + "px";
    return;
  }

  var fps = bboxHitScan(layerdict.layer, ...v);
  if (fps.length > 0) {
    var fp = pcbdata.footprints[fps[0]];
    var comp = pcbdata.components[fps[0]];
    tooltip.textContent = fp.ref + (comp ? " \u2014 " + comp.val : "");
    tooltip.style.display = "block";
    tooltip.style.left = tipX + "px";
    tooltip.style.top = tipY + "px";
    return;
  }

  var zoneNet = zoneHitScan(layerdict.layer, ...v);
  if (zoneNet !== null) {
    tooltip.textContent = "Zone: " + zoneNet;
    tooltip.style.display = "block";
    tooltip.style.left = tipX + "px";
    tooltip.style.top = tipY + "px";
    return;
  }

  tooltip.style.display = "none";
}

function resetTransform(layerdict) {
  layerdict.transform.panx = 0;
  layerdict.transform.pany = 0;
  layerdict.transform.zoom = 1;
  redrawCanvas(layerdict);
}

// Zoom to fit the full board in the given canvas
function zoomFitBoard(layerdict) {
  resetTransform(layerdict);
}

// Zoom to fit a set of board-coordinate points in the given canvas.
// points: array of [x, y]. Returns false if nothing to zoom to.
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

  var margin = 8; // board units
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
  redrawCanvas(layerdict);
  return true;
}

function addCanvasHandlers(div, layerdict) {
  div.addEventListener("pointerdown", (e) => handlePointerDown(e, layerdict));
  div.addEventListener("pointermove", (e) => {
    handlePointerMove(e, layerdict);
    handleMouseMove(e, layerdict);
  });
  div.addEventListener("pointerup", (e) => handlePointerUp(e, layerdict));
  div.addEventListener("pointerleave", (e) => handlePointerLeave(e, layerdict));
  div.addEventListener("wheel", (e) => handleMouseWheel(e, layerdict), { passive: false });
  div.addEventListener("contextmenu", (e) => e.preventDefault());
}

// Zoom the viewport to center on a component bounding box
function zoomToFootprint(fpIdx, layerdict) {
  var fp = pcbdata.footprints[fpIdx];
  if (!fp) return;
  var bbox = fp.bbox;
  // bbox.pos, bbox.relpos, bbox.size, bbox.angle
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

  // Desired zoom: board coords of component bbox → fill ~30% of canvas
  var margin = 8; // board units margin around component
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
  redrawCanvas(layerdict);
}

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
    };
  }
  allcanvas = {
    front: makeLayerDict("F", "F_bg", "F_silk", "F_fab", "F_hl"),
    back:  makeLayerDict("B", "B_bg", "B_silk", "B_fab", "B_hl"),
    inner: {},
    innerBack: {},
  };

  // Build inner layer dicts — canvases appended to both front and back stacks
  var innerLayers = getInnerLayers();
  var frontStack = document.getElementById("frontcanvas");
  var backStack = document.getElementById("backcanvas");
  innerLayers.forEach(function(layerName) {
    var safe = layerName.replace(/\//g, "_").replace(/\s/g, "_");

    // Front-side inner canvases
    var bgF = document.createElement("canvas");
    bgF.id = "IL_" + safe + "_bg";
    bgF.classList.add("inner-canvas", "inner-bg");
    var hlF = document.createElement("canvas");
    hlF.id = "IL_" + safe + "_hl";
    hlF.classList.add("inner-canvas", "inner-hl");
    if (frontStack) { frontStack.appendChild(bgF); frontStack.appendChild(hlF); }
    allcanvas.inner[layerName] = {
      layer: layerName,
      canvases: [bgF, hlF],
      get transform() { return allcanvas.front.transform; },
      get bg() { return this.canvases[0]; },
      get highlight() { return this.canvases[1]; },
    };

    // Back-side inner canvases
    var bgB = document.createElement("canvas");
    bgB.id = "ILB_" + safe + "_bg";
    bgB.classList.add("inner-canvas", "inner-bg");
    var hlB = document.createElement("canvas");
    hlB.id = "ILB_" + safe + "_hl";
    hlB.classList.add("inner-canvas", "inner-hl");
    if (backStack) { backStack.appendChild(bgB); backStack.appendChild(hlB); }
    allcanvas.innerBack[layerName] = {
      layer: layerName,
      flip: true,
      canvases: [bgB, hlB],
      get transform() { return allcanvas.back.transform; },
      get bg() { return this.canvases[0]; },
      get highlight() { return this.canvases[1]; },
    };
  });

  // Attach handlers to front/back canvas divs
  addCanvasHandlers(document.getElementById("frontcanvas"), allcanvas.front);
  addCanvasHandlers(document.getElementById("backcanvas"), allcanvas.back);
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
  layers.sort();
  return layers;
}
