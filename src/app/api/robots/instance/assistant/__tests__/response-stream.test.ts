import { assistantResponseStream } from '../response-stream';

const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('assistant lifecycle SSE', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('acknowledges the persisted log immediately then sends completion', async () => {
    let complete!: (value: string) => void;
    const run = { runId: 'run', status: new Promise<string>(resolve => { complete = resolve; }),
      returnValue: Promise.resolve({ assistant_response: 'Answer' }) };
    const response = assistantResponseStream(run, 'instance', 'user-log');
    expect(response.headers.get('X-Assistant-Stream-Version')).toBe('1');
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toContain('"user_log_id":"user-log"');
    complete('completed');
    expect(decode((await reader.read()).value)).toContain('"assistant_response":"Answer"');
    expect((await reader.read()).done).toBe(true);
  });

  it.each(['failed', 'cancelled'])('reports %s even without a log or a workflow writable stream', async status => {
    const run = { runId: 'run', status: Promise.resolve(status), get returnValue(): Promise<unknown> {
      throw new Error('Must not poll failed returnValue');
    } };
    const text = await assistantResponseStream(run, 'instance', 'log').text();
    expect(text).toContain('event: accepted');
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: completed');
  });

  it('does not report an exhausted plan as successful completion', async () => {
    const text = await assistantResponseStream({ runId: 'run', status: Promise.resolve('completed'),
      returnValue: Promise.resolve({ success: false, execution_status: 'exhausted' }) }, 'instance', 'log').text();
    expect(text).toContain('ASSISTANT_WORKFLOW_INCOMPLETE');
    expect(text).not.toContain('event: completed');
  });

  it('reports a background continuation honestly rather than a successful answer', async () => {
    const text = await assistantResponseStream({ runId: 'run', status: Promise.resolve('completed'),
      returnValue: Promise.resolve({ success: false, execution_status: 'continuing' }) }, 'instance', 'log').text();
    expect(text).toContain('ASSISTANT_WORKFLOW_CONTINUING');
    expect(text).toContain('continuing in the background');
    expect(text).not.toContain('event: completed');
  });

  it('redacts status lookup failures and closes the connection', async () => {
    const run = { runId: 'run', get status(): Promise<string> { throw new Error('SECRET_PROVIDER_RESPONSE'); },
      returnValue: Promise.resolve(null) };
    const text = await assistantResponseStream(run, 'instance', 'log').text();
    expect(text).toContain('ASSISTANT_STATUS_UNAVAILABLE');
    expect(text).not.toContain('SECRET_PROVIDER_RESPONSE');
  });

  it('stops polling after the client cancels without cancelling the durable workflow', async () => {
    jest.useFakeTimers();
    const getStatus = jest.fn().mockResolvedValue('running');
    const run = { runId: 'run', get status() { return getStatus(); }, returnValue: Promise.resolve(null) };
    const reader = assistantResponseStream(run, 'instance', 'log').body!.getReader();
    await reader.read();
    await flush();
    await reader.cancel();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sends a visible timeout even if status never settles', async () => {
    jest.useFakeTimers();
    const run = { runId: 'run', status: new Promise<string>(() => {}), returnValue: Promise.resolve(null) };
    const reader = assistantResponseStream(run, 'instance', 'log', { timeoutMs: 100 }).body!.getReader();
    await reader.read();
    await jest.advanceTimersByTimeAsync(100);
    expect(decode((await reader.read()).value)).toContain('ASSISTANT_RESPONSE_TIMEOUT');
    expect((await reader.read()).done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('closes on a request abort and ignores late status results', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    const run = { runId: 'run', status: new Promise<string>(done => { resolve = done; }), returnValue: Promise.resolve(null) };
    const reader = assistantResponseStream(run, 'instance', 'log', { signal: controller.signal }).body!.getReader();
    await reader.read();
    controller.abort();
    resolve('completed');
    await flush();
    expect((await reader.read()).done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['completed', { assistant_response: 'Answer' }, 'completed'],
    ['completed', { success: false, execution_status: 'exhausted' }, 'error'],
    ['completed', { success: false, execution_status: 'continuing' }, 'error'],
    ['failed', null, 'error'],
    ['cancelled', null, 'error'],
  ])('reaches actual EOF and releases observation resources for %s / %j', async (status, result, terminal) => {
    jest.useFakeTimers();
    const abort = new AbortController();
    const removeListener = jest.spyOn(abort.signal, 'removeEventListener');
    const getStatus = jest.fn().mockResolvedValue(status);
    const getReturnValue = jest.fn().mockResolvedValue(result);
    const cancelRun = jest.fn();
    const run = {
      runId: 'run',
      get status() { return getStatus(); },
      get returnValue() { return getReturnValue(); },
      cancel: cancelRun,
    };
    const reader = assistantResponseStream(run, 'instance', 'log', { signal: abort.signal }).body!.getReader();
    expect(decode((await reader.read()).value)).toContain('event: accepted');
    expect(decode((await reader.read()).value)).toContain(`event: ${terminal}`);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(reader.closed).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    abort.abort();
    await jest.advanceTimersByTimeAsync(800_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getReturnValue).toHaveBeenCalledTimes(status === 'completed' ? 1 : 0);
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('releases EOF on timeout while returnValue is pending and ignores its late completion', async () => {
    jest.useFakeTimers();
    let complete!: (value: unknown) => void;
    const getReturnValue = jest.fn(() => new Promise(resolve => { complete = resolve; }));
    const run = {
      runId: 'run', status: Promise.resolve('completed'),
      get returnValue() { return getReturnValue(); },
    };
    const reader = assistantResponseStream(run, 'instance', 'log', { timeoutMs: 100 }).body!.getReader();
    await reader.read();
    await flush();
    expect(getReturnValue).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(decode((await reader.read()).value)).toContain('ASSISTANT_RESPONSE_TIMEOUT');
    expect((await reader.read()).done).toBe(true);
    complete({ assistant_response: 'Late answer must not reopen the stream' });
    await flush();
    await expect(reader.closed).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });
});