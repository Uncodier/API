import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OutstandClient } from '../client';

const params = { network: 'facebook', username: 'example-page' };
const raw = { id: 'comment-1', message: 'Raw comment', from: { name: 'Example person' } };
const normalized = { id: 'comment-1', text: 'Normalized comment', author_name: 'Example person' };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const postResponse = () => jsonResponse({
  success: true,
  post: {
    socialAccounts: [
      { network: 'facebook', username: 'example-page' },
      { network: 'instagram', username: 'example-profile' },
      { network: 'facebook', username: 'example-page' },
    ],
  },
});

describe('OutstandClient.getComments', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let client: OutstandClient;

  beforeEach(() => {
    // No unexpected request may fall through to a live provider.
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
    client = new OutstandClient('test-key');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([undefined, false, true])('only resolves LinkedIn authors with explicit opt-in: %s', async (resolveAuthorNames) => {
    const response = {
      success: true,
      data: [{ id: 'linkedin-comment', author_name: resolveAuthorNames ? 'Example member' : null }],
      replies: { comments: [{ id: 'linkedin-comment' }], cursor: 'next' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(response));
    const options = resolveAuthorNames === undefined ? {} : { resolve_author_names: resolveAuthorNames };

    await expect(client.getComments('post-1', {
      network: 'linkedin', username: 'example-profile', ...options,
    }, 'site-1')).resolves.toEqual(response);

    const query = resolveAuthorNames === undefined ? '' : `&resolve_author_names=${resolveAuthorNames}`;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.outstand.so/v1/posts/post-1/replies?network=linkedin&username=example-profile${query}`,
      {
        method: 'GET',
        headers: { Authorization: 'Bearer test-key', 'X-Tenant-ID': 'site-1' },
        ...(resolveAuthorNames === true ? { cache: 'no-store' } : {}),
      },
    );
  });

  it.each(['facebook', 'instagram', 'x'])('never sends author resolution to %s', async (network) => {
    for (const resolveAuthorNames of [false, true]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

      await client.getComments('post-1', {
        network, username: 'example-profile', resolve_author_names: resolveAuthorNames,
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe(`https://api.outstand.so/v1/posts/post-1/replies?network=${network}&username=example-profile`);
      expect(options).toEqual({ method: 'GET', headers: { Authorization: 'Bearer test-key' } });
    }
  });

  it.each([undefined, false, true])('limits inferred multi-network author resolution to LinkedIn: %s', async (resolveAuthorNames) => {
    const linkedin = { id: 'linkedin-comment', author_name: resolveAuthorNames ? 'Example member' : null };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        post: { socialAccounts: [
          { network: 'facebook', username: 'example-page' },
          { network: 'linkedin', username: 'example-profile' },
          { network: 'linkedin', username: 'example-profile' },
        ] },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [normalized] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [linkedin] }));

    await expect(client.getComments('post-1', {
      resolve_author_names: resolveAuthorNames,
    }, 'site-1')).resolves.toEqual({
      success: true,
      replies: [normalized, linkedin],
      data: [normalized, linkedin],
    });

    const query = resolveAuthorNames === undefined ? '' : `&resolve_author_names=${resolveAuthorNames}`;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.outstand.so/v1/posts/post-1',
      'https://api.outstand.so/v1/posts/post-1/replies?network=facebook&username=example-page',
      `https://api.outstand.so/v1/posts/post-1/replies?network=linkedin&username=example-profile${query}`,
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options?.cache)).toEqual([
      undefined, undefined, resolveAuthorNames === true ? 'no-store' : undefined,
    ]);
    expect(fetchMock.mock.calls.every(([, options]) =>
      (options?.headers as Record<string, string>)['X-Tenant-ID'] === 'site-1',
    )).toBe(true);
  });

  it('does not cache resolved profiles or retain opt-in for subsequent reads', async () => {
    const linkedinParams = { network: 'linkedin', username: 'example-profile' };
    for (const authorName of ['First name', 'Updated name']) {
      const response = { success: true, data: [{ id: 'linkedin-comment', author_name: authorName }] };
      fetchMock.mockResolvedValueOnce(jsonResponse(response));
      await expect(client.getComments('post-1', {
        ...linkedinParams, resolve_author_names: true,
      })).resolves.toEqual(response);
    }
    const unresolved = { success: true, data: [{ id: 'linkedin-comment' }] };
    fetchMock.mockResolvedValueOnce(jsonResponse(unresolved));
    await expect(client.getComments('post-1', linkedinParams)).resolves.toEqual(unresolved);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('resolve_author_names')))
      .toEqual(['true', 'true', null]);
    expect(fetchMock.mock.calls.map(([, options]) => options?.cache)).toEqual(['no-store', 'no-store', undefined]);
  });

  it.each([
    { success: true, data: [normalized] },
    { success: true, replies: [raw], data: [normalized] },
    { success: true, replies: { comments: [raw], cursor: 'next' }, data: [normalized] },
    { success: true, replies: { comments: [raw] }, data: [] },
  ])('preserves successful public envelopes and normalized data: %j', async (response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(client.getComments('post-1', params, 'site-1')).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.outstand.so/v1/posts/post-1/replies?network=facebook&username=example-page',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer test-key', 'X-Tenant-ID': 'site-1' },
      },
    );
  });

  it.each([
    { success: true, replies: [raw] },
    { success: true, replies: { comments: [raw] } },
  ])('exposes raw comments as data without changing replies: %j', async (response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(client.getComments('post-1', params)).resolves.toEqual({
      ...response,
      data: [raw],
    });
  });

  it.each([
    { success: true, data: [] },
    { success: true, replies: [] },
    { success: true, replies: { comments: [] } },
  ])('accepts genuine empty collections: %j', async (response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(client.getComments('post-1', params)).resolves.toEqual({ ...response, data: [] });
  });

  it.each([500, 502, 503, 504])('propagates upstream %i as a retryable 502', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Provider unavailable' }, status));

    await expect(client.getComments('post-1', params)).rejects.toMatchObject({
      status: 502,
      upstreamStatus: status,
    });
  });

  it.each([400, 401, 403, 404, 429])('preserves upstream HTTP %i errors', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Provider rejected request' }, status));

    await expect(client.getComments('post-1', params)).rejects.toMatchObject({
      status,
      upstreamStatus: status,
    });
  });

  it('propagates a transport failure without returning empty comments', async () => {
    const error = new TypeError('Network unavailable');
    fetchMock.mockRejectedValueOnce(error);

    await expect(client.getComments('post-1', params)).rejects.toBe(error);
  });

  it.each([
    { success: false, error: 'Provider unavailable', data: [] },
    { success: true, degraded: true, data: [], warning: 'Provider unavailable' },
    null,
    {},
    { success: true, replies: {} },
    { success: true, data: null, replies: { comments: [raw] } },
    { success: true, data: [normalized, null] },
  ])('rejects invalid or unsuccessful HTTP-200 envelopes: %j', async (response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(client.getComments('post-1', params)).rejects.toMatchObject({ status: 502 });
  });

  it.each(['', '<html>Provider unavailable</html>', '{'])('rejects malformed response text: %j', async (text) => {
    fetchMock.mockResolvedValueOnce(new Response(text));

    await expect(client.getComments('post-1', params)).rejects.toMatchObject({ status: 502 });
  });

  it('merges all resolved networks with their own usernames and canonical data', async () => {
    fetchMock
      .mockResolvedValueOnce(postResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, replies: [raw], data: [normalized] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, replies: { comments: [{ id: 'comment-2' }] } }));

    await expect(client.getComments('post-1', {}, 'site-1')).resolves.toEqual({
      success: true,
      replies: [normalized, { id: 'comment-2' }],
      data: [normalized, { id: 'comment-2' }],
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.outstand.so/v1/posts/post-1',
      'https://api.outstand.so/v1/posts/post-1/replies?network=facebook&username=example-page',
      'https://api.outstand.so/v1/posts/post-1/replies?network=instagram&username=example-profile',
    ]);
    expect(fetchMock.mock.calls.every(([, options]) =>
      (options?.headers as Record<string, string>)['X-Tenant-ID'] === 'site-1',
    )).toBe(true);
  });

  it.each([0, 1])('rejects the whole read when network %i fails, then allows a complete retry', async (failedIndex) => {
    fetchMock.mockResolvedValueOnce(postResponse());
    for (let index = 0; index < 2; index += 1) {
      fetchMock.mockResolvedValueOnce(index === failedIndex
        ? jsonResponse({ error: 'Temporarily unavailable' }, 503)
        : jsonResponse({ success: true, data: [{ id: `comment-${index}` }] }));
    }

    await expect(client.getComments('post-1')).rejects.toMatchObject({ status: 502, upstreamStatus: 503 });

    fetchMock
      .mockResolvedValueOnce(postResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 'comment-0' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 'comment-1' }] }));

    await expect(client.getComments('post-1')).resolves.toEqual({
      success: true,
      replies: [{ id: 'comment-0' }, { id: 'comment-1' }],
      data: [{ id: 'comment-0' }, { id: 'comment-1' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    { success: false, error: 'Provider failed', data: [] },
    { success: true, degraded: true, data: [] },
    { success: true, replies: {} },
  ])('does not hide an unsuccessful HTTP-200 network behind successful siblings: %j', async (failure) => {
    fetchMock
      .mockResolvedValueOnce(postResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [normalized] }))
      .mockResolvedValueOnce(jsonResponse(failure));

    await expect(client.getComments('post-1')).rejects.toMatchObject({ status: 502 });
  });

  it('preserves a rate-limit failure from one network instead of completing with its sibling', async () => {
    fetchMock
      .mockResolvedValueOnce(postResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [normalized] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Rate limited' }, 429));

    await expect(client.getComments('post-1')).rejects.toMatchObject({ status: 429, upstreamStatus: 429 });
  });

  it('rejects a partial transport failure unchanged', async () => {
    const error = new TypeError('Network unavailable');
    fetchMock
      .mockResolvedValueOnce(postResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [normalized] }))
      .mockRejectedValueOnce(error);

    await expect(client.getComments('post-1')).rejects.toBe(error);
  });

  it('resolves a missing username for an explicitly selected network', async () => {
    fetchMock
      .mockResolvedValueOnce(postResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [normalized] }));

    await expect(client.getComments('post-1', { network: 'instagram' })).resolves.toEqual({
      success: true,
      data: [normalized],
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.outstand.so/v1/posts/post-1/replies?network=instagram&username=example-profile',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('retains the existing error when no network can be resolved', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, post: { socialAccounts: [] } }));

    await expect(client.getComments('post-1')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure while resolving the post before fetching comments', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Provider unavailable' }, 503));

    await expect(client.getComments('post-1')).rejects.toMatchObject({ status: 502, upstreamStatus: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});