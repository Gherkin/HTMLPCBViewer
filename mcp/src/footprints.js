// Footprint geometry from the board payload. Every tool that talks about
// where a part is, or whether a point is under a part, goes through here, so
// they all mean the same rectangle.
//
// A footprint's bbox is a rectangle in the footprint's own frame:
//   pos     footprint origin in board coordinates
//   relpos  corner of the rectangle, relative to pos, before rotation
//   size    width and height, before rotation
//   angle   rotation in degrees
// A point p in the footprint frame sits at pos + rotate(p, -angle) on the
// board. This is the inverse of what the viewer's pointWithinFootprintBbox
// does (web/render.js), so a click and a tool agree on what is "on" a part.
//
// What the rectangle covers depends on the exporter:
//   KiCad (ibom): FOOTPRINT::GetBoundingBox without text, so the outer
//     extent of all pads and graphic shapes on every layer (copper, silk,
//     fab, courtyard if the footprint has one).
//   Allegro (allegro-skills/exportJson.il): the PLACE_BOUND_TOP/BOTTOM
//     shapes (the place boundary, Allegro's courtyard), both sides merged;
//     if the symbol has none, the extents of the whole symbol.
// Units are the board units of the export: mm for KiCad. The Allegro export
// does no unit conversion, so it is in the design's own units. y grows
// downward, and back-side parts use the same coordinates (seen from the top).

function rotate([x, y], deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

// Rounds away float noise such as 165.00000000000003. 1e-6 is 1 nm in mm.
function round(v) {
  return Math.round(v * 1e6) / 1e6;
}

// Board position of a footprint: side, center, size and angle of its bbox,
// and the axis-aligned extent of the rotated rectangle on the board.
export function footprintPlace(fp) {
  const { pos, relpos, size, angle } = fp.bbox;
  const toBoard = (p) => {
    const r = rotate(p, -angle);
    return [pos[0] + r[0], pos[1] + r[1]];
  };
  const center = toBoard([relpos[0] + size[0] / 2, relpos[1] + size[1] / 2]);
  const corners = [
    [relpos[0], relpos[1]],
    [relpos[0] + size[0], relpos[1]],
    [relpos[0], relpos[1] + size[1]],
    [relpos[0] + size[0], relpos[1] + size[1]],
  ].map(toBoard);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    ref: fp.ref,
    side: fp.layer,
    center: center.map(round),
    size: size.map(round),
    angle: fp.bbox.angle,
    extent: {
      minx: round(Math.min(...xs)),
      miny: round(Math.min(...ys)),
      maxx: round(Math.max(...xs)),
      maxy: round(Math.max(...ys)),
    },
  };
}

// True when board point (x, y) is inside the footprint's bbox rectangle,
// edges included. Same test as the viewer's pointWithinFootprintBbox.
export function pointInFootprint(fp, x, y) {
  const { pos, relpos, size, angle } = fp.bbox;
  const [u, v] = rotate([x - pos[0], y - pos[1]], angle);
  return relpos[0] <= u && u <= relpos[0] + size[0] && relpos[1] <= v && v <= relpos[1] + size[1];
}
