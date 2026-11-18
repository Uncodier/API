import { randomBytes } from 'node:crypto';
import { resolveHandler } from '../handlers';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createNotificationsModule } from '@/templates/uncodie-sdk/notifications';
import type { UncodieClient } from '@/templates/uncodie-sdk/client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../with-platform-scope', () => ({ withPlatformScope: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-execution', () => ({}));

const siteId = '00000000-0000-4000-8000-000000000001';
const requirementId = '00000000-0000-4000-8000-000000000002';
const ownerId = '00000000-0000-4000-8000-000000000003';
const notificationId = '00000000-0000-4000-8000-000000000004';
const context = {
  site_id: siteId, requirement_id: requirementId, api_key_id: 'key-1',
  scopes: ['notifications.create'], test_only: false,
  capability: 'notifications', scope: 'notifications.create',
};

function query(result: unknown) {
  const chain = {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

describe('platform notification schema and tenant contract (offline)', () => {
  let site: ReturnType<typeof query>;
  let requirement: ReturnType<typeof query>;
  let notification: ReturnType<typeof query>;
  const entry = resolveHandler('POST', ['notifications'])!;
  function invoke(body: unknown, ctx = context) {
    return entry.handler({ json: async () => body } as any, ctx);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    site = query({ data: { user_id: ownerId }, error: null });
    requirement = query({ data: { id: requirementId }, error: null });
    notification = query({ data: { id: notificationId }, error: null });
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'sites') return site;
      if (table === 'requirements') return requirement;
      if (table === 'notifications') return notification;
      throw new Error(`Unexpected database table ${table}`);
    });
  });

  it('is registered with the notification scope and inserts only real schema columns', async () => {
    expect(entry).toMatchObject({ scope: 'notifications.create', endpoint: '/api/platform/notifications' });
    expect(await invoke({ title: ' Deployment ready ', message: ' Version 2 passed all checks. ', type: 'success' }))
      .toEqual({ status: 201, body: { id: notificationId } });
    expect(site.select).toHaveBeenCalledWith('user_id');
    expect(site.eq).toHaveBeenCalledWith('id', siteId);
    expect(requirement.eq.mock.calls).toEqual([['id', requirementId], ['site_id', siteId]]);
    expect(notification.insert).toHaveBeenCalledWith({
      title: 'Deployment ready', message: 'Version 2 passed all checks.', type: 'success',
      site_id: siteId, user_id: ownerId, related_entity_type: 'requirement', related_entity_id: requirementId,
    });
  });

  it('supports legacy body/level and ignores metadata including forged scope/recipient fields', async () => {
    await invoke({ title: 'Check results', body: 'Three checks need review.', level: 'warn', metadata: {
      user_id: 'other-user', site_id: 'other-site', requirement_id: 'other-requirement',
      action_url: '//example.invalid',
    } });
    expect(notification.insert).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Three checks need review.', type: 'warning', user_id: ownerId, site_id: siteId,
    }));
    for (const column of ['body', 'level', 'metadata', 'action_url']) {
      expect(notification.insert.mock.calls[0][0]).not.toHaveProperty(column);
    }
  });

  it('prefers canonical fields and bounds text without losing details', async () => {
    await invoke({ title: 't'.repeat(250), message: 'm'.repeat(4500), body: 'legacy', type: 'error', level: 'info' });
    expect(notification.insert).toHaveBeenCalledWith(expect.objectContaining({
      title: 't'.repeat(200), message: 'm'.repeat(4000), type: 'error',
    }));
  });

  it.each(['info', 'warning', 'success', 'error'])('accepts schema type %s', async type => {
    expect((await invoke({ title: 'Notice', message: 'Review the check results.', type })).status).toBe(201);
    expect(notification.insert.mock.calls[0][0].type).toBe(type);
  });

  it('defaults to info and links unbound keys to their site', async () => {
    await invoke({ title: 'Notice', message: 'Review site configuration.' }, { ...context, requirement_id: null } as any);
    expect(requirement.eq).not.toHaveBeenCalled();
    expect(notification.insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info', related_entity_type: 'site', related_entity_id: siteId,
    }));
  });

  it.each([
    null, [], 'invalid', {}, { title: ' ' }, { title: 'Notice' },
    { title: 'Notice', message: ' ' }, { title: 'Notice', body: 7 },
    { title: 'Notice', message: '', body: 'must not override canonical field' },
    { title: 'Notice', message: 'Details', type: 'urgent' },
    { title: 'Notice', message: 'Details', type: null },
  ])('rejects invalid or detail-free input before database access (%j)', async body => {
    expect((await invoke(body)).status).toBe(400);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each(['site_id', 'user_id', 'related_entity_type', 'related_entity_id'])('rejects client %s override', async field => {
    expect((await invoke({ title: 'Notice', message: 'Details', [field]: 'other-tenant' })).status).toBe(400);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each(['https://example.invalid', '//example.invalid', '/requirements/other', '/settings/site', '/safe'])
    ('does not support caller action_url even when internal-looking (%s)', async action_url => {
      expect((await invoke({ title: 'Notice', message: 'Details', action_url })).status).toBe(400);
      expect(supabaseAdmin.from).not.toHaveBeenCalled();
    });

  it('fails closed when there is no site owner or the requirement is outside the site', async () => {
    site.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await invoke({ title: 'Notice', message: 'Details' })).status).toBe(403);
    expect(notification.insert).not.toHaveBeenCalled();
    requirement.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await invoke({ title: 'Notice', message: 'Details' })).status).toBe(403);
    expect(notification.insert).not.toHaveBeenCalled();
  });

  it.each(['site', 'requirement', 'insert'])('reports DB failure without exposing sensitive diagnostics (%s)', async boundary => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/notification');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    const chain = boundary === 'site' ? site : boundary === 'requirement' ? requirement : notification;
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: `Unavailable: ${url}` } });
    const result = await invoke({ title: 'Notice', message: 'Details' });
    expect(result.status).toBe(502);
    for (const sensitive of [username, password, token]) expect(JSON.stringify(result)).not.toContain(sensitive);
    if (boundary !== 'insert') expect(notification.insert).not.toHaveBeenCalled();
  });

  it('does not report a successful insert without an ID', async () => {
    notification.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await invoke({ title: 'Notice', message: 'Details' })).status).toBe(502);
  });

  it('rejects malformed JSON without inserting', async () => {
    const result = await entry.handler({ json: async () => { throw new SyntaxError('Invalid JSON'); } } as any, context);
    expect(result.status).toBe(400);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
});

describe('notification SDK compatibility (offline)', () => {
  const post = jest.fn();
  const sdk = createNotificationsModule({ post } as unknown as UncodieClient);
  beforeEach(() => post.mockReset().mockResolvedValue({ id: notificationId }));

  it.each([
    { title: 'Ready', message: 'Build checks passed.', type: 'success' as const },
    { title: 'Review', body: 'Two warnings to review.', level: 'warn' as const },
  ])('forwards canonical and legacy inputs unchanged (%j)', async input => {
    expect(await sdk.create(input)).toEqual({ id: notificationId });
    expect(post).toHaveBeenCalledWith('notifications', input);
  });

  it.each([
    { title: '', message: 'Details' }, { title: ' ', body: 'Details' },
    { title: 'Notice' }, { title: 'Notice', message: ' ' },
    { title: 'Notice', message: '', body: 'legacy' },
  ])('requires a title and meaningful details (%j)', input => {
    expect(() => sdk.create(input)).toThrow('[uncodie.notifications]');
    expect(post).not.toHaveBeenCalled();
  });
});