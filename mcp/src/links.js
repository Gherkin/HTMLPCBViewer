// Viewer links: the URL hash and the page address around it. Every tool that
// makes a link goes through here, so the base URL is handled in one place.
//
// The hash is the readable form the viewer writes (web/util.js,
// formatHashPairs). The viewer compresses long hashes into z= when it writes
// one, but reads the readable form at any length, so links stay readable.
//
// The base URL is the site root: the folder that holds viewer/ and pcbs/,
// e.g. "http://host:1010/" or "https://example.org/pcb/". The board opens as
// <root>viewer/?data=<root path>pcbs/<board>, the same link the board list
// page (docker/index.html) makes. That holds for the Docker server and for a
// static site with the same layout. The server's own base comes from its
// config (VIEWER_URL in Docker); a base_url given to a tool wins over it.

import { BoardError } from './boards.js';

// Like encodeURIComponent, but keeps / : , @ readable. They are legal in a
// fragment and common in net names. Same as encodeHashPart in web/util.js.
export function encodeHashPart(s) {
  return encodeURIComponent(s).replace(/%(2F|3A|2C|40)/gi, decodeURIComponent);
}

// [[key, value], ...] to "key=value&...". Same as formatHashPairs in web/util.js.
export function formatHashPairs(pairs) {
  return pairs.map((p) => encodeHashPart(p[0]) + '=' + encodeHashPart(p[1])).join('&');
}

// A site root as a URL object with a path ending in "/", or a tool error.
// what names the value in the message.
export function parseBaseUrl(base, what) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new BoardError(`${what} is not an absolute URL: "${base}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BoardError(`${what} must be an http or https URL: "${base}".`);
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

// The link to board (a path from list_boards) with hash. base is a URL from
// parseBaseUrl; without one the link is root-relative ("/viewer/?...").
export function viewerUrl(base, board, hash) {
  const root = base ? base.pathname : '/';
  const data = encodeURIComponent(root + 'pcbs/' + board).replace(/%2F/gi, '/');
  const page = `${root}viewer/?data=${data}${hash ? '#' + hash : ''}`;
  return base ? base.origin + page : page;
}

// The board and hash of a viewer link, as viewerUrl makes it: absolute with
// any site root, or root-relative. The host is not used, so a link can be
// opened on another address of the same site. A tool error if the link does
// not have that shape.
export function parseViewerLink(link) {
  const bad = (why) =>
    new BoardError(`url is not a viewer link (${why}): "${link}". Make one with the link tool.`);
  let url;
  try {
    url = new URL(link, 'http://site.invalid/');
  } catch {
    throw bad('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('not http or https');
  if (!url.pathname.endsWith('/viewer/')) throw bad('the page is not .../viewer/');
  const root = url.pathname.slice(0, -'viewer/'.length);
  const data = url.searchParams.get('data');
  if (!data || !data.startsWith(root + 'pcbs/')) throw bad(`data= is not a board under ${root}pcbs/`);
  const board = data.slice((root + 'pcbs/').length);
  if (!board) throw bad('no board');
  return { board, hash: url.hash.replace(/^#/, '') };
}
