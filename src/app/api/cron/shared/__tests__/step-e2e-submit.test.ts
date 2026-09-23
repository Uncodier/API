import { runE2eSubmitStep } from '../step-e2e-submit';

function pageFor(status: number, method = 'POST') {
  const response = {
    url: () => 'https://sandbox.example/api/contact',
    status: () => status,
    request: () => ({ method: () => method }),
  };
  let exposedCallback: (() => void | Promise<void>) | undefined;
  let responsePredicate: ((value: typeof response) => boolean) | undefined;
  let resolveResponse: ((value: typeof response) => void) | undefined;
  const page: any = {
    waitForSelector: jest.fn().mockResolvedValue({}),
    exposeFunction: jest.fn(
      async (_name: string, callback: () => void | Promise<void>) => {
        exposedCallback = callback;
      },
    ),
    removeExposedFunction: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(undefined),
    waitForResponse: jest.fn((
      predicate: (value: typeof response) => boolean,
      options: { signal?: AbortSignal },
    ) => new Promise<typeof response>((resolve, reject) => {
      responsePredicate = predicate;
      resolveResponse = resolve;
      options.signal?.addEventListener(
        'abort',
        () => reject(new Error('response wait aborted')),
        { once: true },
      );
    })),
  };
  page.emitSubmit = async () => exposedCallback?.();
  page.emitResponse = () => {
    if (responsePredicate?.(response)) resolveResponse?.(response);
  };
  page.click = jest.fn(async () => {
    await page.emitSubmit();
    page.emitResponse();
  });
  return page;
}

const step = {
  action: 'submit' as const,
  selector: 'button[type="submit"]',
  response: {
    path: '/api/contact',
    method: 'POST' as const,
    expected_statuses: [201],
  },
};

describe('E2E submit step', () => {
  it('returns a failing receipt when the endpoint status is wrong', async () => {
    const page = pageFor(500);
    const result = await runE2eSubmitStep(
      page,
      step,
      'https://sandbox.example',
      1_000,
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      receipt: expect.objectContaining({
        pass: false,
        method: 'POST',
        target: '/api/contact',
        actual_status: 500,
      }),
    }));
    expect(page.waitForSelector.mock.invocationCallOrder[0]).toBeLessThan(
      page.waitForResponse.mock.invocationCallOrder[0],
    );
  });

  it('rejects external response targets before clicking', async () => {
    const page = pageFor(201);
    const result = await runE2eSubmitStep(
      page,
      {
        ...step,
        response: { ...step.response, path: 'https://example.com/api/contact' },
      },
      'https://sandbox.example',
      1_000,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('application-relative path');
    expect(page.click).not.toHaveBeenCalled();
  });

  it('aborts the response waiter when clicking fails', async () => {
    let responseSignal: AbortSignal | undefined;
    const page = pageFor(201);
    page.click.mockRejectedValue(new Error('click failed'));
    page.waitForResponse.mockImplementation(
      (_predicate: unknown, options: { signal: AbortSignal }) => {
        responseSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new Error('response wait aborted')),
            { once: true },
          );
        });
      },
    );

    await expect(
      runE2eSubmitStep(page, step, 'https://sandbox.example', 1_000),
    ).rejects.toThrow('click failed');
    expect(responseSignal?.aborted).toBe(true);
  });

  it('rejects a matching background response without a submit event', async () => {
    const page = pageFor(201);
    const backgroundResponse = {
      url: () => 'https://sandbox.example/api/contact',
      status: () => 201,
      request: () => ({ method: () => 'POST' }),
    };
    page.waitForResponse.mockImplementation(
      (predicate: (value: typeof backgroundResponse) => boolean) => {
        expect(predicate(backgroundResponse)).toBe(false);
        return Promise.reject(new Error('response timeout'));
      },
    );
    page.click.mockImplementation(() => page.emitSubmit());

    await expect(
      runE2eSubmitStep(page, step, 'https://sandbox.example', 1_000),
    ).rejects.toThrow('response timeout');
  });
});
