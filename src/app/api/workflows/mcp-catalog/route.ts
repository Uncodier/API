import { NextResponse } from 'next/server';
import { getAssistantToolDefinitions } from '@/app/api/robots/instance/assistant/utils';
import { listMcpCatalog } from '@/lib/services/workflow-robot/mcp-catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  const tools = getAssistantToolDefinitions(
    'workflow-catalog',
    undefined,
    'workflow-catalog',
  );
  return NextResponse.json({
    success: true,
    tools: listMcpCatalog(tools),
  });
}
