// What nearest and nearest_vias share: the input fields, how "near" turns into
// a distance, and which part covers a point on a side. Both tools go through
// here, so near, side, limit and max_distance mean the same in both.

import * as z from 'zod/v4';
import { BoardError } from './boards.js';
import { distanceToFootprint, pointInFootprint } from './footprints.js';

export const DEFAULT_LIMIT = 10;

const point = z.array(z.number()).length(2);

// Input fields of both tools. side, limit and max_distance are made per tool,
// so each names what it returns.
export const nearInput = {
  board: z.string().describe('Board path from list_boards, e.g. "lab/rev2/probe.json".'),
  net: z.string().describe('Net name as written in the CAD tool, e.g. "+3.3V" or "/ADC1/CS".'),
  near: z.union([z.string(), point]).describe('A refdes such as "U69", or a board point [x, y] in board units.'),
};

export const maxDistanceInput = (what) =>
  z.number().min(0).optional().describe(`Leave out ${what} farther away than this, in board units.`);

export const sideInput = (what) =>
  z.enum(['F', 'B']).optional().describe(`Only ${what} reachable from this side: "F" front (top) or "B" back (bottom).`);

export const limitInput = (text) => z.number().int().min(1).max(200).optional().describe(text);

// Footprints with this refdes: exact first, then ignoring case if that names
// exactly one refdes. A tool error when there is none, or when ignoring case
// gives more than one.
function partsByRef(data, ref, board) {
  const want = ref.trim();
  const fps = data.footprints.filter((fp) => fp && typeof fp.ref === 'string' && fp.bbox);
  const exact = fps.filter((fp) => fp.ref === want);
  if (exact.length) return exact;
  const lower = want.toLowerCase();
  const hits = fps.filter((fp) => fp.ref.toLowerCase() === lower);
  const refs = [...new Set(hits.map((fp) => fp.ref))];
  if (refs.length === 1) return hits;
  if (refs.length > 1) {
    throw new BoardError(`"${want}" matches ${refs.join(', ')} on board "${board}" when case is ignored. Give the exact refdes.`);
  }
  throw new BoardError(`No part "${want}" on board "${board}". Use a refdes from the board, or an [x, y] point.`);
}

// near as given to the tool: the footprints it names (none for a point) and
// distance(x, y) from a board point to it. For a refdes the distance is to
// the nearest edge of its footprint rectangle, 0 inside it.
export function resolveNear(data, near, board) {
  if (typeof near === 'string') {
    const parts = partsByRef(data, near, board);
    return { parts, distance: (x, y) => Math.min(...parts.map((fp) => distanceToFootprint(fp, x, y))) };
  }
  return { parts: [], distance: (x, y) => Math.hypot(x - near[0], y - near[1]) };
}

// The first limit hits that count, plus every hit that does not, in the order
// given. hits must already be sorted by distance. Both tools use it so the
// near part's own pads (nearest) and the vias inside its box (nearest_vias) do not
// fill the list: a BGA or QFN would fill it with hits at distance 0.
export function takeLimit(hits, limit, counts) {
  const kept = [];
  let n = 0;
  for (const h of hits) {
    if (!counts(h)) kept.push(h);
    else if (n < limit) {
      kept.push(h);
      n++;
    }
  }
  return kept;
}

// The part on side s whose footprint rectangle holds board point (x, y), other
// than one with refdes skipRef. undefined when the point is free there.
export function coveringPart(fps, x, y, s, skipRef) {
  return fps.find((fp) => fp.ref !== skipRef && fp.layer === s && fp.bbox && pointInFootprint(fp, x, y));
}

// Side and cover for something reachable from `sides` (["F"], ["B"] or
// ["F", "B"]). The free sides win: side is "both" or the one free side, and
// there is no covered_by. Covered on every side, side is as given and
// covered_by is the part on the first of them.
export function reach(fps, x, y, sides, skipRef) {
  const covers = sides.map((s) => coveringPart(fps, x, y, s, skipRef));
  const free = sides.filter((s, i) => !covers[i]);
  const pick = free.length ? free : sides;
  const out = { side: pick.length === 2 ? 'both' : pick[0] };
  if (!free.length) out.covered_by = covers[0].ref;
  return out;
}
