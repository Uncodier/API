import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OutstandClient } from '@/lib/integrations/outstand/client';

const getComments = jest.fn<OutstandClient['getComments']>();
const getOutstandClient = jest.fn(() => ({ getComments }));
jest.unstable_mockModule('@/lib/integrations/outstand/client', () => ({ getOutstandClient }));
jest.unstable_mockModule('next/server', () => ({ NextResponse: { json: Response.json } }));

let GET: typeof import('../route').GET;
beforeAll(async () => {
  ({ GET } = await import('../route'));
});

const context = { params: Promise.resolve({ id: 'post-1' }) };
const request = (query = '') => new Request(
  `https://api.example.test/api/integrations/outstand/posts/post-1/comments?${query}`,
);
const result = { success: true as const, data: [{ id: 'comment-1', text: 'Example comment' }] };

describe('Outstand comments GET author resolution', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    getComments.mockReset().mockResolvedValue(result);
    getOutstandClient.mockReset().mockReturnValue({ getComments });
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
  });

  afterEach(() => {
    expect(fetchMock).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it.each([undefined, false, true])('parses the optional boolean without defaulting to true: %s', async (value) => {
    const query = value === undefined ? '' : `&resolve_author_names=${value}`;
    const response = await GET(request(`network=LinkedIn&username=example-profile&tenant_id=site-1${query}`), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(getComments).toHaveBeenCalledTimes(1);
    expect(getComments).toHaveBeenCalledWith('post-1', {
      network: 'linkedin', username: 'example-profile', resolve_author_names: value,
    }, 'site-1');
    expect(response.headers.get('Cache-Control')).toBe(value === true ? 'private, no-store' : null);
  });

  it('leaves author resolution disabled for existing callers without query options', async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(getComments).toHaveBeenCalledWith('post-1', {
      network: undefined, username: undefined, resolve_author_names: undefined,
    }, undefined);
    expect(response.headers.get('Cache-Control')).toBeNull();
  });

  it('protects opt-in responses when the client infers the networks and preserves provider data', async () => {
    const resolved = {
      success: true as const,
      data: [{ id: 'linkedin-comment', author_name: 'Example member' }],
      replies: { comments: [{ id: 'linkedin-comment' }], cursor: 'next' },
    };
    getComments.mockResolvedValueOnce(resolved);

    const response = await GET(request('tenant_id=site-1&resolve_author_names=true'), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resolved);
    expect(getComments).toHaveBeenCalledWith('post-1', {
      network: undefined, username: undefined, resolve_author_names: true,
    }, 'site-1');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('leaves non-LinkedIn filtering to the client while keeping opt-in responses private', async () => {
    const response = await GET(request('network=Twitter&resolve_author_names=true'), context);

    expect(response.status).toBe(200);
    expect(getComments).toHaveBeenCalledWith('post-1', {
      network: 'x', username: undefined, resolve_author_names: true,
    }, undefined);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it.each(['', 'TRUE', 'FALSE', 'True', 'False', '1', '0', 'yes', 'no', 'null', 'undefined', ' true ', 'true,false'])(
    'rejects resolve_author_names=%j before accessing the client', async (value) => {
      const response = await GET(request(`resolve_author_names=${encodeURIComponent(value)}`), context);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'resolve_author_names must be true or false' });
      expect(getOutstandClient).not.toHaveBeenCalled();
      expect(getComments).not.toHaveBeenCalled();
    },
  );

  it.each([
    'resolve_author_names',
    'resolve_author_names=true&resolve_author_names=false',
    'resolve_author_names=false&resolve_author_names=true',
    'resolve_author_names=true&resolve_author_names=true',
    'resolve_author_names=false&resolve_author_names=invalid',
  ])('rejects bare or repeated flags: %s', async (query) => {
    const response = await GET(request(query), context);

    expect(response.status).toBe(400);
    expect(getOutstandClient).not.toHaveBeenCalled();
    expect(getComments).not.toHaveBeenCalled();
  });

  it.each([
    { status: 502, upstreamStatus: 503 },
    { status: 429, upstreamStatus: 429 },
    { status: undefined, upstreamStatus: undefined },
  ])('preserves errors and prevents caching with opt-in: %j', async (details) => {
    getComments.mockRejectedValueOnce(Object.assign(new Error('Provider failure'), details));

    const response = await GET(request('network=linkedin&resolve_author_names=true'), context);

    expect(response.status).toBe(details.status || 500);
    expect(await response.json()).toEqual({
      error: 'Provider failure',
      ...(details.upstreamStatus === undefined ? {} : { upstream_status: details.upstreamStatus }),
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('preserves the existing error response without opt-in', async () => {
    getComments.mockRejectedValueOnce(Object.assign(new Error('Provider failure'), { status: 502, upstreamStatus: 503 }));

    const response = await GET(request(), context);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Provider failure', upstream_status: 503 });
    expect(response.headers.get('Cache-Control')).toBeNull();
  });
});