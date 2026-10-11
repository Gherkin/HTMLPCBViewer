import * as z from 'zod/v4';
import { BoardError, loadBoard } from '../boards.js';
import { parseViewerLink, viewerUrl } from '../links.js';
import { linkInput, makeLink } from './link.js';

export const SIZE = { width: 1280, height: 800 };
export const MIN_SIZE = { width: 320, height: 240 };
export const MAX_SIZE = { width: 2560, height: 1600 };

const size = (key) =>
  z
    .number()
    .int()
    .min(MIN_SIZE[key])
    .max(MAX_SIZE[key])
    .optional()
    .describe(`Window ${key} in pixels, ${MIN_SIZE[key]} to ${MAX_SIZE[key]}. Default ${SIZE[key]}.`);

const { board, ...linkFields } = linkInput;

export default {
  name: 'snapshot',
  config: {
    title: 'Viewer snapshot',
    description:
      'A PNG of what a viewer link shows, so you can check a link before you give it to the ' +
      'user: is the board in view, is it the right side, is the marker on the right pad, is the ' +
      'selection what you meant.\n' +
      'Give either url (a link from the link tool) or the same fields as the link tool; then ' +
      'the link is made exactly as link makes it. The image is the whole viewer page, side ' +
      'panel included, after the board has finished drawing.\n' +
      'The answer also has the link (as link would give it) and its warnings. Snapshots take a ' +
      'few seconds and the server draws only a few at once; when it is busy, try again.',
    inputSchema: {
      url: z
        .string()
        .optional()
        .describe('A viewer link from the link tool. Leave out to give the link fields instead.'),
      board: board.optional().describe('Board path from list_boards. Needed unless url is given.'),
      ...linkFields,
      width: size('width'),
      height: size('height'),
    },
    outputSchema: {
      url: z.string().describe('The viewer link the image shows.'),
      side: z.string().optional().describe('The side the link shows ("F", "B" or "FB"), when it sets one.'),
      warnings: z.array(z.string()).describe('Things the link does differently from what was asked.'),
      width: z.number().describe('Image width in pixels.'),
      height: z.number().describe('Image height in pixels.'),
    },
    annotations: { readOnlyHint: true },
  },
  // Returns the whole tool result: the image goes next to the JSON text.
  raw: true,
  handler: (ctx) => async (args) => {
    const { url, width = SIZE.width, height = SIZE.height, ...rest } = args;
    const { snapshot } = ctx;
    if (!snapshot) {
      throw new BoardError(
        'Snapshots are not set up on this server: it needs SNAPSHOT_VIEWER_URL (or VIEWER_URL), ' +
          'the viewer address it can reach itself.'
      );
    }

    let out, board, hash;
    if (url !== undefined) {
      const given = Object.keys(rest).filter((k) => rest[k] !== undefined);
      if (given.length) {
        throw new BoardError(`Give url or the link fields, not both (also got: ${given.join(', ')}).`);
      }
      ({ board, hash } = parseViewerLink(url));
      // A board that is not there would only show an empty viewer.
      await loadBoard(ctx.store, board);
      out = { url, warnings: [] };
    } else {
      if (rest.board === undefined) throw new BoardError('Give url, or board and the other link fields.');
      const made = await makeLink(ctx, rest);
      ({ board, hash } = made);
      out = { url: made.url, warnings: made.warnings };
      if (made.side) out.side = made.side;
    }
    out.width = width;
    out.height = height;

    const png = await snapshot.browser.screenshot(viewerUrl(snapshot.base, board, hash), { width, height });
    return {
      content: [
        { type: 'text', text: JSON.stringify(out) },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
      structuredContent: out,
    };
  },
};
