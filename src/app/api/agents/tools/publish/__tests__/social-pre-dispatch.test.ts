import { randomBytes } from 'node:crypto';
import type { PublishToolParams } from '../assistantProtocol';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('@/lib/database/content-db', () => ({ getContentById: jest.fn() }));
jest.mock('../../content/create/core', () => ({ createContentCore: jest.fn() }));
jest.mock('../../content/update/core', () => ({ updateContentCore: jest.fn() }));
jest.mock('../media-transfer-http', () => ({ downloadMedia: jest.fn(), putMedia: jest.fn() }));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getContentById } from '@/lib/database/content-db';
import { createContentCore } from '../../content/create/core';
import { updateContentCore } from '../../content/update/core';
import { publishSocialContent } from '../social-publishing';
import { OutstandClient } from '@/lib/integrations/outstand/client';
import { OutstandPreDispatchError } from '@/lib/integrations/outstand/pre-dispatch-error';
import { ResourceLicenseError } from '@/lib/billing/licensed-resources';
import { SocialAccountResolutionError } from '@/lib/integrations/outstand/accounts';

const site = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const key = randomBytes(24).toString('hex');
const account = { id: 'selected', network: 'linkedin', username: 'owned', tenant_id: site, isActive: true };
const input: PublishToolParams = { title: 'Post', type: 'social_post', text: 'Caption', social_accounts: [account.id] };
const accepted = { success: true, post: { id: 'provider-post', socialAccounts: [{ id: account.id, status: 'pending' }] } };
const originalKey = process.env.OUTSTAND_API_KEY;
let row: Record<string, any> | null;
let accountReads: number;
let posts: RequestInit[];
let guardReadFailure: (() => Response) | undefined;
let postFailure: (() => Response) | undefined;

const rpcResult = (data: unknown, error: unknown = null) => ({ abortSignal: async () => ({ data, error }) });
const projection = { effective_plan: 'engine', channels: { connections: [] },
  social_media: [{ ...account, license_suspended: false }] };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OUTSTAND_API_KEY = key;
  row = null; accountReads = 0; posts = []; guardReadFailure = undefined; postFailure = undefined;
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(projection));
  (getContentById as jest.Mock).mockImplementation(async () => row && structuredClone(row));
  (createContentCore as jest.Mock).mockImplementation(async fields => {
    row = { ...structuredClone(fields), id, updated_at: new Date().toISOString() };
    return { id, status: fields.status };
  });
  (updateContentCore as jest.Mock).mockImplementation(async fields => {
    row = { ...row, ...structuredClone(fields), updated_at: new Date().toISOString() };
    return { id, status: row?.status };
  });
  // Exercise the real content-attempt CAS; only the database query is replaced.
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    expect(table).toBe('content');
    let fields: Record<string, unknown>;
    const matches: Record<string, unknown> = {};
    const query = {
      update: (value: Record<string, unknown>) => { fields = value; return query; },
      eq: (field: string, value: unknown) => { matches[field] = value; return query; },
      is: (field: string, value: unknown) => { matches[field] = value; return query; },
      select: () => query,
      maybeSingle: async () => {
        expect(matches).toEqual({ id, site_id: site, updated_at: row?.updated_at,
          metadata: row?.metadata ? JSON.stringify(row.metadata) : null });
        row = { ...row, ...structuredClone(fields) };
        return { data: { id, status: row.status }, error: null };
      },
    };
    return query;
  });
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    expect(target.origin).toBe('https://api.outstand.so');
    expect((init?.headers as Record<string, string>)['X-Tenant-ID']).toBe(site);
    if (target.pathname === '/v1/social-accounts') {
      expect(init?.method).toBe('GET');
      expect(target.searchParams.get('tenantId')).toBe(site);
      accountReads += 1;
      if (accountReads === 2 && guardReadFailure) return guardReadFailure();
      return Response.json({ success: true, data: [account], total: 1 });
    }
    expect(target.pathname).toBe('/v1/posts/');
    expect(init?.method).toBe('POST');
    posts.push(init!);
    return postFailure ? postFailure() : Response.json(accepted);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalKey === undefined) delete process.env.OUTSTAND_API_KEY;
  else process.env.OUTSTAND_API_KEY = originalKey;
});

describe('actual Outstand preflight and publishing persistence', () => {
  test('second account GET 503 saves a safely retryable draft, then the same content_id can send once', async () => {
    guardReadFailure = () => Response.json({ error: key }, { status: 503 });
    const first = await publishSocialContent(site, undefined, input, { retained: true });
    expect(accountReads).toBe(2);
    expect(posts).toHaveLength(0);
    expect(createContentCore).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ success: false, content: { id, status: 'draft' },
      social: { status: 'failed', retry_safe: true, account_ids: [account.id] } });
    expect(first.social.error).toContain('No post was sent');
    expect(JSON.stringify(first)).not.toContain(key);
    expect(row).toMatchObject({ status: 'draft', metadata: { retained: true,
      social_publication: { status: 'failed', retry_safe: true } } });

    const second = await publishSocialContent(site, undefined, { ...input, content_id: id }, {});
    expect(second).toMatchObject({ success: true, content: { id, status: 'draft' },
      social: { status: 'pending', retry_safe: false, post_id: 'provider-post' } });
    expect(accountReads).toBe(4);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body as string)).toEqual({ accounts: [account.id], containers: [{ content: 'Caption' }] });
    expect(createContentCore).toHaveBeenCalledTimes(1);
    expect(row?.metadata.social_publication.attempt_id).toEqual(expect.any(String));
  });

  test.each(['TimeoutError', 'AbortError'])('guard GET %s is retryable with zero POSTs', async name => {
    guardReadFailure = () => { throw new DOMException(key, name); };
    const result = await publishSocialContent(site, undefined, input, {});
    expect(result.social).toMatchObject({ status: 'failed', retry_safe: true });
    expect(accountReads).toBe(2);
    expect(createContentCore).toHaveBeenCalledTimes(1);
    expect(row?.metadata.social_publication).toMatchObject({ status: 'failed', retry_safe: true });
    expect(posts).toHaveLength(0);
    expect(row?.metadata.social_publication).toMatchObject({ status: 'failed', retry_safe: true });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  test.each(['missing projection', 'license expired'])('second authorization %s cannot dispatch and remains retryable', async failure => {
    (supabaseAdmin.rpc as jest.Mock).mockReturnValueOnce(rpcResult(projection))
      .mockReturnValueOnce(failure === 'missing projection' ? rpcResult(null, { code: 'PGRST202' })
        : rpcResult({ ...projection, social_media: [{ ...account, license_suspended: true }] }));
    const result = await publishSocialContent(site, undefined, input, {});
    expect(result.social).toMatchObject({ status: 'failed', retry_safe: true });
    expect(posts).toHaveLength(0);
  });

  test.each(['503', 'network timeout', 'account error', 'license error', 'untrusted marker'])('actual POST %s remains unknown and blocks retries', async failure => {
    postFailure = () => {
      if (failure === '503') return Response.json({ error: key }, { status: 503 });
      if (failure === 'account error') throw new SocialAccountResolutionError('ACCOUNT_PROVIDER_ERROR', key);
      if (failure === 'license error') throw new ResourceLicenseError(503);
      if (failure === 'untrusted marker') throw Object.assign(new Error(key), {
        name: 'OutstandPreDispatchError', code: 'OUTSTAND_PRE_DISPATCH_FAILED', retry_safe: true,
      });
      throw new DOMException(key, 'TimeoutError');
    };
    const first = await publishSocialContent(site, undefined, input, {});
    expect(accountReads).toBe(2);
    expect(first.social).toMatchObject({ status: 'unknown', retry_safe: false });
    expect(row?.metadata.social_publication).toMatchObject({ status: 'unknown', retry_safe: false });
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain(key);
    const retry = await publishSocialContent(site, undefined, { ...input, content_id: id }, {});
    expect(retry.social).toMatchObject({ status: 'unknown', retry_safe: false });
    expect(posts).toHaveLength(1);
    expect(accountReads).toBe(2);
  });
});

describe('trusted pre-dispatch error contract', () => {
  test('sanitizes unknown original causes rather than retaining messages or provider payloads', () => {
    const original = Object.assign(new Error(key), { response: { body: key }, cause: new Error(key) });
    const error = new OutstandPreDispatchError(original);
    expect(error).toBeInstanceOf(OutstandPreDispatchError);
    expect(error.cause).not.toBe(original);
    expect(error.status).toBe(503);
    expect(`${error.message} ${error.cause.stack} ${JSON.stringify(error)}`).not.toContain(key);
  });

  test('preserves trusted license status and sanitized account error code', () => {
    expect(new OutstandPreDispatchError(new ResourceLicenseError(403))).toMatchObject({ status: 403 });
    const error = new OutstandPreDispatchError(new SocialAccountResolutionError('ACCOUNT_PROVIDER_ERROR', key));
    expect(error.cause).toMatchObject({ code: 'ACCOUNT_PROVIDER_ERROR' });
    expect(error.cause.message).not.toContain(key);
  });

  test('unscoped post creation still denies before any provider I/O', async () => {
    await expect(new OutstandClient(key).createPost({ accounts: [account.id], content: 'Caption' }))
      .rejects.toMatchObject({ code: 'OUTSTAND_PRE_DISPATCH_FAILED', status: 403 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('cancellation after authorization but before POST has a trusted pre-dispatch marker', async () => {
    const controller = new AbortController();
    (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: async () => {
      controller.abort(new DOMException(key, 'AbortError'));
      return { data: projection, error: null };
    } });
    await expect(new OutstandClient(key, controller.signal).createPost({ accounts: [account.id], content: 'Caption' }, site))
      .rejects.toBeInstanceOf(OutstandPreDispatchError);
    expect(accountReads).toBe(1);
    expect(posts).toHaveLength(0);
  });

  test('payload serialization failure before POST has a trusted pre-dispatch marker', async () => {
    const params = { accounts: [account.id], content: 'Caption', toJSON: () => { throw new Error(key); } };
    await expect(new OutstandClient(key).createPost(params, site)).rejects.toBeInstanceOf(OutstandPreDispatchError);
    expect(accountReads).toBe(1);
    expect(posts).toHaveLength(0);
  });
});