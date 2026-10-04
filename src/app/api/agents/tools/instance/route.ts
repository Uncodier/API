import { NextRequest, NextResponse } from 'next/server';
import { instanceCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await instanceCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
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