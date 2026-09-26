import { NextRequest, NextResponse } from 'next/server';
import { dispatchWorkflowEvent } from '@/lib/services/workflow-robot/dispatch';
import { DB_EVENT_TABLES } from '@/lib/services/workflow-robot/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const secret = request.headers.get('x-workflow-secret') || request.headers.get('authorization');
    const expected = process.env.CRON_SECRET?.trim();
    // CRON_SECRET must be configured to enable DB-event dispatch; an unset
    // secret must not make the service-role dispatcher publicly callable.
    if (!expected || (secret !== `Bearer ${expected}` && secret !== expected)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await request.json();
    if (!body.table || !body.op || !body.site_id || !body.row) {
      return NextResponse.json({ error: 'table, op, site_id, and row are required' }, { status: 400 });
    }
    if (!DB_EVENT_TABLES.includes(body.table)) {
      return NextResponse.json({ error: `Unsupported table: ${body.table}` }, { status: 400 });
    }
    const result = await dispatchWorkflowEvent({
      table: body.table,
      op: body.op,
      row: body.row,
      site_id: body.site_id,
      instance_id: body.instance_id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
