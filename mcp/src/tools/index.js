// Every tool the server offers. A tool module exports
//   { name, config, handler }
// config is the SDK's registerTool config (title, description, inputSchema,
// outputSchema, annotations). handler(ctx) returns the tool function; ctx
// holds the board store and the viewer's base URL for links. The tool function returns a plain object, which the
// server sends as both structured content and JSON text. To add a tool,
// write its module and list it here.

import link from './link.js';
import listBoards from './list_boards.js';
import locate from './locate.js';
import nearest from './nearest.js';
import nearestVias from './nearest_vias.js';
import netPlaces from './net_places.js';

export const tools = [listBoards, locate, netPlaces, nearest, nearestVias, link];
