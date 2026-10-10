// Pads from the board payload. Every tool that talks about pads goes through
// here, so they all mean the same thing by a pad's place and side.
//
// footprints[i].pads[j] in the payload:
//   pos     pad center, absolute board coordinates (not relative to the
//           footprint)
//   type    "smd" or "th"
//   layers  ["F"], ["B"], or ["F", "B"] for a through-hole pad
//   net     net name as written in the CAD tool; "" when unconnected
//   pin1    1 on the pad the export marks as pin 1, absent otherwise
// The export has no pad names, so there is no pin number here yet.
//
// Vias are tracks in the payload, not pads, so they never come out of here.

import { round } from './footprints.js';

// Every pad on the board, with the footprint it belongs to.
export function* boardPads(data) {
  for (const fp of data.footprints) {
    if (!fp || typeof fp.ref !== 'string' || !Array.isArray(fp.pads)) continue;
    for (const pad of fp.pads) {
      if (!pad || !Array.isArray(pad.pos)) continue;
      yield { fp, pad };
    }
  }
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
