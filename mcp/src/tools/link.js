import * as z from 'zod/v4';
import { BoardError, loadBoard } from '../boards.js';
import { footprintsByRef } from '../footprints.js';
import { formatHashPairs, parseBaseUrl, viewerUrl } from '../links.js';
import { boardPads, matchName, namesIgnoringCase, netNames } from '../pads.js';

const box = z
  .object({ minx: z.number(), miny: z.number(), maxx: z.number(), maxy: z.number() })
  .describe('An area in board units, the same shape as the extent from locate.');

const KINDS = { tracks: 't', zones: 'z', vias: 'v', silk: 's', fab: 'f' };

// Short numbers in the link: 4 decimals is 0.1 um in mm and 0.0001 mil.
const num = (v) => String(Math.round(v * 1e4) / 1e4);

function viewValue(b) {
  return [(b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2, b.maxx - b.minx, b.maxy - b.miny].map(num).join(',');
}

// The copper layer names the viewer knows: F, B and every layer with tracks
// or zones (getInnerLayers in web/render.js).
function copperLayers(data) {
  const names = new Set(['F', 'B']);
  for (const key of ['tracks', 'zones']) {
    if (data[key] && typeof data[key] === 'object') for (const l of Object.keys(data[key])) names.add(l);
  }
  return [...names];
}

// The error for a name that matchName did not find among names. what is
// "net" or "copper layer"; more is added when no name matches at all.
function notFound(what, want, names, more = '') {
  const hits = namesIgnoringCase(names, want);
  return hits.length > 1
    ? `"${want.trim()}" matches ${hits.join(', ')} when case is ignored; give the exact ${what} name.`
    : `No ${what} "${want.trim()}" on the board.${more}`;
}

export default {
  name: 'link',
  config: {
    title: 'Viewer link',
    description:
      'Make a viewer link that opens a board with parts and nets selected, markers at board ' +
      'points, a side, a view and copper layers. Always use this tool for a viewer link; never ' +
      'write the URL or its hash by hand.\n' +
      'Everything but board is optional. refs and nets are selected in the order given (parts ' +
      'first), which sets their colours; the detail pane shows focus, or the last one. Without ' +
      'a view or zoom the viewer zooms to the focused part. marks put a marker at a board point ' +
      'on one side, e.g. a pad or via from nearest or nearest_vias; it does not select anything. ' +
      'view_f and view_b set the visible area per side; zoom is used only when there is no view.\n' +
      'Side: the link shows every side that a view or a marker is on (and the focused part, ' +
      'when there are markers or a side and no view or zoom, since the viewer then turns to that ' +
      'part). A side given that leaves one out is widened, with ' +
      'a warning.\n' +
      'Names are matched like the other tools: exact first, then ignoring case if that gives ' +
      'exactly one; the link uses the name as it is on the board. A refdes, net or copper layer ' +
      'that is not on the board is a tool error, so a link never silently shows nothing. A net ' +
      'with no pads cannot be selected in the viewer and is an error too; mark its via instead.\n' +
      'Coordinates are board units, as in the other tools.\n' +
      'The link points at the viewer this server serves. If the server does not know its own ' +
      'address, the link is root-relative ("/viewer/?...") and warnings says so; then ask the ' +
      'user for the address of the board list page (e.g. "http://host:1010/", not a /viewer/ ' +
      'link) and pass it as base_url.',
    inputSchema: {
      board: z.string().describe('Board path from list_boards, e.g. "lab/rev2/probe.json".'),
      refs: z.array(z.string()).optional().describe('Parts to select, by refdes, e.g. ["U69", "R12"].'),
      nets: z.array(z.string()).optional().describe('Nets to select, e.g. ["+3.3V", "/ADC1/CS"].'),
      focus: z
        .string()
        .optional()
        .describe('What the detail pane shows: "comp:<refdes>" or "net:<name>". Default is the last of refs, then nets.'),
      marks: z
        .array(z.object({ side: z.enum(['F', 'B']), x: z.number(), y: z.number() }))
        .optional()
        .describe('Markers at board points: side "F" (front, top) or "B" (back, bottom), and x, y in board units.'),
      side: z.enum(['F', 'B', 'FB']).optional().describe('Sides to show: "F", "B" or "FB" for both.'),
      view_f: box.optional().describe('Visible area on the front side, e.g. an extent from locate.'),
      view_b: box.optional().describe('Visible area on the back side.'),
      zoom: z
        .enum(['board', 'selected', 'highlight'])
        .optional()
        .describe(
          'Zoom when there is no view: "board" fits the board, "selected" fits the selection and ' +
            'markers, "highlight" zooms to the focused part.'
        ),
      copper: z
        .array(
          z.object({
            layer: z.string().describe('Copper layer as named in the export, e.g. "F", "B", "In1.Cu".'),
            only: z
              .array(z.enum(['tracks', 'zones', 'vias', 'silk', 'fab']))
              .optional()
              .describe('Show only these kinds on the layer. Default: everything.'),
          })
        )
        .optional()
        .describe('Copper layers to show; the rest are hidden. [] hides them all. Leave out to keep the user\'s layers.'),
      netlayers: z.boolean().optional().describe('Also show every layer the selected nets are routed on.'),
      base_url: z
        .string()
        .optional()
        .describe(
          'Address of the board list page, e.g. "http://host:1010/"; the folder that holds viewer/, ' +
            'not the viewer page itself. Overrides the server\'s own address.'
        ),
    },
    outputSchema: {
      url: z.string().describe('The viewer link. Give it to the user as is.'),
      side: z.string().optional().describe('The side the link shows ("F", "B" or "FB"), when it sets one.'),
      warnings: z.array(z.string()).describe('Things the link does differently from what was asked.'),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store, baseUrl }) => async (args) => {
    const { board, refs = [], nets = [], focus, marks = [], side, view_f, view_b, zoom, copper, netlayers, base_url } = args;
    const base = base_url !== undefined ? parseBaseUrl(base_url, 'base_url') : baseUrl;
    const data = await loadBoard(store, board);
    const errors = new Set();
    const warnings = [];

    const fps = data.footprints.filter((fp) => fp && typeof fp.ref === 'string');
    const findRef = (ref) => {
      const refsFound = [...new Set(footprintsByRef(fps, ref).map((fp) => fp.ref))];
      if (refsFound.length === 1) return refsFound[0];
      errors.add(
        refsFound.length
          ? `"${ref.trim()}" matches ${refsFound.join(', ')} when case is ignored; give the exact refdes.`
          : `No part "${ref.trim()}" on the board.`
      );
      return undefined;
    };
    // Built on the first net asked for, once.
    let netList, padNets;
    const findNet = (net) => {
      if (!netList) {
        const pads = [...boardPads(data)];
        netList = netNames(data, pads);
        padNets = new Set(pads.map(({ pad }) => pad.net));
      }
      const name = matchName(netList, net);
      if (name === undefined) errors.add(notFound('net', net, netList));
      else if (!padNets.has(name)) errors.add(`Net "${name}" has no pads, so the viewer cannot select it. Mark one of its vias instead.`);
      else return name;
      return undefined;
    };

    const pairs = [];
    for (const ref of refs) {
      const r = findRef(ref);
      if (r !== undefined) pairs.push(['comp', r]);
    }
    for (const net of nets) {
      const n = findNet(net);
      if (n !== undefined) pairs.push(['net', n]);
    }

    // The focus as the viewer reads it: given, or the last selected.
    let focusRef;
    if (focus !== undefined) {
      const m = /^(comp|net):(.*)$/.exec(focus.trim());
      if (!m) {
        errors.add(`focus must be "comp:<refdes>" or "net:<name>", not "${focus}".`);
      } else if (m[1] === 'comp') {
        focusRef = findRef(m[2]);
        if (focusRef !== undefined) pairs.push(['focus', 'comp:' + focusRef]);
      } else {
        const n = findNet(m[2]);
        if (n !== undefined) pairs.push(['focus', 'net:' + n]);
      }
    } else if (pairs.length && pairs[pairs.length - 1][0] === 'comp') {
      focusRef = pairs[pairs.length - 1][1];
    }

    for (const [name, b] of [['view_f', view_f], ['view_b', view_b]]) {
      // Checked after rounding: the viewer drops a view with no width or height.
      if (b && !(Number(num(b.maxx - b.minx)) > 0 && Number(num(b.maxy - b.miny)) > 0)) {
        errors.add(
          `${name} must have maxx > minx and maxy > miny, by at least 0.0001; for a single point use marks with zoom "selected".`
        );
      }
    }

    const copperPairs = [];
    if (copper) {
      const layers = copperLayers(data);
      for (const { layer, only } of copper) {
        const l = matchName(layers, layer);
        if (l === undefined) {
          errors.add(notFound('copper layer', layer, layers, ` It has: ${layers.join(', ')}.`));
          continue;
        }
        copperPairs.push(['copper', only ? `${l}:${[...new Set(only)].map((k) => KINDS[k]).join('')}` : l]);
      }
      // copper= alone hides every layer.
      if (!copper.length) copperPairs.push(['copper', '']);
    }

    if (errors.size) throw new BoardError(`Cannot make a link for "${board}":\n` + [...errors].join('\n'));

    // The sides the link must show. The viewer keeps a view only on a side it
    // shows, and without side= it picks the sides from the markers alone, so a
    // view on the other side would be lost. So side= goes in whenever there is
    // a view or a marker. A focused part with no view and no zoom makes the
    // viewer switch to that part's side (selectFootprint in web/app.js), which
    // would hide a marker or a given side on the other side.
    const need = new Set();
    if (view_f) need.add('F');
    if (view_b) need.add('B');
    for (const m of marks) need.add(m.side);
    if ((need.size || side !== undefined) && !view_f && !view_b && !zoom && focusRef !== undefined) {
      for (const fp of fps) if (fp.ref === focusRef && (fp.layer === 'F' || fp.layer === 'B')) need.add(fp.layer);
    }
    let shown = side;
    const missing = [...need].filter((s) => !(side ?? '').includes(s));
    if (side !== undefined && missing.length) {
      shown = 'FB';
      warnings.push(`side "${side}" would hide ${missing.join(' and ')}; the link shows both sides.`);
    } else if (side === undefined && need.size) {
      shown = need.size === 2 ? 'FB' : [...need][0];
    }
    if (shown) pairs.push(['side', shown]);

    if (view_f) pairs.push(['viewF', viewValue(view_f)]);
    if (view_b) pairs.push(['viewB', viewValue(view_b)]);
    for (const m of marks) pairs.push(['mark', `${m.side}:${num(m.x)},${num(m.y)}`]);
    if (zoom) pairs.push(['zoom', zoom]);
    pairs.push(...copperPairs);
    if (netlayers) pairs.push(['netlayers', '1']);

    if (!base) {
      warnings.push(
        'The server does not know its own address, so the link starts at /viewer/. Ask the user ' +
          'for the address of the board list page (e.g. "http://host:1010/", not a /viewer/ link) ' +
          'and call link again with base_url.'
      );
    }
    const out = { url: viewerUrl(base, board, formatHashPairs(pairs)), warnings };
    if (shown) out.side = shown;
    return out;
  },
};
