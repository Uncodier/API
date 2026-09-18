import { NextResponse } from 'next/server';
import { z } from 'zod';
import { processRecordEmbeddingsById } from '@/lib/services/record-embedding-worker';

const bodySchema = z.object({
  record_id: z.string().uuid(),
  changed_node_ids: z.array(z.string().uuid()).max(200).optional(),
}).strict();

export const maxDuration = 60;

export async function POST(request: Request) {
  const serviceApiKey = process.env.SERVICE_API_KEY?.trim();
  if (
    !serviceApiKey
    || request.headers.get('x-api-key') !== serviceApiKey
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const input = bodySchema.parse(await request.json());
    const result = await processRecordEmbeddingsById({
      recordId: input.record_id,
      requestedNodeIds: input.changed_node_ids,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[record embedding]', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid embedding request' },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : 'Failed to index record',
      },
      { status: 500 },
    );
  }
}
