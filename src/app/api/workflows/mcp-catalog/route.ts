import { NextResponse } from 'next/server';
import { listMcpCatalog } from '@/lib/services/workflow-robot/mcp-catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ success: true, tools: listMcpCatalog() });
}
