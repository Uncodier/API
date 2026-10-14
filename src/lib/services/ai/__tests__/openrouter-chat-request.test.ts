import { randomBytes } from 'node:crypto';
import { describeOpenRouterFailure, requestOpenRouterChat, resolveChatOutputTokens } from '../openrouter-chat-request';

const request = { model: 'openai/gpt-6.1-sol', messages: [{ role: 'user', content: 'Run' }], max_tokens: 4096 };
const rejected = (status: number, extra = {}) => Object.assign(new Error('Synthetic provider rejection'), { status, ...extra });
function runtime() {
  let time = 0;
  const sleep = jest.fn(async (ms: number) => { time += ms; });
  return { sleep, now: () => time, random: () => 0 };
}
beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it('uses bounded explicit defaults and validates overrides', () => {
  expect(resolveChatOutputTokens(undefined, false, {})).toBe(8192);
  expect(resolveChatOutputTokens(undefined, true, {})).toBe(4096);
  expect(resolveChatOutputTokens(undefined, true, { OPENROUTER_CHAT_MAX_OUTPUT_TOKENS: '2048' })).toBe(2048);
  expect(resolveChatOutputTokens(100_000)).toBe(32768);
  for (const value of [0, -1, NaN, Infinity, 1.5]) expect(resolveChatOutputTokens(value, true, {})).toBe(4096);
  expect(resolveChatOutputTokens(undefined, false, { OPENROUTER_CHAT_MAX_OUTPUT_TOKENS: '-3' })).toBe(8192);
});

it.each([408, 429, 500, 502, 503, 504])('retries HTTP %s before returning a result', async status => {
  const create = jest.fn().mockRejectedValueOnce(rejected(status)).mockResolvedValue('accepted');
  const clock = runtime();
  await expect(requestOpenRouterChat(request, create, clock)).resolves.toBe('accepted');
  expect(create).toHaveBeenCalledTimes(2);
  expect(clock.sleep).toHaveBeenCalledWith(500);
  expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
});

it('stops after three attempts and preserves the final rejection', async () => {
  const error = rejected(503);
  const create = jest.fn().mockRejectedValue(error);
  const clock = runtime();
  await expect(requestOpenRouterChat(request, create, clock)).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(3);
  expect(clock.sleep.mock.calls).toEqual([[500], [1000]]);
});

it.each([new Headers({ 'retry-after': '3' }), { 'Retry-After': '3' },
  { 'retry-after': new Date(3000).toUTCString() }])('honors Retry-After seconds or date', async headers => {
  const create = jest.fn().mockRejectedValueOnce(rejected(429, { headers })).mockResolvedValue('accepted');
  const clock = runtime();
  await requestOpenRouterChat(request, create, clock);
  expect(clock.sleep).toHaveBeenCalledWith(3000);
});

it.each(['60', '9'.repeat(100), 'invalid-date'])('does not shorten oversized or invalid Retry-After %s', async header => {
  const error = rejected(503, { headers: { 'retry-after': header } });
  const create = jest.fn().mockRejectedValue(error);
  const clock = runtime();
  await expect(requestOpenRouterChat(request, create, clock)).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(1);
  expect(clock.sleep).not.toHaveBeenCalled();
});

it('retries a 402 once with a smaller affordable output reservation', async () => {
  const error = rejected(402, { error: { message: 'You requested up to 4096 tokens, but can only afford 3936.' } });
  const create = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('accepted');
  await expect(requestOpenRouterChat(request, create, runtime())).resolves.toBe('accepted');
  expect(create.mock.calls.map(([payload]) => payload.max_tokens)).toEqual([4096, 3542]);
  expect(request.max_tokens).toBe(4096);
});

it('does not keep shrinking an unfunded request', async () => {
  const error = rejected(402, { error: { message: 'can only afford 1000' } });
  const create = jest.fn().mockRejectedValue(error);
  await expect(requestOpenRouterChat(request, create, runtime())).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(2);
});

it('retries temporary in-flight funding with an explicit retry hint', async () => {
  const error = rejected(402, { headers: { 'retry-after': '2' },
    error: { metadata: { limit_source: 'openrouter_in_flight_budget' } } });
  const create = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('accepted');
  const clock = runtime();
  await requestOpenRouterChat(request, create, clock);
  expect(clock.sleep).toHaveBeenCalledWith(2000);
  expect(create.mock.calls[1][0].max_tokens).toBe(4096);
});

it('does not retry an in-flight 402 without a retry hint or shrink unusably small output', async () => {
  for (const extra of [{ error: { metadata: { limit_source: 'openrouter_in_flight_budget' } } },
    { error: { message: 'can only afford 100' } }, { error: { message: 'can only afford 0' } }]) {
    const error = rejected(402, extra);
    const create = jest.fn().mockRejectedValue(error);
    await expect(requestOpenRouterChat(request, create, runtime())).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  }
});

it('respects the overall local deadline across consecutive retry hints', async () => {
  const error = rejected(429, { headers: { 'retry-after': '12' } });
  const create = jest.fn().mockRejectedValue(error);
  const clock = runtime();
  await expect(requestOpenRouterChat(request, create, clock)).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(2);
  expect(clock.sleep.mock.calls).toEqual([[12000]]);
});

it.each([400, 401, 403, 404, 402])('never blindly retries permanent HTTP %s', async status => {
  const error = rejected(status);
  const create = jest.fn().mockRejectedValue(error);
  await expect(requestOpenRouterChat(request, create, runtime())).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])('retries provable pre-connection failure %s', async code => {
  const create = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Connection unavailable'), { cause: { code } }))
    .mockResolvedValue('accepted');
  await requestOpenRouterChat(request, create, runtime());
  expect(create).toHaveBeenCalledTimes(2);
});

it.each(['ECONNRESET', 'ETIMEDOUT', undefined])('does not replay ambiguous transport failure %s', async code => {
  const error = Object.assign(new Error('Connection lost'), { cause: { code } });
  const create = jest.fn().mockRejectedValue(error);
  await expect(requestOpenRouterChat(request, create, runtime())).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(1);
});

it.each([{ generationId: 'generation-accepted' }, { usage: { total_tokens: 1 } },
  { error: { metadata: { generation_id: 'generation-accepted' } } }])('does not retry a rejection carrying acceptance evidence %j', async extra => {
  const error = rejected(503, extra);
  const create = jest.fn().mockRejectedValue(error);
  await expect(requestOpenRouterChat(request, create, runtime())).rejects.toBe(error);
  expect(create).toHaveBeenCalledTimes(1);
});

it('does not consume or retry an accepted stream', async () => {
  const failure = rejected(503);
  const stream = (async function* () { yield 'partial'; throw failure; })();
  const create = jest.fn().mockResolvedValue(stream);
  const accepted = await requestOpenRouterChat<AsyncIterable<string>>(request, create, runtime());
  await expect((async () => { for await (const _chunk of accepted) {} })()).rejects.toBe(failure);
  expect(create).toHaveBeenCalledTimes(1);
});

it('logs only safe status and retry metadata, never provider secrets', async () => {
  const secret = randomBytes(32).toString('hex');
  const error = rejected(503, { error: { message: secret }, headers: { authorization: secret } });
  const create = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('accepted');
  await requestOpenRouterChat(request, create, runtime());
  expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain(secret);
  expect(describeOpenRouterFailure(error)).toEqual({ status: 503, category: 'availability' });
  expect(describeOpenRouterFailure(rejected(402))).toEqual({ status: 402, category: 'funding' });
  expect(describeOpenRouterFailure(new Error('402'))).toBeUndefined();
});