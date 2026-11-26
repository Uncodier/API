import { randomUUID } from 'node:crypto';
import { createAppointment, type AppointmentRow } from '@/lib/scheduling/appointments';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));

const booking = { title: 'Review', start_datetime: '2099-02-01T09:00:00-06:00', duration: 30,
  timezone: 'America/Mexico_City', site_id: randomUUID(), context_id: randomUUID(), participants: ['a', 'b'] };
const turn = randomUUID();
const rows = new Map<string, AppointmentRow>();
let attempts: number;
let lookupError: boolean;
let unrelatedUniqueError: boolean;

beforeEach(() => {
  rows.clear(); attempts = 0; lookupError = false; unrelatedUniqueError = false;
  (supabaseAdmin.schema as jest.Mock).mockImplementation(() => ({ from(name: string) {
    expect(name).toBe('appointments');
    const filters: Record<string, string> = {};
    let candidate: AppointmentRow, excluded: string, before: string, after: string;
    const matches = () => [...rows.values()].filter(row => Object.entries(filters)
      .every(([key, value]) => row[key as keyof AppointmentRow] === value));
    return {
      select() { return this; },
      eq(key: string, value: string) { filters[key] = value; return this; },
      neq(key: string, id: string) { expect(key).toBe('id'); excluded = id; return this; },
      lt(_key: string, end: string) { before = end; return this; },
      gt(_key: string, start: string) { after = start; return this; },
      maybeSingle() {
        expect(filters).toMatchObject({ id: expect.any(String), context_id: expect.any(String), site_id: expect.any(String) });
        return { data: matches()[0] ?? null, error: lookupError ? {} : null };
      },
      then(resolve: (value: unknown) => void) {
        resolve({ data: matches().filter(row => row.id !== excluded && row.start_datetime < before && row.end_datetime > after) });
      },
      insert([row]: AppointmentRow[]) { candidate = row; return this; },
      single() {
        attempts++;
        if (rows.has(candidate.id) || unrelatedUniqueError) return { data: null, error: { code: '23505' } };
        rows.set(candidate.id, candidate);
        return { data: candidate, error: null };
      },
    };
  } }));
});

it('arbitrates racing creates by primary key, then replays without another insert', async () => {
  const retry = { ...booking, start_datetime: '2099-02-01T15:00:00Z', title: 'Reworded', participants: ['B', 'a', 'a'] };
  const [first, raced] = await Promise.all([createAppointment(booking, turn), createAppointment(retry, turn)]);
  expect(rows.size).toBe(1);
  expect(attempts).toBe(2);
  expect([first.replayed, raced.replayed].sort()).toEqual([false, true]);
  expect(first.appointment).toEqual(raced.appointment);
  expect(first.appointment.calendar_link).toBeUndefined();
  const replay = await createAppointment(retry, turn);
  expect(replay).toEqual({ appointment: first.appointment, replayed: true });
  expect(attempts).toBe(2);
});

it('keeps distinct bookings and returns current state without reviving a cancellation', async () => {
  const first = await createAppointment(booking, turn);
  await createAppointment({ ...booking, participants: ['other'] }, turn);
  await createAppointment({ ...booking, start_datetime: '2099-02-02T15:00:00Z' }, turn);
  await createAppointment({ ...booking, site_id: randomUUID() }, turn);
  for (const changed of [{ context_id: randomUUID() }, { duration: 45 }]) {
    await expect(createAppointment({ ...booking, ...changed }, turn)).rejects.toMatchObject({ status: 409 });
  }
  await expect(createAppointment(booking, randomUUID())).rejects.toMatchObject({ status: 409 });
  rows.get(first.appointment.id)!.status = 'cancelled';
  expect((await createAppointment(booking, turn)).appointment.status).toBe('cancelled');
  const replacement = await createAppointment(booking, randomUUID());
  expect(replacement.replayed).toBe(false);
  expect(replacement.appointment.id).not.toBe(first.appointment.id);
  expect(rows.size).toBe(5);
});

it('recovers the moved appointment after the original slot has elapsed', async () => {
  const { appointment } = await createAppointment(booking, turn);
  appointment.start_datetime = '2099-03-01T15:00:00.000Z';
  appointment.end_datetime = '2099-03-01T15:30:00.000Z';
  jest.useFakeTimers().setSystemTime(new Date('2099-02-02T00:00:00Z'));
  try {
    const recovered = await createAppointment(booking, turn);
    expect(recovered).toEqual({ appointment, replayed: true });
    expect(recovered.appointment.start_datetime).toBe('2099-03-01T15:00:00.000Z');
    await expect(createAppointment(booking, randomUUID())).rejects.toMatchObject({ status: 422 });
    expect(attempts).toBe(1);
  } finally { jest.useRealTimers(); }
});

it('never reports replay for a failed lookup or an unrelated unique conflict', async () => {
  lookupError = true;
  await expect(createAppointment(booking, turn)).rejects.toThrow('verify');
  expect(attempts).toBe(0);
  lookupError = false; unrelatedUniqueError = true;
  await expect(createAppointment(booking, turn)).rejects.toThrow();
  expect(rows.size).toBe(0);
});
