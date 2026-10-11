import * as z from 'zod/v4';
import { loadBoard } from '../boards.js';
import { round } from '../footprints.js';
import { DEFAULT_LIMIT, limitInput, maxDistanceInput, nearInput, reach, resolveNear, sideInput } from '../near.js';
import { boardPads, matchNet, padPlace, padSchema } from '../pads.js';

// A test point is a part whose refdes is "TP" and a number, or whose value
// or footprint name says "test point" (any case, with or without a space,
// "_" or "-" between the words). Both fixtures name every test point TP<n>
// with value "TestPoint" or "TESTPOINT", so the two rules agree there.
const TP_REF = /^TP\d/i;
const TP_TEXT = /test[\s_-]?point/i;

function testPointRefs(data) {
  const refs = new Set();
  for (const fp of data.footprints) if (fp && typeof fp.ref === 'string' && TP_REF.test(fp.ref)) refs.add(fp.ref);
  if (Array.isArray(data.components)) {
    for (const c of data.components) {
      if (!c || typeof c.ref !== 'string') continue;
      if (TP_TEXT.test(String(c.val ?? '')) || TP_TEXT.test(String(c.footprint ?? ''))) refs.add(c.ref);
    }
  }
  return refs;
}

export default {
  name: 'nearest',
  config: {
    title: 'Nearest pads on a net',
    description:
      'Find the pads on a net nearest to a part or a point, to choose where to probe or solder a ' +
      'wire. Use it for "where can I measure or patch +3.3V close to U69?".\n' +
      'Each pad has pin, the pad name that matches the PIN in a netlist REFDES:PIN, when the ' +
      'board has pad names (KiCad boards exported with tools/make_fixture.py do; Allegro boards and ' +
        'KiCad boards from stock ibom do not).\n' +
      'Order: by distance only, nearest first. Each pad says what it is: type "th" (through-hole) ' +
      'or "smd", and testpoint: true on a test point. A test point is a part with refdes ' +
      'TP<number>, or with "testpoint" / "test point" in its value or footprint name. Prefer a ' +
      'test point or a through-hole pad when it is about as close.\n' +
      'Distance: from the pad center to the point, or, for a refdes, to the nearest edge of the ' +
      "part's footprint rectangle (the bbox that locate returns), so 0 for pads inside it. The " +
      "part's own pads are listed with own: true. Own pads under the body of a BGA or QFN (or " +
      'any part with pads under it) may not be reachable. Own pads do not count toward limit: ' +
      'all of them are listed, plus up to limit other pads, sorted together by distance. side ' +
      'and max_distance apply to own pads as to any other pad.\n' +
      'Covered: a pad whose center lies inside the footprint rectangle of another part on the ' +
      'same side is still listed, with covered_by set to that part. The rectangle includes silk ' +
      'and fab outlines, so covered_by can also mean the pad is right next to that part. A ' +
      'through-hole pad can be reached from both sides: if it is covered on one side only, side ' +
      'is the free side and there is no covered_by; if it is covered on both, covered_by is set. ' +
      'side is the side to reach the pad from.\n' +
      'Vias are never returned. They have their own tool, nearest_vias, a last resort when no ' +
      'pad is near.\n' +
      'Coordinates and distances are board units, the same ones the viewer uses in its links: mm ' +
      'for KiCad boards; Allegro boards keep the design units. x grows right and y grows down, ' +
      'as seen from the top, for both sides.\n' +
      'Net matching is exact first, then ignores case if that gives exactly one net; refdes ' +
      'matching works the same way. A net that is not on the board gives found: false and no ' +
      'pads. A refdes that is not on the board is a tool error.',
    inputSchema: {
      ...nearInput,
      side: sideInput('pads'),
      limit: limitInput(
        `Most pads to return, not counting the own pads of the part given as near. Default ${DEFAULT_LIMIT}.`
      ),
      max_distance: maxDistanceInput('pads'),
    },
    outputSchema: {
      net: z.string().describe('The net name as it is on the board, or as asked if not found.'),
      found: z.boolean().describe('False when the board has no net by that name.'),
      pads: z.array(
        padSchema.extend({
          side: z
            .string()
            .describe(
              'The side to reach the pad from: "F" front (top), "B" back (bottom), or "both" for a ' +
                'through-hole pad that is free on both sides.'
            ),
          testpoint: z.literal(true).optional().describe('Present when the pad belongs to a test point.'),
          own: z.literal(true).optional().describe('Present when the pad belongs to the part given as near.'),
          covered_by: z
            .string()
            .optional()
            .describe(
              'Refdes of another part whose footprint rectangle holds the pad, on the side given. ' +
                'For a through-hole pad covered on both sides, the part on the front.'
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

    const all = [...boardPads(data)];
    const name = matchNet(data, all, net);
    if (name === undefined) return { net, found: false, pads: [] };

    const tps = testPointRefs(data);
    const fps = data.footprints.filter(Boolean);
    const hits = [];
    for (const { fp, pad } of all) {
      if (pad.net !== name) continue;
      const place = padPlace(fp, pad);
      let sides = place.side === 'both' ? ['F', 'B'] : [place.side];
      if (side) sides = sides.filter((s) => s === side);
      if (!sides.length) continue;
      const d = distance(place.x, place.y);
      if (max_distance !== undefined && d > max_distance) continue;
      hits.push({ fp, place, sides, d, own: parts.includes(fp) });
    }
    hits.sort((a, b) => a.d - b.d);

    // The near part's own pads do not count toward limit: a BGA or QFN would
    // fill it with pads at distance 0. side and max_distance apply to them as
    // to any pad. Keep all own pads and the first limit others, in order.
    const kept = [];
    let others = 0;
    for (const h of hits) {
      if (h.own) kept.push(h);
      else if (others < limit) {
        kept.push(h);
        others++;
      }
    }

    // Covers only change labels, not the order, so look them up for the
    // pads that are returned only.
    // A part does not cover its own pads.
    const pads = kept.map(({ fp, place, sides, d, own }) => {
      Object.assign(place, reach(fps, place.x, place.y, sides, fp.ref));
      if (tps.has(fp.ref)) place.testpoint = true;
      if (own) place.own = true;
      place.distance = round(d);
      return place;
    });
    return { net: name, found: true, pads };
  },
};
