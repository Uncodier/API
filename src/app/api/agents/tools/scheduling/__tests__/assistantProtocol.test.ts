import { randomBytes } from 'node:crypto';
import { schedulingTool, type SchedulingToolParams } from '../assistantProtocol';
import { buildSchedulingRecovery } from '@/lib/scheduling/recovery';

describe('scheduling assistant transport', () => {
  const originalEnv = process.env;
  const input: SchedulingToolParams = {
    action: 'check_availability', date: '2026-10-13', duration: 30, timezone: 'America/Mexico_City',
  };
  let transport: jest.SpyInstance;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  beforeEach(() => {
    process.env = { ...originalEnv, NEXT_PUBLIC_API_URL: 'https://api.example.invalid',
      SERVICE_API_KEY: randomBytes(24).toString('hex') };
    transport = jest.spyOn(global, 'fetch').mockImplementation(async () => { throw new Error('Offline only'); });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); process.env = originalEnv; });

  it.each([{}, { calendar_id: 'team-calendar' }, { user_id: 'personal-profile' }, { team_id: 'legacy-calendar' }])(
    'accepts each calendar target contract without requiring team_id: %j', async target => {
      transport.mockResolvedValue(json({ success: true, available_slots: [] }));
      expect(await schedulingTool('site-1').execute({ ...input, ...target })).toEqual({ success: true, available_slots: [] });
      const [url, options] = transport.mock.calls[0];
      const query = new URL(url).searchParams;
      expect(query.get('site_id')).toBe('site-1');
      for (const [key, value] of Object.entries(target)) expect(query.get(key)).toBe(value);
      expect([...query.keys()].filter(key => ['calendar_id', 'user_id', 'team_id'].includes(key))).toEqual(Object.keys(target));
      expect(options).toMatchObject({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal),
        headers: { 'x-api-key': process.env.SERVICE_API_KEY } });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 404, 422, 503, 200])('preserves structured endpoint failure/recovery on HTTP %s', async status => {
    const recovery = buildSchedulingRecovery({ timezone: 'UTC', now: new Date('2026-12-31T23:00:00Z'), code: 'CALENDAR_NOT_FOUND' });
    const body = { success: false, error: 'Choose a calendar from calendars.list', code: 'CALENDAR_NOT_FOUND', recovery };
    transport.mockResolvedValue(json(body, status));
    expect(await schedulingTool('site-1').execute({ ...input, calendar_id: 'unknown' })).toEqual(body);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['not json', '', 'null', '[]', 'true', '{}', '{"success":"true"}'])(
    'generates recovery for malformed payload %s without echoing upstream content', async payload => {
      transport.mockResolvedValue(new Response(payload, { status: 200 }));
      const result = await schedulingTool('site-1').execute(input);
      expect(result).toMatchObject({ success: false, code: 'SCHEDULING_MALFORMED_RESPONSE',
        recovery: { timezone: input.timezone, availability_confirmed: false, suggested_dates: expect.any(Array) } });
      expect(result.recovery.suggested_dates).toHaveLength(3);
      expect(result).not.toHaveProperty('available_slots');
    },
  );

  it('does not leak network error details or secrets into recovery', async () => {
    const secret = randomBytes(24).toString('hex');
    const url = new URL('https://upstream.example.invalid');
    url.username = randomBytes(12).toString('hex');
    url.password = secret;
    transport.mockRejectedValue(new Error(`password=${secret} ${url}`));
    const result = await schedulingTool('site-1').execute(input);
    expect(result).toMatchObject({ success: false, code: 'SCHEDULING_NETWORK_ERROR', recovery: { availability_confirmed: false } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(url.username);
    expect(JSON.stringify(result)).not.toContain(url.password);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { availability_confirmed: true }, { suggested_dates: ['2020-01-01'] }])(
    'rebuilds a malformed recovery object instead of losing the authoritative dates: %j', async recovery => {
      transport.mockResolvedValue(json({ success: false, code: 'AVAILABILITY_UNAVAILABLE', recovery }, 503));
      const result = await schedulingTool('site-1').execute(input);
      expect(result.recovery).toMatchObject({ availability_confirmed: false, auto_retry: false,
        local_date: expect.any(String), tomorrow: expect.any(String), timezone: input.timezone });
      expect(result.recovery.suggested_dates).toHaveLength(3);
    },
  );

  it.each(['fetch', 'body'])('bounds even a stalled %s within the voice budget and aborts without retry', async stage => {
    jest.useFakeTimers();
    transport.mockImplementation(() => stage === 'fetch' ? new Promise(() => {}) : Promise.resolve({
      ok: true, status: 200, text: () => new Promise(() => {}),
    }));
    const promise = schedulingTool('site-1').execute(input);
    await jest.advanceTimersByTimeAsync(5_500);
    const result = await promise;
    expect(result).toMatchObject({ success: false, code: 'SCHEDULING_TIMEOUT', recovery: { availability_confirmed: false } });
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['schedule', 'update'] as const)('treats failed %s as unknown write state, requiring list before retry', async action => {
    transport.mockRejectedValue(new Error('Connection lost after possible commit'));
    const args = { ...input, action, appointment_id: 'appointment-1', title: 'Consultation',
      start_datetime: '2026-10-13T15:00:00Z', context_id: 'lead-1', participants: 'profile-1,profile-2' };
    const result = await schedulingTool('site-1').execute(args);
    expect(result).toMatchObject({ success: false, recovery: {
      write_state: 'unknown', auto_retry: false, availability_confirmed: false,
    } });
    expect(result.recovery.guidance).toContain('scheduling action="list"');
    expect(result.recovery.guidance).toContain('may already have completed');
    const sent = JSON.parse(transport.mock.calls[0][1].body);
    expect(sent).toMatchObject({ action, participants: ['profile-1', 'profile-2'] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('preserves successful list/schedule/update results and cancels the timeout', async () => {
    jest.useFakeTimers();
    const result = { success: true, appointment_id: 'appointment-1' };
    for (const action of ['list', 'schedule', 'update'] as const) {
      transport.mockResolvedValueOnce(json(result));
      expect(await schedulingTool('site-1').execute({ ...input, action, title: 'Consultation',
        start_datetime: '2026-10-13T15:00:00Z', context_id: 'lead-1', appointment_id: 'appointment-1' })).toEqual(result);
    }
    expect(transport).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([401, 403])('never turns HTTP %s authorization failures into recoverable results', async status => {
    transport.mockResolvedValue(json({ success: false, recovery: buildSchedulingRecovery() }, status));
    await expect(schedulingTool('site-1').execute(input)).rejects.toThrow('authorization');
  });

  it.each([400, 422])('keeps unstructured HTTP %s input validation failures rejected', async status => {
    transport.mockResolvedValue(json({ success: false, error: 'Invalid input' }, status));
    await expect(schedulingTool('site-1').execute(input)).rejects.toMatchObject({
      message: expect.stringContaining('validation'), status, result: {
        success: false, recovery: { availability_confirmed: false, suggested_dates: expect.any(Array) },
      },
    });
  });

  it.each(['INVALID_SCHEDULING_ARGUMENTS', 'INVALID_PARTICIPANTS', 'UNSUPPORTED_RESOURCES'])(
    'preserves structured validation recovery in rejected %s errors', async code => {
      const body = { success: false, code, error: 'Invalid scheduling input',
        recovery: buildSchedulingRecovery({ timezone: 'UTC', code }) };
      transport.mockResolvedValue(json(body, 422));
      await expect(schedulingTool('site-1').execute(input)).rejects.toMatchObject({ status: 422, result: body });
    },
  );

  it('retains required-field validation before fetch and exposes calendar IDs in schema', async () => {
    const tool = schedulingTool('site-1');
    await expect(tool.execute({ action: 'check_availability' })).rejects.toThrow('date, duration, timezone');
    expect(transport).not.toHaveBeenCalled();
    expect(tool.parameters.required).toEqual(['action']);
    expect(tool.parameters.properties).toHaveProperty('calendar_id');
    expect(tool.parameters.properties).toHaveProperty('user_id');
    expect(tool.parameters.properties.team_id.description).toContain('Legacy alias');
  });
});