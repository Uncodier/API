/**
 * POST /api/mcp — MCP over HTTP (Streamable HTTP, JSON response mode).
 * Auth: same API keys as middleware — Authorization: Bearer <key> or X-API-Key: <key>.
 * Valid keys: SERVICE_API_KEY (env) or keys from DB (api_keys table via ApiKeyService).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createMcpServer } from '@/lib/mcp/server';
import { validateMcpApiKey } from '@/lib/mcp/auth';
import { mcpContextSchema } from '@/lib/mcp/context';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!(await validateMcpApiKey(request))) {
    return NextResponse.json(
      { error: 'Missing or invalid API key. Use Authorization: Bearer <key> or X-API-Key: <key>.' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    );
  }

  const siteHeader = request.headers.get('x-mcp-site-id');
  const instanceHeader = request.headers.get('x-mcp-instance-id');
  const context = mcpContextSchema.safeParse({
    siteId: siteHeader ?? process.env.MCP_SITE_ID,
    instanceId: instanceHeader ?? process.env.MCP_INSTANCE_ID,
  });
  if (!context.success) {
    const field = context.error.issues[0].path[0];
    const fromHeader = field === 'siteId' ? siteHeader !== null : instanceHeader !== null;
    return NextResponse.json(
      { error: field === 'siteId'
        ? 'MCP_SITE_ID / x-mcp-site-id must be a valid site UUID.'
        : 'MCP_INSTANCE_ID / x-mcp-instance-id must be a valid instance UUID or "default" (no instance history).' },
      { status: fromHeader ? 400 : 503 }
    );
  }

  const { siteId, instanceId } = context.data;
  const userId = request.headers.get('x-mcp-user-id') || process.env.MCP_USER_ID;

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body.' },
      { status: 400 }
    );
  }

  const server = createMcpServer(siteId, userId, instanceId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  const response = await transport.handleRequest(request, {
    parsedBody,
  });

  return response;
}

export async function GET() {
  return NextResponse.json(
    {
      message: 'MCP endpoint. Use POST with JSON-RPC body. Send API key via Authorization: Bearer <key> or X-API-Key.',
    },
    { status: 200 }
  );
}
