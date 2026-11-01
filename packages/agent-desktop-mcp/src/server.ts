import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { handleToolCall } from './dispatch.ts';
import { DESKTOP_TOOLS, SERVER_INSTRUCTIONS } from './tools.ts';

const SERVER_NAME = 'open-design-agent-desktop';
const SERVER_VERSION = '0.1.0';

export async function runStdioServer(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DESKTOP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    return handleToolCall(request.params.name, args, { signal: extra.signal });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
