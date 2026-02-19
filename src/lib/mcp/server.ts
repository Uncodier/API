/**
 * Shared MCP server factory: builds a Server with tools/list and tools/call handlers
 * using getAssistantTools. Used by both stdio (mcp-server/index.ts) and HTTP (api/mcp/route.ts).
 */

import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function getInputSchema(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | z.ZodType<unknown>;
}): Record<string, unknown> {
  const params = tool.parameters;
  if (!params) {
    return { type: 'object', properties: {} };
  }
  const isZod =
    typeof params === 'object' && params !== null && '_def' in params;
  if (isZod) {
    return zodToJsonSchema(params as z.ZodType<unknown>, {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
  }
  return (params as Record<string, unknown>) ?? { type: 'object', properties: {} };
}

/**
 * Creates an MCP Server with tools/list and tools/call handlers for the given context.
 */
export function createMcpServer(
  siteId: string,
  userId: string | undefined,
  instanceId: string
): Server {
  const tools = getAssistantTools(siteId, userId, instanceId);

  const server = new Server(
    {
      name: 'uncodie-tools',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: getInputSchema(tool),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool?.execute) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute(args ?? {});
      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      };
    }
  });

  return server;
}
