import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { canAccessSite } from '@/lib/security/site-access';
import {
  buildWebhookEventNames,
  isSupportedWebhookTable,
  type WebhookMutationEvent,
} from '@/lib/webhooks/event-names';

type TestOperation = 'INSERT' | 'UPDATE' | 'DELETE';

interface TestWebhookBody {
  endpoint_id?: unknown;
  site_id?: unknown;
  operation?: unknown;
  table?: unknown;
  record?: unknown;
}

const EVENT_BY_OPERATION: Record<TestOperation, WebhookMutationEvent> = {
  INSERT: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTestOperation(value: string): value is TestOperation {
  return Object.prototype.hasOwnProperty.call(EVENT_BY_OPERATION, value);
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status },
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as TestWebhookBody;
    const endpointId = typeof body.endpoint_id === 'string' ? body.endpoint_id : '';
    const siteId = typeof body.site_id === 'string' ? body.site_id : '';
    const requestedOperation = typeof body.operation === 'string'
      ? body.operation.toUpperCase()
      : '';
    const table = typeof body.table === 'string' ? body.table : '';

    if (!endpointId || !siteId || !requestedOperation || !table) {
      return errorResponse(
        400,
        'INVALID_PAYLOAD',
        'endpoint_id, site_id, operation, and table are required',
      );
    }
    if (!isTestOperation(requestedOperation)) {
      return errorResponse(400, 'INVALID_OPERATION', `Unsupported operation: ${requestedOperation}`);
    }
    const operation = requestedOperation;
    if (!isSupportedWebhookTable(table)) {
      return errorResponse(400, 'INVALID_TABLE', `Unsupported table: ${table}`);
    }
    if (!await canAccessSite(request, siteId)) {
      return errorResponse(403, 'FORBIDDEN', 'You do not have access to this site');
    }
    if (operation !== 'INSERT' && !isRecord(body.record)) {
      return errorResponse(400, 'MISSING_RECORD', 'A record is required for UPDATE and DELETE tests');
    }

    const inputRecord = isRecord(body.record) ? body.record : {};
    if (typeof inputRecord.site_id === 'string' && inputRecord.site_id !== siteId) {
      return errorResponse(400, 'SITE_MISMATCH', 'The selected record belongs to another site');
    }

    const record = {
      ...inputRecord,
      id: typeof inputRecord.id === 'string' ? inputRecord.id : randomUUID(),
      site_id: siteId,
    };
    const { canonical: event } = buildWebhookEventNames(
      table,
      EVENT_BY_OPERATION[operation],
    );

    const { data: endpoint, error } = await supabaseAdmin
      .from('webhooks_endpoints')
      .select('id, site_id, target_url, secret')
      .eq('id', endpointId)
      .eq('site_id', siteId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load webhook endpoint: ${error.message}`);
    }
    if (!endpoint) {
      return errorResponse(404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint not found');
    }

    let targetUrl: URL;
    try {
      targetUrl = await assertSafeRemoteUrl(endpoint.target_url);
    } catch (error) {
      return errorResponse(
        400,
        'UNSAFE_TARGET_URL',
        error instanceof Error ? error.message : 'Webhook target URL is not allowed',
      );
    }

    const deliveryId = randomUUID();
    const payload = {
      id: deliveryId,
      type: event,
      site_id: siteId,
      table,
      object_id: record.id,
      data: record,
      attempt: 1,
      test: true,
      timestamp: new Date().toISOString(),
    };
    const serializedPayload = JSON.stringify(payload);
    const signature = endpoint.secret
      ? createHmac('sha256', endpoint.secret).update(serializedPayload).digest('hex')
      : null;

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
          'X-Webhook-Delivery': deliveryId,
          'X-Webhook-Test': 'true',
          ...(signature ? { 'X-Webhook-Signature': signature } : {}),
        },
        body: serializedPayload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      return errorResponse(
        502,
        'DELIVERY_FAILED',
        error instanceof Error ? error.message : 'Webhook delivery failed',
      );
    }

    if (!response.ok) {
      return errorResponse(
        502,
        'DELIVERY_REJECTED',
        `Webhook endpoint returned HTTP ${response.status}`,
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        delivered: true,
        delivery_id: deliveryId,
        event,
        response_status: response.status,
      },
    });
  } catch (error) {
    console.error('[WebhookTest]', error);
    return errorResponse(
      500,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'Webhook test failed',
    );
  }
}
