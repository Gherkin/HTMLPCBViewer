// Vias from the board payload. The payload has no via records: a via is a
// zero-length track (start equal to end) in tracks[<layer>], one copy on
// every copper layer it spans, each with net and width (the pad diameter),
// and drillsize when the export has it (allegro-skills/exportJson.il addVia,
// tools/make_fixture.py). Layer keys are "F", "B" and the inner layer names
// as in the CAD tool ("In1.Cu" for KiCad, e.g. "ETCH/GND" for Allegro).
//
// A zero-length item on only one layer is not a via. Copies at the same
// point on the same net are one via; some boards have two copies on a layer
// there (e.g. a stacked via), which still is one place to probe.

// Every via on the board: { x, y, net, layers, width, drill }. layers is in
// the order of the payload's track layers. width is the largest pad diameter
// over the copies; drill is undefined when the export has no drill size.
export function boardVias(data) {
  const tracks = data.tracks && typeof data.tracks === 'object' ? data.tracks : {};
  const at = new Map();
  for (const [layer, items] of Object.entries(tracks)) {
    if (!Array.isArray(items)) continue;
    for (const t of items) {
      if (!t || !Array.isArray(t.start) || !Array.isArray(t.end)) continue;
      if (t.start[0] !== t.end[0] || t.start[1] !== t.end[1]) continue;
      if (typeof t.net !== 'string' || t.net === '') continue;
      const key = `${t.start[0]},${t.start[1]},${t.net}`;
      let v = at.get(key);
      if (!v) {
        v = { x: t.start[0], y: t.start[1], net: t.net, layers: [], width: 0, drill: undefined };
        at.set(key, v);
      }
      if (!v.layers.includes(layer)) v.layers.push(layer);
      if (typeof t.width === 'number' && t.width > v.width) v.width = t.width;
      if (typeof t.drillsize === 'number' && v.drill === undefined) v.drill = t.drillsize;
    }
  }
  return [...at.values()].filter((v) => v.layers.length >= 2);
}
