import { NextRequest, NextResponse } from 'next/server';
import { listSystemNotificationCore, notifySystemNotificationCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, site_id, team_member_email, instance_id, message, title, channels, phone_number } = body;

    // Handle "list" action
    if (action === 'list') {
      const data = await listSystemNotificationCore(site_id);
      return NextResponse.json({
        success: true,
        data
      });
    }

    // Handle "notify" action (default)
    const data = await notifySystemNotificationCore({
      site_id,
      team_member_email,
      instance_id,
      message,
      title,
      channels,
      phone_number
    });

    return NextResponse.json({
      success: true,
      data
    });

  } catch (error: any) {
    console.error('Error in system_notification tool:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message?.includes('required') ? 400 : 500 }
    );
  }
}
