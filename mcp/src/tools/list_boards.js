import * as z from 'zod/v4';
import { listBoards } from '../boards.js';

export default {
  name: 'list_boards',
  config: {
    title: 'List boards',
    description:
      'List the boards this viewer serves. Each board has a path, which the other tools take ' +
      'to name a board, and a title from the CAD export.',
    outputSchema: {
      boards: z.array(
        z.object({
          path: z.string().describe('Board file, relative to the board folder, e.g. "lab/rev2/probe.json".'),
          title: z.string().describe('Board title from the CAD export, or the file name if it has none.'),
        })
      ),
    },
    annotations: { readOnlyHint: true },
  },
  handler: ({ store }) => async () => {
    const boards = await listBoards(store);
    return { boards };
  },
};
