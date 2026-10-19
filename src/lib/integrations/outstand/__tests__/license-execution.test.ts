import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
const rpc = jest.fn<any>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
const { OutstandClient } = await import('../client');
const site = '11111111-1111-4111-8111-111111111111';
const key = randomBytes(24).toString('hex');
const account = { id: 'account', network: 'instagram', username: 'owned', isActive: true, tenant_id: site };
let suspended: boolean;
let failure: boolean;
let effects: string[];
beforeEach(() => {
  suspended = false; failure = false; effects = [];
  rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: failure ? { code: 'PGRST202' } : null,
    data: { effective_plan: suspended ? 'commission' : 'engine', channels: { connections: [] },
      social_media: [{ ...account, isActive: !suspended, license_suspended: suspended }] },
  }) }));
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (init?.method === 'POST') effects.push(String(url));
    const data = String(url).includes('/social-accounts') ? { success: true, data: [account], total: 1 }
      : String(url).includes('/conversations/') && init?.method === 'GET'
        ? { conversation: { id: 'dm', socialAccountId: account.id } }
        : String(url).includes('/posts/') && init?.method === 'GET'
          ? { post: { socialAccounts: [account] } } : { success: true, message: { id: 'accepted' } };
    return new Response(JSON.stringify(data));
  });
});
afterEach(() => jest.restoreAllMocks());

const operations = {
  post: (client: InstanceType<typeof OutstandClient>) => client.createPost({ accounts: [account.id], content: 'Hello' }, site),
  comment: (client: InstanceType<typeof OutstandClient>) => client.publishComment('post', {
    network: 'instagram', account_username: 'owned', content: 'Hello',
  }, site),
  dm: (client: InstanceType<typeof OutstandClient>) => client.sendConversationMessage('dm', { content: 'Hello' }, site),
};
test.each(Object.keys(operations))('licensed %s reaches provider once', async operation => {
  await operations[operation as keyof typeof operations](new OutstandClient(key));
  expect(effects).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: site });
});
test.each(Object.keys(operations))('expired %s denies even when provider account remains active', async operation => {
  suspended = true;
  await expect(operations[operation as keyof typeof operations](new OutstandClient(key))).rejects.toMatchObject({ status: 403 });
  expect(effects).toEqual([]);
});
test.each(Object.keys(operations))('missing projection denies %s without provider POST', async operation => {
  failure = true;
  await expect(operations[operation as keyof typeof operations](new OutstandClient(key))).rejects.toMatchObject({ status: 503 });
  expect(effects).toEqual([]);
});
test('an unscoped old workflow cannot publish by falling back to provider global inventory', async () => {
  await expect(new OutstandClient(key).createPost({ accounts: [account.id], content: 'Hello' })).rejects.toThrow();
  expect(global.fetch).not.toHaveBeenCalled();
});