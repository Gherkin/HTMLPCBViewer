// Entry point for the HTTP server.
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

import { diskStore } from './boards.js';
import { createBrowser } from './browser.js';
import { createHttpServer, MCP_PATH } from './http.js';
import { parseBaseUrl } from './links.js';

const store = diskStore(process.env.PCBS_DIR || '/pcbs');
const port = Number(process.env.PORT || 3000);
// A bad VIEWER_URL stops the server here, not on the first link.
const baseUrl = process.env.VIEWER_URL ? parseBaseUrl(process.env.VIEWER_URL, 'VIEWER_URL') : undefined;
const snapshotBase = process.env.SNAPSHOT_VIEWER_URL
  ? parseBaseUrl(process.env.SNAPSHOT_VIEWER_URL, 'SNAPSHOT_VIEWER_URL')
  : baseUrl;
const browser = createBrowser();
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
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      browser.close().finally(() => process.exit(0));
    });
  });
}
