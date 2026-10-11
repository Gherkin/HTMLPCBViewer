import * as z from 'zod/v4';
import { loadBoard } from '../boards.js';
import { round } from '../footprints.js';
import { DEFAULT_LIMIT, limitInput, maxDistanceInput, nearInput, reach, resolveNear, sideInput, takeLimit } from '../near.js';
import { boardPads, matchNet } from '../pads.js';
import { boardVias } from '../vias.js';

// Sent with every answer, so the warning is in front of whoever reads the
// result, not only in the tool description.
export const VIA_NOTE =
  'Vias are a last resort: use a pad (the nearest tool) when one is near enough. Vias are often ' +
  'covered by soldermask, which has to be scraped off before a probe or wire can touch the copper. ' +
  'The board export has no tenting data, so this tool cannot tell which vias are covered.';

export default {
  name: 'nearest_vias',
  config: {
    title: 'Nearest vias on a net (last resort)',
    description:
      'Find the vias on a net nearest to a part or a point. This is a last resort, for when ' +
      'nearest finds no usable pad close enough. Try nearest first.\n' +
      'Vias are often covered by soldermask (tented), which has to be scraped off before a probe ' +
      'or wire can touch the copper. The board export has no tenting data, so this tool cannot ' +
      'tell which vias are covered. Say so when you suggest a via.\n' +
      'Each via has x/y, the copper layers it spans (layer names as in the CAD tool, "F" and "B" ' +
      'for the outer layers), its pad diameter, its drill size when the export has one, and its ' +
      'distance. Order: by distance only, nearest first.\n' +
      'Reach: a via can be reached from a side only if it is on that outer layer. A via on inner ' +
      'layers only is never returned. side is the side to reach the via from: "F", "B" or "both".\n' +
      'Covered: a via whose center lies inside the footprint rectangle of a part on the same side ' +
      'is still listed, with covered_by set to that part; it is likely under the part body. The ' +
      'part given as near counts too. The rectangle includes silk and fab outlines, so covered_by ' +
      'can also mean the via is right next to that part. A via on both outer layers that is ' +
      'covered on one side only is given on the free side, without covered_by.\n' +
      'Vias with covered_by set to the part given as near do not count toward limit: all of them ' +
      'are listed, plus up to limit other vias, sorted together by distance. side and ' +
      'max_distance apply to them as to any other via.\n' +
      'Distance: from the via center to the point, or, for a refdes, to the nearest edge of the ' +
      "part's footprint rectangle (the bbox that locate returns), so 0 for vias inside it.\n" +
      'Coordinates, diameters and distances are board units, the same ones the viewer uses in its ' +
      'links: mm for KiCad boards; Allegro boards keep the design units. x grows right and y grows ' +
      'down, as seen from the top, for both sides.\n' +
      'Net and refdes matching are exact first, then ignore case if that gives exactly one match. ' +
      'A net that is not on the board gives found: false and no vias. A refdes that is not on the ' +
      'board is a tool error.',
    inputSchema: {
      ...nearInput,
      side: sideInput('vias'),
      limit: limitInput(
        `Most vias to return, not counting vias with covered_by set to the part given as near. Default ${DEFAULT_LIMIT}.`
      ),
      max_distance: maxDistanceInput('vias'),
    },
    outputSchema: {
      net: z.string().describe('The net name as it is on the board, or as asked if not found.'),
      found: z.boolean().describe('False when the board has no net by that name.'),
      note: z.string().describe('Vias are a last resort and are often covered by soldermask.'),
      vias: z.array(
        z.object({
          x: z.number().describe('Via center x, in board units.'),
          y: z.number().describe('Via center y, in board units.'),
          layers: z.array(z.string()).describe('Copper layers the via spans, as named on the board.'),
          side: z
            .string()
            .describe('The side to reach the via from: "F" front (top), "B" back (bottom), or "both".'),
          diameter: z.number().describe('Via pad diameter, in board units.'),
          drill: z.number().optional().describe('Drill diameter, in board units. Absent when the export has none.'),
          covered_by: z
            .string()
            .optional()
            .describe(
              'Refdes of a part whose footprint rectangle holds the via, on the side given. For a via ' +
                'covered on both sides, the part on the front.'
            ),
          distance: z.number().describe('Distance to the point or part, in board units.'),
        })
      ),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store }) => async ({ board, net, near, side, limit = DEFAULT_LIMIT, max_distance }) => {
    const data = await loadBoard(store, board);
    const { parts, distance } = resolveNear(data, near, board);

    const vias = boardVias(data);
    const name = matchNet(data, [...boardPads(data)], net, vias.map((v) => v.net));
    if (name === undefined) return { net, found: false, note: VIA_NOTE, vias: [] };

    const hits = [];
    for (const v of vias) {
      if (v.net !== name) continue;
      let sides = ['F', 'B'].filter((s) => v.layers.includes(s));
      if (side) sides = sides.filter((s) => s === side);
      if (!sides.length) continue;
      const d = distance(v.x, v.y);
      if (max_distance !== undefined && d > max_distance) continue;
      hits.push({ v, sides, d });
    }
    hits.sort((a, b) => a.d - b.d);

    // Vias covered by the near part do not count toward limit, the same as
    // the near part's own pads in nearest. side and max_distance apply to
    // them as to any via. This needs the cover of every hit.
    const fps = data.footprints.filter(Boolean);
    const nearRefs = new Set(parts.map((fp) => fp.ref));
    for (const h of hits) {
      h.x = round(h.v.x);
      h.y = round(h.v.y);
      Object.assign(h, reach(fps, h.x, h.y, h.sides));
    }
    const kept = takeLimit(hits, limit, (h) => !nearRefs.has(h.covered_by));

    const out = kept.map(({ v, x, y, side: s, covered_by, d }) => {
      const via = { x, y, layers: v.layers, side: s, diameter: round(v.width) };
      if (v.drill !== undefined) via.drill = round(v.drill);
      if (covered_by) via.covered_by = covered_by;
      via.distance = round(d);
      return via;
    });
    return { net: name, found: true, note: VIA_NOTE, vias: out };
  },
};
