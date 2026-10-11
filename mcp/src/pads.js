// Pads from the board payload. Every tool that talks about pads goes through
// here, so they all mean the same thing by a pad's place and side.
//
// footprints[i].pads[j] in the payload:
//   pos     pad center, absolute board coordinates (not relative to the
//           footprint)
//   type    "smd" or "th"
//   layers  ["F"], ["B"], or ["F", "B"] for a through-hole pad (KiCad).
//           Allegro exports one pad per side instead: a through-hole pin is
//           two pads at the same pos, ["F"] with type "th" and ["B"] with
//           type "smd" (allegro-skills/exportJson.il, addPad). boardPads
//           merges such a pair into one "th" pad on ["F", "B"].
//   net    net name as written in the CAD tool; "" when unconnected
//   pin1    1 on the pad the export marks as pin 1, absent otherwise
// The export has no pad names, so there is no pin number here yet.
//
// Vias are tracks in the payload, not pads, so they never come out of here.

import * as z from 'zod/v4';
import { round } from './footprints.js';

// Output schema of one padPlace, shared by every tool that lists pads.
export const padSchema = z.object({
  ref: z.string().describe('Reference designator of the part the pad belongs to.'),
  side: z
    .string()
    .describe('"F" for the front (top), "B" for the back (bottom), "both" for a through-hole pad.'),
  x: z.number().describe('Pad center x, in board units.'),
  y: z.number().describe('Pad center y, in board units.'),
  type: z.string().describe('"smd" or "th" (through-hole).'),
  pin1: z.literal(true).optional().describe('Present on the pad the export marks as pin 1.'),
});

// Every pad on the board, with the footprint it belongs to. Two pads of one
// footprint at the same pos, where one is "th", come out as one "th" pad on
// both sides (the Allegro pair above). pin1 is kept if either pad has it.
export function* boardPads(data) {
  for (const fp of data.footprints) {
    if (!fp || typeof fp.ref !== 'string' || !Array.isArray(fp.pads)) continue;
    const pads = [];
    const at = new Map();
    for (const pad of fp.pads) {
      if (!pad || !Array.isArray(pad.pos)) continue;
      const key = pad.pos.join(',');
      const i = at.get(key);
      if (i !== undefined && (pads[i].type === 'th' || pad.type === 'th')) {
        const other = pads[i];
        const th = other.type === 'th' ? other : pad;
        pads[i] = { ...th, type: 'th', layers: ['F', 'B'] };
        if (other.pin1 || pad.pin1) pads[i].pin1 = 1;
        continue;
      }
      at.set(key, pads.length);
      pads.push(pad);
    }
    for (const pad of pads) yield { fp, pad };
  }
}

// The net name on the board that `net` asks for, or undefined. Known names
// are the board's net list plus every pad net; "" is the unconnected net and
// never matches. Exact first (after trimming), then ignoring case if that
// gives exactly one net. `pads` is [...boardPads(data)].
export function matchNet(data, pads, net) {
  const names = new Set(Array.isArray(data.nets) ? data.nets.filter((n) => typeof n === 'string') : []);
  for (const { pad } of pads) if (typeof pad.net === 'string') names.add(pad.net);
  names.delete('');

  const want = net.trim();
  if (names.has(want)) return want;
  const lower = want.toLowerCase();
  const hits = [...names].filter((n) => n.toLowerCase() === lower);
  return hits.length === 1 ? hits[0] : undefined;
}

// "F" or "B" for a pad on one side, "both" for a pad on both (through-hole).
function padSide(fp, pad) {
  const layers = Array.isArray(pad.layers) ? pad.layers : [];
  const front = layers.includes('F');
  const back = layers.includes('B');
  if (front && back) return 'both';
  if (front) return 'F';
  if (back) return 'B';
  return fp.layer;
}

// Where a pad is: refdes, side, board position and pad type. pin1 is only
// set on the pad the export marks as pin 1.
export function padPlace(fp, pad) {
  const place = {
    ref: fp.ref,
    side: padSide(fp, pad),
    x: round(pad.pos[0]),
    y: round(pad.pos[1]),
    type: pad.type,
  };
  if (pad.pin1) place.pin1 = true;
  return place;
}
