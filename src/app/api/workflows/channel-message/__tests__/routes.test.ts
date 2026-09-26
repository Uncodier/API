// @ts-nocheck -- ESM Jest mocks are dynamically imported under the ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const hasAuthenticatedPrincipal = jest.fn();
const isInternalServiceRequest = jest.fn();
const prepareChannelMessageRuns = jest.fn();
const advanceBoundedChannelMessageRun = jest.fn();
const getCompletedChannelMessageGuidance = jest.fn();

jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal, isInternalServiceRequest,
}));
jest.unstable_mockModule('@/lib/services/workflow-robot/channel-message', () => ({
  CHANNEL_MESSAGE_UUID: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
  normalizeMessageChannel: (v: unknown) => typeof v === 'string' && ['web', 'email'].includes(v.trim().toLowerCase())
    ? v.trim().toLowerCase() : null,
  prepareChannelMessageRuns, getCompletedChannelMessageGuidance,
}));
jest.unstable_mockModule('@/lib/services/workflow-robot/bounded-channel-execution', () => ({
  advanceBoundedChannelMessageRun,
}));

const { POST: prepare } = await import('../prepare/route');
const { POST: advance } = await import('../advance/route');
const { POST: result } = await import('../result/route');
const siteId = '11111111-1111-4111-8111-111111111111';
const runPlanId = '22222222-2222-4222-8222-222222222222';
const input = { siteId, messageId: 'message:1', channel: 'web', message: 'Hi there' };
const request = (path: string, body: unknown) => new NextRequest(`https://example.test${path}`, {
  method: 'POST', body: JSON.stringify(body),
});

beforeEach(() => {
  jest.clearAllMocks();
  hasAuthenticatedPrincipal.mockReturnValue(true);
  isInternalServiceRequest.mockReturnValue(true);
  prepareChannelMessageRuns.mockResolvedValue([{ runPlanId, status: 'in_progress' }]);
  advanceBoundedChannelMessageRun.mockResolvedValue('in_progress');
  getCompletedChannelMessageGuidance.mockResolvedValue('Trusted guidance');
});

const routes = [
  { post: prepare, path: '/api/workflows/channel-message/prepare', body: input },
  { post: advance, path: '/api/workflows/channel-message/advance', body: { siteId, messageId: input.messageId, runPlanId } },
  { post: result, path: '/api/workflows/channel-message/result', body: { siteId, messageId: input.messageId, channel: 'web', runPlanIds: [runPlanId] } },
];

it.each(routes)('requires a validated service principal at $path', async ({ post, path, body }) => {
  hasAuthenticatedPrincipal.mockReturnValueOnce(false);
  expect((await post(request(path, body))).status).toBe(401);
  isInternalServiceRequest.mockReturnValueOnce(false);
  expect((await post(request(path, body))).status).toBe(401);
  expect(prepareChannelMessageRuns).not.toHaveBeenCalled();
  expect(advanceBoundedChannelMessageRun).not.toHaveBeenCalled();
  expect(getCompletedChannelMessageGuidance).not.toHaveBeenCalled();
});

it('validates prepare inputs and returns a wrapped, priority-ordered run list', async () => {
  for (const invalid of [{ ...input, siteId: 'bad' }, { ...input, channel: 'outbound' },
    { ...input, messageId: '' }, { ...input, message: 'x'.repeat(4001) }]) {
    expect((await prepare(request(routes[0].path, invalid))).status).toBe(400);
  }
  expect(prepareChannelMessageRuns).not.toHaveBeenCalled();
  const response = await prepare(request(routes[0].path, input));
  expect(await response.json()).toEqual({ success: true, data: {
    runs: [{ runPlanId, status: 'in_progress' }],
  } });
  expect(prepareChannelMessageRuns).toHaveBeenCalledWith(input);
});

it('rejects malformed and foreign runs; never invokes an unvalidated run', async () => {
  expect((await advance(request(routes[1].path, { siteId, messageId: input.messageId, runPlanId: 'bad' }))).status).toBe(400);
  expect(advanceBoundedChannelMessageRun).not.toHaveBeenCalled();
  advanceBoundedChannelMessageRun.mockResolvedValueOnce('forbidden');
  expect((await advance(request(routes[1].path, routes[1].body))).status).toBe(403);
  expect(await (await advance(request(routes[1].path, routes[1].body))).json())
    .toEqual({ success: true, data: { status: 'in_progress' } });
});

it('only returns validated, completed guidance; rejects oversized IDs', async () => {
  expect((await result(request(routes[2].path, { ...routes[2].body, runPlanIds: ['bad'] }))).status).toBe(400);
  expect((await result(request(routes[2].path, { ...routes[2].body, channel: 'outbound' }))).status).toBe(400);
  expect((await result(request(routes[2].path, { ...routes[2].body, runPlanIds: Array(11).fill(runPlanId) }))).status).toBe(400);
  expect(getCompletedChannelMessageGuidance).not.toHaveBeenCalled();
  expect(await (await result(request(routes[2].path, routes[2].body))).json())
    .toEqual({ success: true, data: { guidance: 'Trusted guidance' } });
});