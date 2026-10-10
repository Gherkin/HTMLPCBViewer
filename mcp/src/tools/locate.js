import * as z from 'zod/v4';
import { loadBoard } from '../boards.js';
import { footprintPlace } from '../footprints.js';

const point = z.array(z.number()).length(2);

export default {
  name: 'locate',
  config: {
    title: 'Locate parts',
    description:
      'Find where parts are on a board, by reference designator (e.g. "U69"). For each part: the ' +
      'side it is mounted on, the center and size of its footprint rectangle, the rotation, and ' +
      'the extent of the rotated rectangle on the board.\n' +
      'The rectangle is the footprint bbox from the CAD export. From KiCad it is the outer extent ' +
      "of the footprint's pads and shapes on all layers (silk, fab, courtyard if any), text left " +
      'out. From Allegro it is the place boundary (PLACE_BOUND_TOP/BOTTOM), or the whole symbol ' +
      'if it has none. So it is about the part body and its pads, a little larger than the ' +
      'copper.\n' +
      'Coordinates are board units, the same ones the viewer uses in its links: mm for KiCad ' +
      'boards; Allegro boards keep the design units. x grows right and y grows down, as seen ' +
      'from the top, for both sides.\n' +
      'Refdes that are not on the board are listed in not_found; the rest are still returned. ' +
      'Matching is exact first, then ignores case.',
    inputSchema: {
      board: z.string().describe('Board path from list_boards, e.g. "lab/rev2/probe.json".'),
      refs: z.array(z.string()).min(1).describe('Reference designators, e.g. ["U69", "R12"].'),
    },
    outputSchema: {
      parts: z.array(
        z.object({
          ref: z.string().describe('Reference designator as it is on the board.'),
          side: z.string().describe('"F" for the front (top) side, "B" for the back (bottom).'),
          center: point.describe('Center of the footprint rectangle, [x, y] in board units.'),
          size: point.describe('Width and height of the rectangle before rotation, in board units.'),
          angle: z.number().describe('Rotation in degrees, as the CAD export gives it.'),
          extent: z
            .object({ minx: z.number(), miny: z.number(), maxx: z.number(), maxy: z.number() })
            .describe('Axis-aligned box around the rotated rectangle, in board units.'),
        })
      ),
      not_found: z.array(z.string()).describe('Requested refdes that are not on the board.'),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store }) => async ({ board, refs }) => {
    const data = await loadBoard(store, board);
    const byRef = new Map();
    const byLower = new Map();
    for (const fp of data.footprints) {
      if (!fp || typeof fp.ref !== 'string' || !fp.bbox) continue;
      if (!byRef.has(fp.ref)) byRef.set(fp.ref, []);
      byRef.get(fp.ref).push(fp);
      const lower = fp.ref.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, []);
      byLower.get(lower).push(fp);
    }
    const parts = [];
    const notFound = [];
    const seen = new Set();
    for (const ref of refs) {
      const want = ref.trim();
      const hits = byRef.get(want) ?? byLower.get(want.toLowerCase());
      if (!hits) {
        notFound.push(ref);
        continue;
      }
      // A board can carry the same refdes twice; return every copy, once.
      for (const fp of hits) {
        if (seen.has(fp)) continue;
        seen.add(fp);
        parts.push(footprintPlace(fp));
      }
    }
    return { parts, not_found: notFound };
  },
};
