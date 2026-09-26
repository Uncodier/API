// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const dispatchWorkflowEvent = jest.fn();
jest.unstable_mockModule('@/lib/services/workflow-robot/dispatch', () => ({ dispatchWorkflowEvent }));
const { POST } = await import('../route');

const originalSecret = process.env.CRON_SECRET;
const request = (secret?: string) => new NextRequest('https://api.example/api/workflows/triggers/dispatch', {
  method: 'POST',
  headers: secret ? { 'x-workflow-secret': secret } : {},
  body: JSON.stringify({ table: 'leads', op: 'insert', site_id: 'site-1', row: { id: 'lead-1' } }),
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  dispatchWorkflowEvent.mockResolvedValue({ started: 1, skipped: 0 });
});

it('fails closed without configured CRON_SECRET', async () => {
  delete process.env.CRON_SECRET;
  expect((await POST(request())).status).toBe(401);
  expect(dispatchWorkflowEvent).not.toHaveBeenCalled();
});

it('dispatches only on the configured secret', async () => {
  process.env.CRON_SECRET = 'configured-test-secret';
  expect((await POST(request())).status).toBe(401);
  expect((await POST(request('bad-secret'))).status).toBe(401);
  expect(dispatchWorkflowEvent).not.toHaveBeenCalled();
  expect((await POST(request('configured-test-secret'))).status).toBe(200);
  expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
});