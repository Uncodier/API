/**
 * MCP server that exposes getAssistantTools over stdio.
 * Run from repo root: npm run mcp (or npx tsx mcp-server/index.ts).
 * Requires MCP_SITE_ID in env; MCP_USER_ID and MCP_INSTANCE_ID are optional.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const siteId = process.env.MCP_SITE_ID;
const userId = process.env.MCP_USER_ID;
const instanceId = process.env.MCP_INSTANCE_ID ?? 'default';
const apiUrl = process.env.API_URL || 'http://localhost:3000';

// Set the API URL for tools that use it (e.g. ImageGenerationService)
process.env.API_URL = apiUrl;
process.env.NEXT_PUBLIC_API_SERVER_URL = apiUrl;
process.env.NEXT_PUBLIC_API_URL = apiUrl;
process.env.NEXT_PUBLIC_APP_URL = apiUrl;
console.error(`[MCP] Using API URL: ${apiUrl}`);

if (!siteId) {
  console.error('MCP_SITE_ID is required. Set it in .env or the environment.');
  process.exit(1);
}

// Import createMcpServer dynamically to ensure env vars are set before module evaluation
async function main() {
  const { createMcpServer } = await import('@/lib/mcp/server');
  const server = createMcpServer(siteId!, userId, instanceId);
  const transport = new StdioServerTransport();

  // Force the process to exit when the client disconnects
  transport.onclose = () => {
    console.error('[MCP] Transport closed. Shutting down process.');
    process.exit(0);
  };

  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to connect:', err);
  process.exit(1);
});
