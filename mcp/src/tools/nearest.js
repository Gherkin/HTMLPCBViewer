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

// Sides a pad can be reached from: its own side(s), minus each side where it
// lies inside the bbox of another part mounted on that side.
function reachableSides(all, fp, place) {
  const sides = place.side === 'both' ? ['F', 'B'] : [place.side];
  return sides.filter(
    (s) => !all.some((other) => other !== fp && other.layer === s && other.bbox && pointInFootprint(other, place.x, place.y))
  );
}

const RANK = { testpoint: 0, th: 1, smd: 2 };

export default {
  name: 'nearest',
  config: {
    title: 'Nearest reachable pads on a net',
    description:
      'Find the pads on a net, near a part or a point, that a person can reach with a probe or a ' +
      'wire. Use it for "where can I measure or patch +3.3V close to U69?".\n' +
      'Ranking: test points first, then through-hole pads, then SMD pads; nearest first within ' +
      'each group. So a test point far away comes before an SMD pad close by: check distance, or ' +
      'set max_distance. A test point is a part with refdes TP<number>, or with "testpoint" / ' +
      '"test point" in its value or footprint name.\n' +
      'Distance: from the pad center to the point, or, for a refdes, to the nearest edge of the ' +
      "part's footprint rectangle (the bbox that locate returns), so 0 for pads inside it. The " +
      "part's own pads are included.\n" +
      'Reach: a pad that lies inside the footprint rectangle of another part on the same side is ' +
      'taken as under that part and left out. A through-hole pad can be reached from both sides; ' +
      'if it is under a part on one side only, it is still listed, with side set to the free ' +
      'side. side is the side you can reach the pad from.\n' +
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
              'The side the pad can be reached from: "F" front (top), "B" back (bottom), or ' +
                '"both" for a through-hole pad that is free on both sides.'
            ),
          testpoint: z.literal(true).optional().describe('Present when the pad belongs to a test point.'),
          distance: z.number().describe('Distance to the point or part, in board units.'),
        })
      ),
      covered: z
        .number()
        .describe('Pads on the net left out because they are under another part on every side asked for.'),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store }) => async ({ board, net, near, side, limit = DEFAULT_LIMIT, max_distance }) => {
    const data = await loadBoard(store, board);

    let distance;
    if (typeof near === 'string') {
      const parts = partsByRef(data, near);
      if (!parts.length) {
        throw new BoardError(`No part "${near.trim()}" on board "${board}". Use a refdes from the board, or an [x, y] point.`);
      }
      distance = (x, y) => Math.min(...parts.map((fp) => distanceToFootprint(fp, x, y)));
    } else {
      distance = (x, y) => Math.hypot(x - near[0], y - near[1]);
    }

    const all = [...boardPads(data)];
    const name = matchNet(data, all, net);
    if (name === undefined) return { net, found: false, pads: [], covered: 0 };

    const tps = testPointRefs(data);
    const fps = data.footprints.filter(Boolean);
    const hits = [];
    let covered = 0;
    for (const { fp, pad } of all) {
      if (pad.net !== name) continue;
      const place = padPlace(fp, pad);
      let sides = reachableSides(fps, fp, place);
      if (side) sides = sides.filter((s) => s === side);
      if (!sides.length) {
        covered++;
        continue;
      }
      const d = distance(place.x, place.y);
      if (max_distance !== undefined && d > max_distance) continue;
      place.side = sides.length === 2 ? 'both' : sides[0];
      const tp = tps.has(fp.ref);
      if (tp) place.testpoint = true;
      place.distance = round(d);
      hits.push({ place, rank: tp ? RANK.testpoint : RANK[pad.type] ?? RANK.smd, d });
    }
    hits.sort((a, b) => a.rank - b.rank || a.d - b.d);
    return { net: name, found: true, pads: hits.slice(0, limit).map((h) => h.place), covered };
  },
};
