import { installWorkflowSafeFetch } from '../safe-fetch';

describe('installWorkflowSafeFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: originalFetch,
    });
  });

  it('strips dispatcher before calling the inner fetch', async () => {
    const inner = jest.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = inner as unknown as typeof fetch;

    installWorkflowSafeFetch();

    await globalThis.fetch('https://example.com', {
      method: 'POST',
      dispatcher: { not: 'an-undici-agent' },
    } as RequestInit);

    expect(inner).toHaveBeenCalledTimes(1);
    const init = inner.mock.calls[0][1];
    expect(init).not.toHaveProperty('dispatcher');
    expect(init.method).toBe('POST');
  });

  it('keeps stripping after Next.js replaces global fetch', async () => {
    const first = jest.fn().mockResolvedValue(new Response('a'));
    const second = jest.fn().mockResolvedValue(new Response('b'));
    globalThis.fetch = first as unknown as typeof fetch;

    installWorkflowSafeFetch();
    globalThis.fetch = second as unknown as typeof fetch;

    await globalThis.fetch('https://example.com', {
      dispatcher: {},
    } as RequestInit);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][1]).not.toHaveProperty('dispatcher');
  });
});
