// Board loading. Tools read boards only through a store, so they do not
// care where the files live. A store has one method, readJson(relPath), with
// relPath relative to the board folder (the folder that holds index.json).
//
// diskStore reads the mounted pcbs/ folder. A store that fetches the same
// files from a static site over HTTP only has to provide readJson too.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const INDEX_NAME = 'index.json';

// An error the agent should see as a tool error, with a message it can act
// on. Anything else is a bug and goes to the server log.
export class BoardError extends Error {}

export function diskStore(root) {
  const base = path.resolve(root);
  return {
    where: base,
    async readJson(relPath) {
      const file = path.resolve(base, relPath);
      if (!file.startsWith(base + path.sep)) {
        throw new BoardError(`Path is outside the board folder: ${relPath}`);
      }
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') throw new BoardError(`Not found: ${relPath}`);
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new BoardError(`Not valid JSON: ${relPath}`);
      }
    },
  };
}

// Every board in the folder, as [{ path, title }], in index order. The list
// comes from index.json, which build_boards.py writes on every run. It is read
// on each call, so a rebuild shows up without a restart.
export async function listBoards(store) {
  let index;
  try {
    index = await store.readJson(INDEX_NAME);
  } catch (err) {
    if (err instanceof BoardError) {
      throw new BoardError(
        `Cannot read the board list (${err.message}). Run build_boards.py; it writes ${INDEX_NAME}.`
      );
    }
    throw err;
  }
  if (!index || !Array.isArray(index.boards)) {
    throw new BoardError(`${INDEX_NAME} has no board list.`);
  }
  return index.boards
    .filter((b) => b && typeof b.path === 'string' && typeof b.title === 'string')
    .map((b) => ({ path: b.path, title: b.title }));
}

// One board payload (what generate.py --split writes), by its path from
// list_boards. It is read on each call, so a rebuild shows up without a
// restart.
export async function loadBoard(store, boardPath) {
  let board;
  try {
    board = await store.readJson(boardPath);
  } catch (err) {
    if (err instanceof BoardError) {
      throw new BoardError(`Cannot read board "${boardPath}" (${err.message}). list_boards gives the valid paths.`);
    }
    throw err;
  }
  if (!board || !Array.isArray(board.footprints)) {
    throw new BoardError(`"${boardPath}" is not a board payload: it has no footprint list.`);
  }
  return board;
}
