import { supabaseAdmin } from '@/lib/database/supabase-client';
import { manageLeadCreation } from '../lead-service';
import { outstandCommentIdentity, OutstandLeadIdentityError } from '../outstand-comment-identity';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('uuid', () => ({ v4: jest.fn() }));

const siteId = '00000000-0000-4000-8000-000000000001';
const leadId = '00000000-0000-4000-8000-000000000002';
const contract = {
  source: 'comment', outstand_post_id: 'post-1', author_identity_status: 'available',
  author_id: 'author-1', author_name: 'Alice Smith', author_username: 'alice',
  publisher_account_id: 'account-1',
};

// Stateful SDK double: no database client, network, environment or provider calls.
function database(rows: any[] = []) {
  const queries: any[] = [];
  const state = {
    rows,
    sites: [{ id: siteId, user_id: 'owner-1' }, { id: 'other-site', user_id: 'owner-2' }],
    fail: '',
    reject: false,
    queries,
  };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (!['leads', 'sites'].includes(table)) throw new Error(`Unexpected table ${table}`);
    const operation: any = { table, action: 'read', filters: [], payload: null };
    queries.push(operation);
    const run = async (single = false) => {
      if (state.fail === `${table}:${operation.action}`) {
        if (state.reject) throw new Error('database offline');
        return { data: null, error: { message: 'database offline' } };
      }
      let result = (table === 'sites' ? state.sites : rows).filter(row => {
        if (operation.handleFilter) {
          const handle = operation.handleFilter.match(/eq\."([^"]+)"/)[1];
          const network = operation.handleFilter.match(/social_networks->>(\w+)/)[1];
          if (row.metadata?.social_handle !== handle && row.social_networks?.[network] !== handle) return false;
        }
        return operation.filters.every(([key, value]: [string, unknown]) => {
          const actual = key.startsWith('metadata->>') ? row.metadata?.[key.slice(11)] : row[key];
          return key === 'metadata' && typeof value === 'string' ? JSON.stringify(actual) === value
            : value === null ? actual == null : actual === value;
        });
      });
      if (operation.action === 'insert') {
        result = operation.payload.map((row: any) => ({ ...row, id: `lead-${rows.length + 1}` }));
        rows.push(...result);
      } else if (operation.action === 'update') {
        result.forEach(row => Object.assign(row, operation.payload));
      }
      if (operation.limit) result = result.slice(0, operation.limit);
      return { data: single ? result[0] || null : result, error: null };
    };
    const query: any = {
      select: jest.fn(() => query),
      eq: jest.fn((key, value) => { operation.filters.push([key, value]); return query; }),
      is: jest.fn((key, value) => { operation.filters.push([key, value]); return query; }),
      or: jest.fn(filter => { operation.handleFilter = filter; return query; }),
      limit: jest.fn(value => { operation.limit = value; return query; }),
      insert: jest.fn(payload => { operation.action = 'insert'; operation.payload = payload; return query; }),
      update: jest.fn(payload => { operation.action = 'update'; operation.payload = payload; return query; }),
      single: jest.fn(() => run(true)),
      maybeSingle: jest.fn(() => run(true)),
      then: (resolve: any, reject: any) => run().then(resolve, reject),
    };
    return query;
  });
  return state;
}

function manage(data: Record<string, unknown> = contract, options: Record<string, unknown> = {}) {
  return manageLeadCreation({
    siteId, origin: 'instagram', name: 'Untrusted top-level name', email: 'other@example.test',
    phone: '5555555555', socialHandle: 'publisher-handle', socialCommentData: data, ...options,
  });
}

function existing(overrides: Record<string, unknown> = {}) {
  return {
    id: leadId, site_id: siteId, origin: 'instagram', name: 'Manual Name',
    metadata: { social_author_id: 'author-1', social_account_id: 'account-1', unrelated: 'keep' },
    social_networks: { facebook: 'manual-facebook' }, ...overrides,
  };
}

describe('Outstand comment contract gate', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    {}, { ...contract, source: 'dm' }, { ...contract, outstand_post_id: '' },
    { ...contract, author_identity_status: undefined }, { ...contract, author_identity_status: '' },
  ])('does not opt in legacy data %j', async data => {
    expect(outstandCommentIdentity('instagram', data)).toBeNull();
    expect(await manage(data, { leadId })).toEqual({ leadId, isNewLead: false, taskId: null });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each(['email', 'whatsapp', 'chat', 'website_chat', undefined])('excludes channel %s', origin => {
    expect(outstandCommentIdentity(origin, contract)).toBeNull();
  });

  it.each(['available', 'unavailable', 'resolve_on_read'])('recognizes status %s', author_identity_status => {
    expect(outstandCommentIdentity('instagram', { ...contract, author_identity_status })).not.toBeNull();
  });
});

describe('stable Outstand commenter lead identity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts identity atomically and reuses it across posts and changed display names', async () => {
    const db = database();
    const first = await manage();
    const second = await manage({ ...contract, outstand_post_id: 'post-2', author_name: 'Alice Updated', author_username: 'alice.new' });
    expect(first).toEqual({ leadId: 'lead-1', isNewLead: true, taskId: null });
    expect(second).toEqual({ leadId: 'lead-1', isNewLead: false, taskId: null });
    expect(db.rows).toHaveLength(1);
    const insert = db.queries.find(query => query.action === 'insert');
    expect(insert.payload[0]).toMatchObject({
      name: 'Alice Smith', site_id: siteId, user_id: 'owner-1', origin: 'instagram',
      metadata: { social_author_id: 'author-1', social_account_id: 'account-1', outstand_generated_name: 'Alice Smith' },
      social_networks: { instagram: 'alice' },
    });
    expect(insert.payload[0]).not.toHaveProperty('email');
    expect(insert.payload[0]).not.toHaveProperty('phone');
    expect(db.rows[0].name).toBe('Alice Updated');
    expect(db.queries[0].filters).toEqual([
      ['site_id', siteId], ['origin', 'instagram'], ['metadata->>social_author_id', 'author-1'],
      ['metadata->>social_account_id', 'account-1'],
    ]);
    expect(db.queries.filter(query => query.action === 'insert')).toHaveLength(1);
  });

  it.each([
    ['site', { siteId: 'other-site' }, {}],
    ['network', { origin: 'facebook' }, {}],
    ['account', {}, { publisher_account_id: 'account-2' }],
    ['author', {}, { author_id: 'author-2' }],
  ])('isolates by %s even with the same handle/name', async (_label, options, changes) => {
    const db = database();
    await manage();
    await manage({ ...contract, ...changes }, options);
    expect(db.rows).toHaveLength(2);
  });

  it.each(['instagram', 'facebook'])('%s does not use opaque author IDs without an account namespace', async origin => {
    database();
    expect(await manage({ ...contract, publisher_account_id: '', author_identity_status: 'unavailable' }, { origin }))
      .toEqual({ leadId: null, isNewLead: false, taskId: null });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('never uses publisher identity, generic name or top-level contact data as the commenter', async () => {
    database();
    expect(await manage({ ...contract, author_id: '', author_name: '', author_username: '',
      publisher_username: 'alice', account_username: 'alice', social_handle: '' }))
      .toEqual({ leadId: null, isNewLead: false, taskId: null });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('creates and reuses an Instagram textual author handle without an author ID', async () => {
    const db = database();
    const data = { ...contract, author_id: '', author_name: 'johndoe', author_username: 'johndoe' };
    const first = await manage(data);
    const next = await manage({ ...data, outstand_post_id: 'post-2' });
    expect(first.leadId).toBe(next.leadId);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ name: 'johndoe', metadata: {
      social_handle: 'johndoe', social_account_id: 'account-1',
    } });
    expect(db.rows[0].metadata).not.toHaveProperty('social_author_id');
  });

  it('scopes handle-only identities to their publishing account', async () => {
    const db = database();
    const data = { ...contract, author_id: '' };
    const first = await manage(data);
    const other = await manage({ ...data, publisher_account_id: 'account-2' });
    expect(first.leadId).not.toBe(other.leadId);
    expect((await manage(data)).leadId).toBe(first.leadId);
    expect(db.rows).toHaveLength(2);
  });

  it('keeps numeric explicit usernames and falls back from blank author_username to social_handle', async () => {
    const db = database();
    const data = { ...contract, author_id: '', author_name: '', author_username: '  ', social_handle: '12345' };
    const first = await manage(data);
    expect((await manage({ ...data, author_username: '12345', social_handle: '' })).leadId).toBe(first.leadId);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ name: '12345', social_networks: { instagram: '12345' } });
    expect(db.rows[0].metadata).not.toHaveProperty('social_author_id');
  });

  it('adopts a compatible legacy handle only after the stable ID lookup missed', async () => {
    const db = database([existing({ metadata: { social_handle: 'alice', unrelated: 'keep' } })]);
    expect(await manage()).toMatchObject({ leadId, isNewLead: false });
    expect(db.queries[0].filters).toContainEqual(['metadata->>social_author_id', 'author-1']);
    expect(db.rows[0].metadata).toMatchObject({
      social_author_id: 'author-1', social_account_id: 'account-1', unrelated: 'keep',
    });
    expect(db.rows[0].name).toBe('Manual Name');
    expect(db.queries.filter(query => query.action === 'insert')).toHaveLength(0);
  });

  it.each([
    { social_author_id: 'different-author' }, { social_account_id: 'different-account' },
    { social_network: 'facebook' },
  ])('does not rebind a conflicting legacy handle %j', async conflict => {
    const db = database([existing({ metadata: { social_handle: 'alice', ...conflict } })]);
    expect(await manage()).toMatchObject({ isNewLead: true });
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0].metadata).toEqual({ social_handle: 'alice', ...conflict });
  });

  it('creates a Facebook display-name-only commenter but never dedupes by that name', async () => {
    const db = database();
    const data = { ...contract, author_id: '', author_username: '', author_name: 'Jane Smith' };
    await manage(data, { origin: 'facebook' });
    await manage(data, { origin: 'facebook' });
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0].name).toBe('Jane Smith');
    expect(db.queries.filter(query => query.action === 'read' && query.table === 'leads')).toHaveLength(0);
  });

  it.each([
    { source: 'outstand_dm', outstand_dm_participant_id: 'dm-igsid', outstand_dm_social_account_id: 'other-account' },
    { source: 'outstand_dm' },
  ])('does not claim a DM-first lead through a coincident public-comment handle %j', async metadata => {
    const dm = existing({ metadata, social_networks: { instagram: 'alice' } });
    const db = database([dm]);
    expect(await manage()).toMatchObject({ isNewLead: true });
    expect(db.rows).toHaveLength(2);
    expect(dm.metadata).toEqual(metadata);
    expect(db.rows[1].metadata.social_author_id).toBe('author-1');
  });

  it('accepts numeric stable author IDs without using them as display names', async () => {
    const db = database();
    await manage({ ...contract, author_id: 123, author_name: '123', author_username: '' });
    expect(db.rows[0]).toMatchObject({ name: 'Social User', metadata: { social_author_id: '123' } });
  });

  it('uses a LinkedIn URN globally within the site/network, never persists its profile', async () => {
    const db = database();
    const linkedin = {
      ...contract, author_id: 'urn:li:person:one', author_identity_status: 'resolve_on_read',
      author_name: 'Private Name', author_username: 'private-user', profile_url: 'https://linkedin.com/in/private',
      author_profile: { name: 'Private Name', photo: 'private-photo' },
    };
    const first = await manage(linkedin, { origin: 'linkedin' });
    const second = await manage({ ...linkedin, publisher_account_id: 'different-account' }, { origin: 'linkedin' });
    expect(first.leadId).toBe(second.leadId);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ name: 'Social User', metadata: {
      social_author_id: 'urn:li:person:one', author_identity_status: 'resolve_on_read',
    } });
    expect(db.rows[0]).not.toHaveProperty('social_networks');
    expect(JSON.stringify(db.rows)).not.toMatch(/Private|private|linkedin\.com|social_account_id/);
    expect(db.queries[0].filters).toEqual([
      ['site_id', siteId], ['origin', 'linkedin'], ['metadata->>social_author_id', 'urn:li:person:one'],
    ]);
  });

  it('allows global LinkedIn URNs without a publisher account but scopes opaque IDs', async () => {
    const db = database();
    await manage({ ...contract, author_id: 'urn:li:organization:one', publisher_account_id: '' }, { origin: 'linkedin' });
    expect(db.rows).toHaveLength(1);
    await manage({ ...contract, author_id: 'opaque', publisher_account_id: '' }, { origin: 'linkedin' });
    expect(db.rows).toHaveLength(1);
  });

  it.each(['Manual Name', 'Social User', 'Alice Smith'])('preserves unmarked/manual name %s', async name => {
    const db = database([existing({ name })]);
    await manage();
    expect(db.rows[0].name).toBe(name);
    expect(db.rows[0].metadata.unrelated).toBe('keep');
    expect(db.rows[0].social_networks.facebook).toBe('manual-facebook');
    expect(db.queries.find(query => query.action === 'update').payload).not.toHaveProperty('name');
  });

  it('preserves a manual edit to a previously generated name', async () => {
    const db = database();
    await manage();
    db.rows[0].name = 'Manually Renamed';
    await manage({ ...contract, author_name: 'Provider Rename' });
    expect(db.rows[0].name).toBe('Manually Renamed');
  });

  it('upgrades only its own placeholder with a compare-and-set name guard', async () => {
    const db = database();
    await manage({ ...contract, author_identity_status: 'unavailable' });
    await manage();
    expect(db.rows[0].name).toBe('Alice Smith');
    expect(db.queries.find(query => query.action === 'update').filters).toContainEqual(['name', 'Social User']);
  });

  it.each(['unavailable', 'resolve_on_read', 'future-status'])('does not degrade a name or trust profile data for status %s', async author_identity_status => {
    const db = database();
    await manage();
    await manage({ ...contract, author_identity_status, author_name: 'Wrong Name', author_username: 'wrong' });
    expect(db.rows[0].name).toBe('Alice Smith');
    expect(db.rows[0].social_networks.instagram).toBe('alice');
  });

  it('validates an explicit lead ID against stable identity instead of bypassing lookup', async () => {
    const db = database([existing()]);
    await expect(manage(contract, { leadId })).resolves.toMatchObject({ leadId, isNewLead: false });
    await expect(manage({ ...contract, author_id: 'wrong-author' }, { leadId })).rejects.toThrow(OutstandLeadIdentityError);
    expect(db.queries.filter(query => query.action === 'insert')).toHaveLength(0);
  });

  it('does not create after ambiguous matching leads', async () => {
    const db = database([existing(), existing({ id: 'duplicate' })]);
    await expect(manage()).rejects.toThrow(OutstandLeadIdentityError);
    expect(db.queries).toHaveLength(1);
  });

  it.each([
    ['leads:read', false], ['sites:read', false], ['leads:update', true], ['leads:insert', false],
  ])('fails closed for returned and thrown DB errors at %s', async (fail, hasExisting) => {
    for (const reject of [false, true]) {
      const db = database(hasExisting ? [existing()] : []);
      db.fail = fail as string;
      db.reject = reject;
      await expect(manage()).rejects.toThrow(OutstandLeadIdentityError);
      expect(db.rows).toHaveLength(hasExisting ? 1 : 0);
      if (fail !== 'leads:insert') {
        expect(db.queries.filter(query => query.action === 'insert')).toHaveLength(0);
      } else {
        expect(db.queries.filter(query => query.action === 'insert')).toHaveLength(1);
      }
    }
  });

  it('does not insert if site ownership could not be loaded', async () => {
    const db = database();
    db.sites = [];
    await expect(manage()).rejects.toThrow(OutstandLeadIdentityError);
    expect(db.queries.filter(query => query.action === 'insert')).toHaveLength(0);
  });
});