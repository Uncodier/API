/**
 * MCP server that exposes getAssistantTools over stdio.
 * Run from repo root: npm run mcp (or npx tsx mcp-server/index.ts).
 * Requires MCP_SITE_ID in env; MCP_USER_ID and MCP_INSTANCE_ID are optional.
 */

import { createMcpServer } from '@/lib/mcp/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const siteId = process.env.MCP_SITE_ID;
const userId = process.env.MCP_USER_ID;
const instanceId = process.env.MCP_INSTANCE_ID ?? 'default';

if (!siteId) {
  console.error('MCP_SITE_ID is required. Set it in .env or the environment.');
  process.exit(1);
}

const server = createMcpServer(siteId, userId, instanceId);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
