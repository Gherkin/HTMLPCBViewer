// How the tool tests reach the server. The same test cases run once per
// way the server runs; MCP_TEST_MODE picks one (npm test runs both):
//
//   http   (default) as in Docker: MCP over Streamable HTTP, boards read
//          from disk by diskStore.
//   stdio  as for a static site: boards read by httpStore from a static
//          file server on the board folder's parent (no directory
//          listing, ETag and 304 like GitHub Pages). The MCP messages go
//          through an in-memory pair; stdio.test.js starts the real
//          --stdio process.
//
// Tests write board files to disk in both modes; in stdio mode the next
// call sees them through the site, the way a rebuilt site shows up.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { diskStore, httpStore } from '../src/boards.js';
import { createHttpServer, MCP_PATH } from '../src/http.js';
import { boardsUrl } from '../src/links.js';
import { createServer } from '../src/server.js';

export const MODE = process.env.MCP_TEST_MODE === 'stdio' ? 'stdio' : 'http';

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };

// A static file server on root, as a static host serves a site: files only,
// "dir/" serves dir/index.html, no listing. ETag is a content hash, so a
// rewrite shows up even within the same millisecond. requests counts the
// answers by status, for the cache tests.
export function serveSite(root) {
  const requests = {};
  const server = http.createServer((req, res) => {
    const answer = (status, headers, body) => {
      requests[status] = (requests[status] ?? 0) + 1;
      res.writeHead(status, headers).end(body);
    };
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      answer(404);
      return;
    }
    const body = fs.readFileSync(file);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) {
      answer(304, { ETag: etag });
      return;
    }
    answer(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', ETag: etag }, body);
  });
  server.requests = requests;
  return server;
}

// Listen on a free local port; the server's root URL.
export async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return new URL(`http://127.0.0.1:${server.address().port}/`);
}

export async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// An MCP server on the boards in the folder pcbs, in MODE. baseUrl and
// snapshot as for createServer. Returns:
//   call(name, args)  one tool call, from a fresh client
//   mcpUrl            the /mcp URL (http mode only)
//   site              the static site server (stdio mode only)
//   close()
export async function startMcp({ pcbs, baseUrl, snapshot }) {
  const connectAnd = async (transport, fn) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  };

  if (MODE === 'http') {
    const server = createHttpServer({ store: diskStore(pcbs), baseUrl, snapshot });
    const mcpUrl = new URL(MCP_PATH, await listen(server));
    const withClient = (fn) => connectAnd(new StreamableHTTPClientTransport(mcpUrl), fn);
    return {
      withClient,
      call: (name, args) => withClient((c) => c.callTool({ name, arguments: args })),
      mcpUrl,
      close: () => closeServer(server),
    };
  }

  // The site root holds pcbs/, as main.js expects of --site.
  if (path.basename(pcbs) !== 'pcbs') throw new Error(`the board folder must be named pcbs: ${pcbs}`);
  const site = serveSite(path.dirname(pcbs));
  const siteUrl = await listen(site);
  // One store for every call, so its cache works across calls as it does
  // in the one long-running stdio process.
  const store = httpStore(boardsUrl(siteUrl));
  const withClient = async (fn) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createServer({ store, baseUrl, snapshot });
    await server.connect(serverSide);
    try {
      return await connectAnd(clientSide, fn);
    } finally {
      await server.close();
    }
  };
  return {
    withClient,
    call: (name, args) => withClient((c) => c.callTool({ name, arguments: args })),
    site,
    siteUrl,
    close: () => closeServer(site),
  };
}
