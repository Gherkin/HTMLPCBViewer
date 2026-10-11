// Board loading. Tools read boards only through a store, so they do not
// care where the files live. A store has one method, readJson(relPath), with
// relPath relative to the board folder (the folder that holds index.json).
//
// diskStore reads the mounted pcbs/ folder (Docker). httpStore fetches the
// same files from a static site (stdio mode).
//
// A store may hand out the same object on every call, so tools must not
// change a board they read.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const INDEX_NAME = 'index.json';

// httpStore limits. A board payload is up to ~20 MB.
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_CACHE_BYTES = 256 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30000;

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

// The board folder of a static site, read over HTTP. root is a URL whose
// path ends in "/" (the site's pcbs/ folder). A site has no directory
// listing, so the store only fetches index.json and the paths it lists.
//
// Cache: each file is kept, parsed, with its ETag and Last-Modified. Every
// read asks the site again with If-None-Match / If-Modified-Since, so a
// rebuilt site shows up on the next call; an unchanged file costs one small
// 304 answer instead of a 20 MB download. A file the site sends without
// either header is not cached. The cache holds up to maxCacheBytes of file
// text and drops the least recently used file first. A file larger than
// maxFileBytes, or one that takes longer than timeoutMs, is a tool error.
export function httpStore(
  root,
  {
    fetch: doFetch = globalThis.fetch,
    maxFileBytes = MAX_FILE_BYTES,
    maxCacheBytes = MAX_CACHE_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = {}
) {
  const base = new URL(root);
  const cache = new Map(); // href -> { etag, lastModified, json, bytes }, oldest use first
  let cachedBytes = 0;

  const drop = (href) => {
    const hit = cache.get(href);
    if (hit) {
      cachedBytes -= hit.bytes;
      cache.delete(href);
    }
  };
  const keep = (href, entry) => {
    drop(href);
    if (entry.bytes > maxCacheBytes) return;
    cache.set(href, entry);
    cachedBytes += entry.bytes;
    for (const old of cache.keys()) {
      if (cachedBytes <= maxCacheBytes) break;
      drop(old);
    }
  };

  async function readBody(res, relPath) {
    const tooBig = () => new BoardError(`${relPath} is larger than ${maxFileBytes / 1024 / 1024} MB.`);
    const length = Number(res.headers.get('content-length'));
    if (length > maxFileBytes) {
      await res.body?.cancel();
      throw tooBig();
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > maxFileBytes) {
        await res.body.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  return {
    where: base.href,
    async readJson(relPath) {
      const parts = relPath.split('/');
      if (parts.some((p) => p === '' || p === '.' || p === '..')) {
        throw new BoardError(`Path is outside the board folder: ${relPath}`);
      }
      const url = new URL(parts.map(encodeURIComponent).join('/'), base);
      const hit = cache.get(url.href);
      const headers = {};
      if (hit?.etag) headers['If-None-Match'] = hit.etag;
      if (hit?.lastModified) headers['If-Modified-Since'] = hit.lastModified;

      let res, body;
      try {
        // One deadline for the answer and the whole body.
        const signal = AbortSignal.timeout(timeoutMs);
        res = await doFetch(url, { headers, signal });
        if (res.status === 304 && hit) {
          // Most recently used goes last.
          cache.delete(url.href);
          cache.set(url.href, hit);
          return hit.json;
        }
        if (res.status === 404 || res.status === 410) {
          drop(url.href);
          await res.body?.cancel();
          throw new BoardError(`Not found: ${relPath}`);
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new BoardError(`${relPath}: ${base.origin} answered ${res.status} ${res.statusText}`.trim());
        }
        body = await readBody(res, relPath);
      } catch (err) {
        if (err instanceof BoardError) throw err;
        if (err.name === 'TimeoutError') {
          throw new BoardError(`${relPath}: no full answer from ${base.origin} within ${timeoutMs / 1000} s.`);
        }
        // fetch puts the network reason (DNS, refused, TLS) in cause.
        throw new BoardError(`Cannot fetch ${relPath} from ${base.origin}: ${err.cause?.message ?? err.message}`);
      }
      let json;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        throw new BoardError(`Not valid JSON: ${relPath}`);
      }
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (etag || lastModified) keep(url.href, { etag, lastModified, json, bytes: body.length });
      else drop(url.href);
      return json;
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
