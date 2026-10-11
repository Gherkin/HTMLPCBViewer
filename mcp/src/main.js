// Entry point. One server, run two ways:
//
// HTTP (Docker), the default: MCP at /mcp, boards from a folder.
//   PCBS_DIR  board folder, the one build_boards.py writes (default /pcbs)
//   PORT        listen port (default 3000)
//   VIEWER_URL  the board list page's address as users open it, e.g.
//               http://pcbhost:1010/, for the links the link tool makes.
//               Unset: links start at /viewer/ and the tool says so.
//   SNAPSHOT_VIEWER_URL
//               the same site as this server reaches it, for the snapshot
//               tool's browser, e.g. http://pcb-viewer/ in docker-compose.
//               Unset: VIEWER_URL is used. Both unset: snapshot says it is
//               not set up. It never shows up in a link.
//
// stdio, for a static site: node src/main.js --stdio --site <url>
//   The agent starts it and talks over stdin/stdout. <url> is the site
//   root, the folder that holds viewer/ and pcbs/ (e.g.
//   https://<user>.github.io/<repo>/). Boards are read from <url>pcbs/ and
//   links point at <url>viewer/. SNAPSHOT_VIEWER_URL works as above;
//   unset, snapshot opens <url> itself. Logs go to stderr: stdout is MCP.

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BoardError, diskStore, httpStore } from './boards.js';
import { createBrowser, sandboxFromEnv } from './browser.js';
import { createHttpServer, MCP_PATH } from './http.js';
import { boardsUrl, parseBaseUrl } from './links.js';
import { createServer } from './server.js';

const USAGE = 'Usage: node src/main.js                      (HTTP, see PCBS_DIR, PORT, VIEWER_URL)\n' +
  '       node src/main.js --stdio --site <url>   (stdio, boards from a static site)';

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({ options: { stdio: { type: 'boolean' }, site: { type: 'string' } } }).values;
} catch (err) {
  fail(err.message);
}

// A bad URL stops the server here, not on the first tool call.
function baseFrom(value, what) {
  try {
    return parseBaseUrl(value, what);
  } catch (err) {
    if (err instanceof BoardError) fail(err.message);
    throw err;
  }
}

const snapshotEnv = process.env.SNAPSHOT_VIEWER_URL
  ? baseFrom(process.env.SNAPSHOT_VIEWER_URL, 'SNAPSHOT_VIEWER_URL')
  : undefined;
const browser = createBrowser({ sandbox: sandboxFromEnv(process.env) });

// Close the browser, then exit. stop() lets the transport finish first.
let stopping = false;
function shutdown(stop) {
  if (stopping) return;
  stopping = true;
  stop(() => browser.close().finally(() => process.exit(0)));
}

if (args.stdio) {
  if (!args.site) fail('--stdio needs --site <url>.');
  const site = baseFrom(args.site, '--site');
  const store = httpStore(boardsUrl(site));
  const snapshotBase = snapshotEnv ?? site;
  const server = createServer({ store, baseUrl: site, snapshot: { base: snapshotBase, browser } });
  await server.connect(new StdioServerTransport());
  console.error(`MCP on stdio, boards from ${store.where}, links to ${site}, snapshots from ${snapshotBase}`);
  // The agent closes stdin when it is done with the server.
  const stop = (done) => server.close().finally(done);
  process.stdin.on('end', () => shutdown(stop));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(stop));
} else {
  if (args.site) fail('--site needs --stdio.');
  const store = diskStore(process.env.PCBS_DIR || '/pcbs');
  const port = Number(process.env.PORT || 3000);
  const baseUrl = process.env.VIEWER_URL ? baseFrom(process.env.VIEWER_URL, 'VIEWER_URL') : undefined;
  const snapshotBase = snapshotEnv ?? baseUrl;
  const snapshot = snapshotBase ? { base: snapshotBase, browser } : undefined;

  const server = createHttpServer({ store, baseUrl, snapshot });
  server.listen(port, () => {
    console.log(
      `MCP on port ${port} at ${MCP_PATH}, boards from ${store.where}, ` +
        `links to ${baseUrl ?? '/ (VIEWER_URL not set)'}, ` +
        `snapshots from ${snapshotBase ?? 'nowhere (SNAPSHOT_VIEWER_URL and VIEWER_URL not set)'}`
    );
  });
  // Stop cleanly on SIGTERM (docker stop) and SIGINT. close() drops idle
  // connections and lets requests in progress finish; then the browser goes.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown((done) => server.close(done)));
}
