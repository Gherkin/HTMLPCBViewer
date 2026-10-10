// Entry point for the HTTP server.
//   PCBS_DIR  board folder, the one build_boards.py writes (default /pcbs)
//   PORT      listen port (default 3000)

import { diskStore } from './boards.js';
import { createHttpServer, MCP_PATH } from './http.js';

const store = diskStore(process.env.PCBS_DIR || '/pcbs');
const port = Number(process.env.PORT || 3000);

const server = createHttpServer({ store });
server.listen(port, () => {
  console.log(`MCP on port ${port} at ${MCP_PATH}, boards from ${store.where}`);
});

// In a container node runs as PID 1, which ignores SIGTERM unless handled.
// close() drops idle connections and lets requests in progress finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
