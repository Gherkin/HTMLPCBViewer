// Every tool the server offers. A tool module exports
//   { name, config, handler }
// config is the SDK's registerTool config (title, description, inputSchema,
// outputSchema, annotations). handler(ctx) returns the tool function; ctx
// holds the board store. The tool function returns a plain object, which the
// server sends as both structured content and JSON text. To add a tool,
// write its module and list it here.

import listBoards from './list_boards.js';
import locate from './locate.js';

export const tools = [listBoards, locate];
