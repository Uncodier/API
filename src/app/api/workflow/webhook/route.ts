import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkflowService } from '@/lib/services/workflow-service';

type TableRecord<T = any> = T & { id?: string };

type InsertPayload<T = any> = {
  type: 'INSERT';
  table: string;
  schema: string;
  record: TableRecord<T>;
  old_record: null;
};

type UpdatePayload<T = any> = {
  type: 'UPDATE';
  table: string;
  schema: string;
  record: TableRecord<T>;
  old_record: TableRecord<T>;
};

type DeletePayload<T = any> = {
  type: 'DELETE';
  table: string;
  schema: string;
  record: null;
  old_record: TableRecord<T>;
};

type DbChangePayload = InsertPayload | UpdatePayload | DeletePayload;

function toEventType(changeType: DbChangePayload['type']): 'created' | 'updated' | 'deleted' {
  switch (changeType) {
    case 'INSERT':
      return 'created';
    case 'UPDATE':
      return 'updated';
    case 'DELETE':
      return 'deleted';
  }
}

function buildSubscriptionEvent(table: string, eventType: ReturnType<typeof toEventType>): { primary: string; aliases: string[] } {
  const primary = `${table}.${eventType}`;
  const aliases: string[] = [];
  if (table.endsWith('s') && table.length > 1) {
    aliases.push(`${table.slice(0, -1)}.${eventType}`);
  }
  return { primary, aliases };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DbChangePayload;

    if (!body || !('type' in body) || !('table' in body)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_PAYLOAD', message: 'Missing type/table in payload' } },
        { status: 400 }
      );
    }

    const eventType = toEventType(body.type);
    const { primary: event, aliases } = buildSubscriptionEvent(body.table, eventType);

    const currentRecord = body.type === 'DELETE' ? body.old_record : body.record;
    const site_id = (currentRecord as any)?.site_id as string | undefined;
    const object_id = (currentRecord as any)?.id as string | undefined;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_SITE_ID', message: 'record must include site_id' } },
        { status: 400 }
      );
    }

    const eventsToCheck = [event, ...aliases];
    console.log('[webhook] site_id:', site_id, 'table:', body.table, 'type:', body.type, 'events:', eventsToCheck);

    // Attempt querying across potential table names to avoid naming mismatches
    const candidateTables = [
      'webhook_suscription', // requested by user
      'webhooks_subscriptions', // documented variant
      'webhook_subscriptions', // common variant
      'webhooks_suscriptions', // plural + typo variant
    ];

    let subscriptions: any[] | null = null;
    let subError: any = null;
    let usedTable: string | null = null;

    for (const tableName of candidateTables) {
      const { data, error } = await supabaseAdmin
        .from(tableName)
        .select('id, endpoint_id, event_type, is_active')
        .eq('site_id', site_id)
        .in('event_type', eventsToCheck)
        .eq('is_active', true);

      if (error) {
        // Try next candidate if table missing or other errors
        subError = error;
        continue;
      }

      subscriptions = data || [];
      usedTable = tableName;
      break;
    }

    if (subscriptions === null) {
      console.error('[webhook] Failed querying subscription tables. Last error:', subError);
      return NextResponse.json(
        { success: false, error: { code: 'DB_ERROR', message: 'Failed to query subscriptions' } },
        { status: 500 }
      );
    }

    const foundWebhook = Array.isArray(subscriptions) && subscriptions.length > 0;
    console.log('[webhook] table_used:', usedTable, 'found_webhook:', foundWebhook);

    if (!subscriptions || subscriptions.length === 0) {
      console.log('[webhook] No subscriptions found for events:', eventsToCheck);
      return NextResponse.json({ success: true, data: { triggered: 0, table_used: usedTable } }, { status: 200 });
    }

    console.log('[webhook] Subscriptions found:', subscriptions.length, 'table_used:', usedTable);

    const workflowService = WorkflowService.getInstance();
    const workflowArgs = {
      site_id,
      table: body.table,
      object_id: object_id || null,
      event_type: body.type === 'INSERT' ? 'CREATE' : body.type,
      event,
      subscription_ids: subscriptions.map((s: any) => s.id),
    };

    workflowService.executeWorkflow('webhookDispatchWorkflow', workflowArgs, {
      async: true,
      priority: 'low',
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `webhook-${site_id}-${body.table}-${Date.now()}`,
    })
      .then((res) => {
        if (!res?.success) {
          console.error('[webhook] Failed to start Temporal workflow:', res?.error);
        } else {
          console.log('[webhook] Temporal start ok:', { workflowId: res.workflowId, runId: res.runId });
        }
      })
      .catch((err) => {
        console.error('[webhook] Error starting Temporal workflow:', err);
      });

    return NextResponse.json(
      {
        success: true,
        data: {
          triggered: subscriptions.length,
          site_id,
          event,
        },
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('Error in /api/workflow/webhook:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Unhandled error' } },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    name: 'workflow webhook dispatcher',
    description:
      'Receives DB change events, finds active subscriptions by site and table, and dispatches a Temporal workflow asynchronously.',
    methods: ['POST'],
    expectedPayload:
      '{ type: INSERT|UPDATE|DELETE, table: string, schema: string, record|old_record contain site_id and id }',
  });
}


