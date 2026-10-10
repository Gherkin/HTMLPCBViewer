import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from './boards.js';
import { tools } from './tools/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// One MCP server with every tool registered, reading boards from store.
export function createServer({ store }) {
  const server = new McpServer({ name: 'htmlpcbviewer', version: pkg.version });
  const ctx = { store };
  for (const tool of tools) {
    const run = tool.handler(ctx);
    server.registerTool(tool.name, tool.config, async (...args) => {
      try {
        const result = await run(...args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (err) {
        if (err instanceof BoardError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    });
  }
  return server;
}
