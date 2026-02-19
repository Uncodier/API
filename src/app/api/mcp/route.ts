/**
 * POST /api/mcp — MCP over HTTP (Streamable HTTP, JSON response mode).
 * Auth: same API keys as middleware — Authorization: Bearer <key> or X-API-Key: <key>.
 * Valid keys: SERVICE_API_KEY (env) or keys from DB (api_keys table via ApiKeyService).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createMcpServer } from '@/lib/mcp/server';
import { validateMcpApiKey } from '@/lib/mcp/auth';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!(await validateMcpApiKey(request))) {
    return NextResponse.json(
      { error: 'Missing or invalid API key. Use Authorization: Bearer <key> or X-API-Key: <key>.' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    );
  }

  const siteId = process.env.MCP_SITE_ID;
  if (!siteId) {
    return NextResponse.json(
      { error: 'MCP_SITE_ID is not configured on the server.' },
      { status: 503 }
    );
  }

  const userId = process.env.MCP_USER_ID;
  const instanceId = process.env.MCP_INSTANCE_ID ?? 'default';

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
