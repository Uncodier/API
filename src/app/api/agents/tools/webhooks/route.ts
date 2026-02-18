import { NextRequest, NextResponse } from 'next/server';
import { getMakinariClient } from './client';

export async function getWebhooks() {
  const client = getMakinariClient();
  return client.getWebhooks();
}

export async function createWebhook(url: string, events: string[]) {
  const client = getMakinariClient();
  return client.createWebhook(url, events);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, url, events, id } = body;

    if (action === 'list') {
      const webhooks = await getWebhooks();
      return NextResponse.json({ success: true, webhooks });
    }

    if (action === 'create') {
      if (!url || !events) {
        return NextResponse.json({ success: false, error: 'Missing url or events' }, { status: 400 });
      }
      const webhook = await createWebhook(url, events);
      return NextResponse.json({ success: true, webhook });
    }
    
    // Add delete action if needed, though not explicitly requested but good for completeness
    if (action === 'delete') {
      if (!id) {
         return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
      }
      const client = getMakinariClient();
      await client.deleteWebhook(id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Error in webhooks tool:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
