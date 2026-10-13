import { NextRequest, NextResponse } from 'next/server';
import { getSchedulingAvailability } from '@/lib/scheduling/availability';
import { SchedulingAvailabilityError } from '@/lib/scheduling/calendar-directory';
import { buildSchedulingRecovery } from '@/lib/scheduling/recovery';

/** Read-only availability from configured calendars, site members and appointments. */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const timezone = params.get('timezone') || undefined;
  const csv = (name: string) => (params.get(name) || '').split(',').map(value => value.trim()).filter(Boolean);
  try {
    const result = await getSchedulingAvailability({
      site_id: params.get('site_id'),
      date: params.get('date'),
      duration: Number(params.get('duration')),
      timezone,
      calendar_id: params.get('calendar_id') || undefined,
      team_id: params.get('team_id') || undefined,
      user_id: params.get('user_id') || undefined,
      start_time: params.get('start_time') || undefined,
      end_time: params.get('end_time') || undefined,
      participants: csv('participants'),
      resources: csv('resources'),
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const known = error instanceof SchedulingAvailabilityError ? error : undefined;
    const code = known?.code || 'AVAILABILITY_UNAVAILABLE';
    // Do not log query strings, customer data, or raw database/provider errors.
    console.warn('[Scheduling availability]', { code, status: known?.status || 503 });
    return NextResponse.json({
      success: false,
      error: known?.message || 'No se pudo verificar la disponibilidad. Intenta de nuevo',
      code,
      recovery: buildSchedulingRecovery({ timezone, code }),
    }, { status: known?.status || 503, headers: { 'Cache-Control': 'no-store' } });
  }
}