// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';

const dispatchWorkflowEvent = jest.fn();
jest.unstable_mockModule('@/lib/services/workflow-robot/dispatch', () => ({ dispatchWorkflowEvent }));
const { POST } = await import('../route');

const originalSecret = process.env.CRON_SECRET;
const request = (secret?: string, extra = {}) => new NextRequest('https://example.invalid/api/workflows/triggers/dispatch', {
  method: 'POST',
  headers: secret ? { 'x-workflow-secret': secret } : {},
  body: JSON.stringify({ table: 'leads', op: 'insert', site_id: 'site-1', row: { id: 'lead-1' }, ...extra }),
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
  const secret = randomBytes(24).toString('hex');
  process.env.CRON_SECRET = secret;
  expect((await POST(request())).status).toBe(401);
  expect((await POST(request(randomBytes(24).toString('hex')))).status).toBe(401);
  expect(dispatchWorkflowEvent).not.toHaveBeenCalled();
  expect((await POST(request(secret))).status).toBe(200);
  expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
});

it('forwards caller event identity unchanged on retries and supports legacy requests', async () => {
  const secret = randomBytes(24).toString('hex');
  process.env.CRON_SECRET = secret;
  const event_id = randomUUID();
  for (let i = 0; i < 2; i++) expect((await POST(request(secret, { event_id }))).status).toBe(200);
  expect(dispatchWorkflowEvent.mock.calls[0][0].event_id).toBe(event_id);
  expect(dispatchWorkflowEvent.mock.calls[1][0]).toEqual(dispatchWorkflowEvent.mock.calls[0][0]);
  expect((await POST(request(secret))).status).toBe(200);
  expect(dispatchWorkflowEvent.mock.calls[2][0]).not.toHaveProperty('event_id');
});