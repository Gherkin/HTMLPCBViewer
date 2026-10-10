// MCP over Streamable HTTP at /mcp. Stateless: every POST gets its own
// server and transport, so there are no sessions to keep and any number of
// users can share one process.

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

export const MCP_PATH = '/mcp';

function sendJsonRpcError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export function createHttpServer({ store }) {
  return http.createServer(async (req, res) => {
    // Not new URL(): it throws on a malformed target such as "//[".
    const pathname = req.url.split('?')[0];
    if (pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    // GET would open a stream for server-sent messages, and DELETE ends a
    // session. A stateless server has neither.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJsonRpcError(res, 405, 'Method not allowed.');
      return;
    }
    const server = createServer({ store });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal server error');
    }
  });
}
