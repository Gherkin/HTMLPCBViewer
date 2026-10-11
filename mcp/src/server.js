import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from './boards.js';
import { tools } from './tools/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// One MCP server with every tool registered, reading boards from store.
// baseUrl is the viewer's site root for links (a URL from parseBaseUrl in
// links.js), or undefined when the server does not know it. snapshot is
// { base, browser } for the snapshot tool: base is a viewer site root this
// server can reach itself, browser comes from createBrowser in browser.js.
// Undefined, snapshot says it is not set up.
export function createServer({ store, baseUrl, snapshot }) {
  const server = new McpServer({ name: 'htmlpcbviewer', version: pkg.version });
  const ctx = { store, baseUrl, snapshot };
  for (const tool of tools) {
    const run = tool.handler(ctx);
    server.registerTool(tool.name, tool.config, async (...args) => {
      try {
        const result = await run(...args);
        if (tool.raw) return result;
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (err) {
        if (err instanceof BoardError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        // The SDK turns this into a tool error too, but logs nothing.
        console.error(`Tool ${tool.name} failed:`, err);
        throw err;
      }
    });
  }
  return server;
}
