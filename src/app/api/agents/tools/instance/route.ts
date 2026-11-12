import { NextRequest, NextResponse } from 'next/server';
import { instanceCore } from './core';
import { authorizeInferenceRequest, withHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { principal, routing } = await authorizeInferenceRequest(request, body?.site_id);
    if (!routing || !body || !['create', 'read', 'update'].includes(body.action)) {
      return NextResponse.json({ success: false, error: 'Valid site and action are required' }, { status: 400 });
    }
    const result = await withHttpExecutionRouting(request, routing, () => instanceCore({
      ...body, site_id: routing.siteId, user_id: principal.userId ?? undefined,
    }));
    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Instance request failed' },
      { status: [401, 403, 402, 422].includes(error?.status) ? error.status : 400 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Instance Tool API',
    description: 'Create, Read, Update AI assistant instances',
    usage: 'Send a POST request with action parameter: create, read, or update',
    endpoint: '/api/agents/tools/instance',
    methods: ['POST', 'GET'],
    actions: {
      create: {
        required_fields: ['action', 'site_id', 'activity'],
        optional_fields: ['status'],
        response: { success: 'boolean', instance: 'object' }
      },
      read: {
        required_fields: ['action', 'site_id'],
        optional_fields: ['instance_id', 'limit', 'offset'],
        response: { success: 'boolean', instance: 'object', instances: 'array' }
      },
      update: {
        required_fields: ['action', 'site_id', 'instance_id'],
        optional_fields: ['name', 'status', 'context'],
        response: { success: 'boolean', instance: 'object', renamed: 'boolean' }
      }
    }
  });
}