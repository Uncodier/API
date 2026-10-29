import { readScreenAccess, ScreenAccessReadError, SCREEN_ACCESS_READ_TIMEOUT_MS } from '../screen-access-read';

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('settles at the deadline even if the backend ignores its abort signal', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  let settle!: (result: { data: boolean; error: null }) => void;
  const backend = new Promise<{ data: boolean; error: null }>(resolve => { settle = resolve; });
  const read = jest.fn(() => backend);
  const result = readScreenAccess('effective_access', read).catch(error => error);
  await jest.advanceTimersByTimeAsync(SCREEN_ACCESS_READ_TIMEOUT_MS);
  expect(await result).toMatchObject({ name: 'ScreenAccessReadError', phase: 'effective_access', reason: 'timeout', retryable: true });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  settle({ data: true, error: null });
  await jest.advanceTimersByTimeAsync(0);
  expect(await result).toBeInstanceOf(ScreenAccessReadError);
  expect(read).toHaveBeenCalledTimes(1);
});

it('does not issue a read when its deadline is already aborted', async () => {
  const controller = new AbortController(); controller.abort();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const read = jest.fn();
  await expect(readScreenAccess('site', read)).rejects.toMatchObject({ reason: 'timeout', retryable: true });
  expect(read).not.toHaveBeenCalled();
});

it('removes its abort listener when a read succeeds', async () => {
  const controller = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  expect(await readScreenAccess('site', async () => ({ data: { present: true }, error: null }))).toEqual({ present: true });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  controller.abort();
});

it.each([
  [new TypeError('Failed to fetch'), 'transport', true],
  [new DOMException('Aborted', 'AbortError'), 'timeout', true],
  [new Error('Unexpected adapter error'), 'backend', false],
])('classifies thrown failures without retaining cause: %s', async (error, reason, retryable) => {
  const failure = await readScreenAccess('roles', async () => { throw error; }).catch(error => error);
  expect(failure).toMatchObject({ reason, retryable, phase: 'roles', message: 'Permission lookup failed' });
  expect(failure).not.toHaveProperty('cause');
});

it('does not pass backend data through an error result', async () => {
  await expect(readScreenAccess('site', async () => ({ data: { user_id: 'untrusted' }, error: { code: '42501' }, status: 403 })))
    .rejects.toMatchObject({ backendCode: '42501', retryable: false });
});