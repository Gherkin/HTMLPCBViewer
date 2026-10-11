import * as z from 'zod/v4';
import { BoardError, loadBoard } from '../boards.js';
import { distanceToFootprint, pointInFootprint, round } from '../footprints.js';
import { boardPads, matchNet, padPlace, padSchema } from '../pads.js';

const point = z.array(z.number()).length(2);

const DEFAULT_LIMIT = 10;

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

// Footprints with this refdes: exact first, then ignoring case if that names
// exactly one refdes.
function partsByRef(data, ref) {
  const want = ref.trim();
  const fps = data.footprints.filter((fp) => fp && typeof fp.ref === 'string' && fp.bbox);
  const exact = fps.filter((fp) => fp.ref === want);
  if (exact.length) return exact;
  const lower = want.toLowerCase();
  const hits = fps.filter((fp) => fp.ref.toLowerCase() === lower);
  return new Set(hits.map((fp) => fp.ref)).size === 1 ? hits : [];
}

// The part that covers the pad on side s: another part mounted on that side
// whose bbox holds the pad center. undefined when the pad is free there.
function coveringPart(all, fp, place, s) {
  return all.find((other) => other !== fp && other.layer === s && other.bbox && pointInFootprint(other, place.x, place.y));
}

export default {
  name: 'nearest',
  config: {
    title: 'Nearest pads on a net',
    description:
      'Find the pads on a net nearest to a part or a point, to choose where to probe or solder a ' +
      'wire. Use it for "where can I measure or patch +3.3V close to U69?".\n' +
      'Order: by distance only, nearest first. Each pad says what it is: type "th" (through-hole) ' +
      'or "smd", and testpoint: true on a test point. A test point is a part with refdes ' +
      'TP<number>, or with "testpoint" / "test point" in its value or footprint name. Prefer a ' +
      'test point or a through-hole pad when it is about as close.\n' +
      'Distance: from the pad center to the point, or, for a refdes, to the nearest edge of the ' +
      "part's footprint rectangle (the bbox that locate returns), so 0 for pads inside it. The " +
      "part's own pads are listed with own: true. Own pads under the body of a BGA or QFN (or " +
      'any part with pads under it) may not be reachable.\n' +
      'Covered: a pad whose center lies inside the footprint rectangle of another part on the ' +
      'same side is still listed, with covered_by set to that part. The rectangle includes silk ' +
      'and fab outlines, so covered_by can also mean the pad is right next to that part. A ' +
      'through-hole pad can be reached from both sides: if it is covered on one side only, side ' +
      'is the free side and there is no covered_by; if it is covered on both, covered_by is set. ' +
      'side is the side to reach the pad from.\n' +
      'Vias are never returned. They have their own search, a last resort when no pad is near.\n' +
      'Coordinates and distances are board units, the same ones the viewer uses in its links: mm ' +
      'for KiCad boards; Allegro boards keep the design units. x grows right and y grows down, ' +
      'as seen from the top, for both sides.\n' +
      'Net matching is exact first, then ignores case if that gives exactly one net; refdes ' +
      'matching works the same way. A net that is not on the board gives found: false and no ' +
      'pads. A refdes that is not on the board is a tool error.',
    inputSchema: {
      board: z.string().describe('Board path from list_boards, e.g. "lab/rev2/probe.json".'),
      net: z.string().describe('Net name as written in the CAD tool, e.g. "+3.3V" or "/ADC1/CS".'),
      near: z
        .union([z.string(), point])
        .describe('A refdes such as "U69", or a board point [x, y] in board units.'),
      side: z
        .enum(['F', 'B'])
        .optional()
        .describe('Only pads reachable from this side: "F" front (top) or "B" back (bottom).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(`Most pads to return. Default ${DEFAULT_LIMIT}.`),
      max_distance: z
        .number()
        .min(0)
        .optional()
        .describe('Leave out pads farther away than this, in board units.'),
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
            .describe('Refdes of another part whose footprint rectangle holds the pad, on the side given.'),
          distance: z.number().describe('Distance to the point or part, in board units.'),
        })
      ),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store }) => async ({ board, net, near, side, limit = DEFAULT_LIMIT, max_distance }) => {
    const data = await loadBoard(store, board);

    let distance;
    let parts = [];
    if (typeof near === 'string') {
      parts = partsByRef(data, near);
      if (!parts.length) {
        throw new BoardError(`No part "${near.trim()}" on board "${board}". Use a refdes from the board, or an [x, y] point.`);
      }
      distance = (x, y) => Math.min(...parts.map((fp) => distanceToFootprint(fp, x, y)));
    } else {
      distance = (x, y) => Math.hypot(x - near[0], y - near[1]);
    }

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

      const covers = sides.map((s) => coveringPart(fps, fp, place, s));
      const free = sides.filter((s, i) => !covers[i]);
      if (free.length) {
        place.side = free.length === 2 ? 'both' : free[0];
      } else {
        place.side = sides.length === 2 ? 'both' : sides[0];
        place.covered_by = covers[0].ref;
      }
      if (tps.has(fp.ref)) place.testpoint = true;
      if (parts.includes(fp)) place.own = true;
      place.distance = round(d);
      hits.push({ place, d });
    }
    hits.sort((a, b) => a.d - b.d);
    return { net: name, found: true, pads: hits.slice(0, limit).map((h) => h.place) };
  },
};
