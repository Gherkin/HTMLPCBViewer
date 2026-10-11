// Entry point for the HTTP server.
//   PCBS_DIR  board folder, the one build_boards.py writes (default /pcbs)
//   PORT        listen port (default 3000)
//   VIEWER_URL  the viewer's address as users open it, e.g.
//               http://pcbhost:1010/, for the links the link tool makes.
//               Unset: links start at /viewer/ and the tool says so.

import { diskStore } from './boards.js';
import { createHttpServer, MCP_PATH } from './http.js';
import { parseBaseUrl } from './links.js';

const store = diskStore(process.env.PCBS_DIR || '/pcbs');
const port = Number(process.env.PORT || 3000);
// A bad VIEWER_URL stops the server here, not on the first link.
const baseUrl = process.env.VIEWER_URL ? parseBaseUrl(process.env.VIEWER_URL, 'VIEWER_URL') : undefined;

const server = createHttpServer({ store, baseUrl });
server.listen(port, () => {
  console.log(`MCP on port ${port} at ${MCP_PATH}, boards from ${store.where}, links to ${baseUrl ?? '/ (VIEWER_URL not set)'}`);
});

// In a container node runs as PID 1, which ignores SIGTERM unless handled.
// close() drops idle connections and lets requests in progress finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
