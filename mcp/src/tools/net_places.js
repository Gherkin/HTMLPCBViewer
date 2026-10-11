import * as z from 'zod/v4';
import { loadBoard } from '../boards.js';
import { boardPads, matchNet, padPlace, padSchema } from '../pads.js';

export default {
  name: 'net_places',
  config: {
    title: 'Pads on a net',
    description:
      'List every pad on a net, to find where the net can be measured or patched. The net name ' +
      'is as written in the CAD tool, e.g. "+3.3V" or "/ADC1/CS". For each pad: the refdes of ' +
      'its part, the side it is on, its center, and whether it is SMD or through-hole. The ' +
      'export has no pad names, so pads carry no pin number; the pad the export marks as pin 1 ' +
      'has pin1: true.\n' +
      'Vias are not listed.\n' +
      'Coordinates are board units, the same ones the viewer uses in its links: mm for KiCad ' +
      'boards; Allegro boards keep the design units. x grows right and y grows down, as seen ' +
      'from the top, for both sides.\n' +
      'Matching is exact first, then ignores case if that gives exactly one net. A net that is ' +
      'not on the board gives found: false and no pads. A net on the board with no pads (only ' +
      'tracks, vias or zones) gives found: true and no pads. Unconnected pads are never listed.',
    inputSchema: {
      board: z.string().describe('Board path from list_boards, e.g. "lab/rev2/probe.json".'),
      net: z.string().describe('Net name as written in the CAD tool, e.g. "+3.3V" or "/ADC1/CS".'),
    },
    outputSchema: {
      net: z.string().describe('The net name as it is on the board, or as asked if not found.'),
      found: z.boolean().describe('False when the board has no net by that name.'),
      pads: z.array(padSchema),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store }) => async ({ board, net }) => {
    const data = await loadBoard(store, board);
    const all = [...boardPads(data)];
    const name = matchNet(data, all, net);
    if (name === undefined) return { net, found: false, pads: [] };

    const pads = all.filter(({ pad }) => pad.net === name).map(({ fp, pad }) => padPlace(fp, pad));
    return { net: name, found: true, pads };
  },
};
