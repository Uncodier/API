import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sendPendingWorkNow } from '@/lib/services/robot-instance/pending-work';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SendNowSchema = z.object({
  pending_id: z.string().uuid('pending_id must be a valid UUID'),
  instance_id: z.string().uuid('instance_id must be a valid UUID'),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = SendNowSchema.parse(await request.json());
    const result = await sendPendingWorkNow({
      pendingId: parsed.pending_id,
      instanceId: parsed.instance_id,
    });

    return NextResponse.json({
      success: true,
      data: {
        cancelled_log_id: result.cancelledLogId,
        pending_id: result.pendingId,
      },
    });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return NextResponse.json(
        { success: false, error: { message: 'Invalid request data', details: err.errors } },
        { status: 400 }
      );
    }

    console.error('Error in POST /robots/instance/pending-work/send-now:', err);
    return NextResponse.json(
      { success: false, error: { message: err.message || 'Failed to send pending command' } },
      { status: 500 }
    );
  }
}
