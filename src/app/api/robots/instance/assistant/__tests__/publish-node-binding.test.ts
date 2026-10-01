import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type Row = Record<string, any>;
type Query = { table: string; filters: Row; ids?: string[]; limit?: number; columns?: string };
let tables: Record<string, Row[]>;
let errorTable: string | undefined;
let injected: ((query: Query, rows: Row[]) => Row[]) | undefined;
const queries: Query[] = [];
const from = jest.fn((table: string) => {
  const recorded: Query = { table, filters: {} };
  queries.push(recorded);
  const result = () => {
    if (!(table in tables)) throw new Error(`Unexpected database table: ${table}`);
    let data = tables[table].filter(row =>
      Object.entries(recorded.filters).every(([key, value]) => row[key] === value)
      && (!recorded.ids || recorded.ids.includes(row.id)));
    if (recorded.limit) data = data.slice(0, recorded.limit);
    if (injected) data = injected(recorded, data);
    return { data, error: table === errorTable ? { message: 'private database diagnostic' } : null };
  };
  const query: any = {
    select: jest.fn((columns: string) => { recorded.columns = columns; return query; }),
    eq: jest.fn((key: string, value: unknown) => { recorded.filters[key] = value; return query; }),
    in: jest.fn((_key: string, value: string[]) => { recorded.ids = value; return query; }),
    order: jest.fn(() => query),
    limit: jest.fn((value: number) => { recorded.limit = value; return query; }),
    maybeSingle: jest.fn(async () => { const response = result(); return { ...response, data: response.data[0] ?? null }; }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
  };
  return query;
});

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
let resolveBinding: typeof import('../publish-node-binding').resolvePublishNodeBinding;
beforeAll(async () => { ({ resolvePublishNodeBinding: resolveBinding } = await import('../publish-node-binding')); });

const scope = { instanceNodeId: 'publish-1', instanceId: 'instance-1', siteId: 'site-1' };
const videoUrl = 'https://db.makinari.com/storage/v1/object/public/generative_videos/final.mp4';
const imageUrl = 'https://db.makinari.com/storage/v1/object/public/generative_images/reference.png';
const secondVideo = 'https://media.outstand.so/org/media/second.mp4';
const output = (type: string, url: unknown): Row => ({ type, tool_name: `generate_${type}`, data: { url } });
const target = () => tables.instance_nodes[0];
const content = () => tables.instance_nodes[1];
const ref = () => tables.instance_node_contexts[0];

beforeEach(() => {
  jest.clearAllMocks();
  queries.length = 0;
  errorTable = undefined;
  injected = undefined;
  tables = {
    instance_nodes: [
      { id: 'publish-1', instance_id: 'instance-1', site_id: 'site-1', type: 'publish',
        status: 'running', settings: { publish_destinations: ['tiktok'] } },
      { id: 'content-1', instance_id: 'instance-1', site_id: 'site-1', type: 'response',
        status: 'completed', settings: { media_type: 'video' },
        result: { status: 'done', text: 'Final video caption', outputs: [output('video', videoUrl)] } },
    ],
    instance_node_contexts: [
      { target_node_id: 'publish-1', context_node_id: 'content-1', site_id: 'site-1', type: 'content' },
    ],
  };
});

describe('persisted publish selection', () => {
  it('does not read a database without a target node', async () => {
    expect(await resolveBinding({ instanceId: 'instance-1', siteId: 'site-1' })).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('returns null for a non-publish persisted node regardless of client overrides', async () => {
    target().type = 'generate-video';
    target().settings = { publish_destinations: ['tiktok'] };
    expect(await resolveBinding({ ...scope, toolOverrides: { publish: { media_urls: [imageUrl] } } })).toBeNull();
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('scopes all reads, limits references and sources, and never loads prompts or global assets', async () => {
    const binding = await resolveBinding(scope);
    expect(binding?.toolOverrides.publish).toEqual({ social_accounts: ['tiktok'], media_urls: [videoUrl], assets: [], urls: [] });
    expect(queries).toEqual([
      expect.objectContaining({ table: 'instance_nodes', filters: { id: 'publish-1', instance_id: 'instance-1', site_id: 'site-1' } }),
      expect.objectContaining({ table: 'instance_node_contexts', filters: { target_node_id: 'publish-1', site_id: 'site-1', type: 'content' }, limit: 21 }),
      expect.objectContaining({ table: 'instance_nodes', filters: { instance_id: 'instance-1', site_id: 'site-1' }, ids: ['content-1'], limit: 21 }),
    ]);
    expect(queries.every(query => !query.columns?.includes('prompt'))).toBe(true);
    expect(binding?.instruction).toMatch(/Content output URLs.*authoritative/);
    expect(binding?.instruction).toMatch(/Reference images.*not publishable/);
  });

  it('forces only videos over image outputs, markdown references, prompts and generic context', async () => {
    content().result.outputs.push(output('image', imageUrl), output('video', secondVideo));
    content().result.text = `Reference ![image](${imageUrl})`;
    content().prompt = { attachments: [imageUrl], text: imageUrl };
    tables.instance_nodes.push({ ...content(), id: 'reference-2', result: { outputs: [output('image', imageUrl)] } });
    tables.instance_node_contexts.push({ ...ref(), context_node_id: 'reference-2', type: 'context' });
    const overrides = { publish: { social_accounts: ['instagram'], media_urls: [imageUrl], assets: ['asset-1'], urls: [imageUrl] } };
    const before = JSON.stringify(overrides);
    const binding = await resolveBinding({ ...scope, toolOverrides: overrides });
    expect(binding?.toolOverrides.publish).toEqual({ social_accounts: ['tiktok'], media_urls: [videoUrl, secondVideo], assets: [], urls: [] });
    expect(JSON.stringify(overrides)).toBe(before);
    expect(binding?.instruction).toMatch(/only the selected video outputs/);
  });

  it('retains every video across Content links, never a referenced image', async () => {
    tables.instance_nodes.push({ ...content(), id: 'video-2', result: { outputs: [output('video', secondVideo), output('video', videoUrl)] } });
    tables.instance_node_contexts.push({ ...ref(), context_node_id: 'video-2' });
    expect((await resolveBinding(scope))?.toolOverrides.publish.media_urls).toEqual([videoUrl, secondVideo]);
  });

  it('preserves explicit TikTok, metadata, audience, test and caption settings without touching other tools', async () => {
    const publish = {
      tiktok: { postMode: 'DIRECT_POST', privacyLevel: 'SELF_ONLY' }, metadata: { campaign: 'test' },
      is_test: true, test_lead_id: 'lead-1', test_recipient: 'test@example.test',
      audience_id: 'audience-1', audience_email_mode: 'newsletter', channel: 'email', text: 'Authored caption',
    };
    const other = { provider: 'test', reference_images: [imageUrl] };
    const binding = await resolveBinding({ ...scope, toolOverrides: { publish, generate_video: other } });
    expect(binding?.toolOverrides.publish).toMatchObject(publish);
    expect(binding?.toolOverrides.generate_video).toBe(other);
    expect(publish).not.toHaveProperty('media_urls');
  });

  it('does not force TikTok defaults or overwrite agent-owned caption parameters', async () => {
    const binding = await resolveBinding(scope);
    expect(binding?.toolOverrides.publish).not.toHaveProperty('tiktok');
    expect(binding?.toolOverrides.publish).not.toHaveProperty('text');
    const routerMerged = { tiktok: { privacyLevel: 'SELF_ONLY' }, text: 'Agent caption', ...binding?.toolOverrides.publish };
    expect(routerMerged.tiktok).toEqual({ privacyLevel: 'SELF_ONLY' });
    expect(routerMerged.text).toBe('Agent caption');
  });

  it('uses saved legacy network selectors and excludes non-social delivery modes', async () => {
    target().settings.publish_destinations = ['twitter', 'blog', 'mail', 'newsletter', 'whatsapp', 'telegram', 'sms', 'voice', 'voice-agent-call'];
    const binding = await resolveBinding({ ...scope, toolOverrides: { publish: { social_accounts: ['foreign-id'], channel: 'email' } } });
    expect(binding?.toolOverrides.publish.social_accounts).toEqual(['twitter']);
    expect(binding?.toolOverrides.publish.channel).toBe('email');
  });

  it('supports plain text social content and clears stale media rather than requiring an image', async () => {
    target().settings.publish_destinations = ['linkedin'];
    content().settings = { media_type: 'text' };
    content().result = { text: 'Linked source text without any media.' };
    const binding = await resolveBinding({ ...scope, toolOverrides: { publish: { media_urls: [imageUrl] } } });
    expect(binding?.toolOverrides.publish).toEqual({ social_accounts: ['linkedin'], media_urls: [], assets: [], urls: [] });
    expect(binding?.toolOverrides.publish).not.toHaveProperty('text');
  });

  it('removes social-only settings when no social destination is persisted and preserves audience routing', async () => {
    target().settings.publish_destinations = ['blog', 'newsletter'];
    const publish = { social_accounts: ['tiktok'], tiktok: { privacyLevel: 'SELF_ONLY' },
      channel: 'email', audience_id: 'audience-1', is_test: true, metadata: { campaign: 'test' } };
    const binding = await resolveBinding({ ...scope, toolOverrides: { publish } });
    expect(binding?.toolOverrides.publish).toEqual({ channel: 'email', audience_id: 'audience-1', is_test: true, metadata: { campaign: 'test' } });
    expect(binding?.instruction).toMatch(/No social destinations are selected/);
    expect(publish.social_accounts).toEqual(['tiktok']);
  });

  it('rejects a text-only TikTok source before any publish tool runs', async () => {
    content().settings = {};
    content().result = { text: 'A text post.' };
    await expect(resolveBinding(scope)).rejects.toThrow('TikTok Content requires');
  });

  it.each(['output_type', 'output_types'])('honors %s arrays on response nodes', async key => {
    content().settings = { [key]: ['image', 'video'] };
    content().result.outputs = [output('image', imageUrl)];
    await expect(resolveBinding(scope)).rejects.toThrow('requires a completed video');
  });

  it('parses serialized results and legacy top-level output URLs', async () => {
    content().result = JSON.stringify({ outputs: [{ type: 'video', url: videoUrl }] });
    expect((await resolveBinding(scope))?.toolOverrides.publish.media_urls).toEqual([videoUrl]);
  });

  it('uses result.text markdown only when structured outputs are absent', async () => {
    content().result = { text: `[Video](${videoUrl})\n![Reference image](${imageUrl})` };
    expect((await resolveBinding(scope))?.toolOverrides.publish.media_urls).toEqual([videoUrl]);
    content().result.outputs = [{ type: 'video', data: {} }];
    await expect(resolveBinding(scope)).rejects.toThrow('Invalid Content media URL');
  });

  it('does not promote explicitly marked reference outputs into publishable media', async () => {
    content().settings = {};
    content().result = { outputs: [{ ...output('image', imageUrl), role: 'reference' }] };
    await expect(resolveBinding(scope)).rejects.toThrow('source is empty');
  });
});

describe('fail-closed Content validation', () => {
  it.each(['site_id', 'instance_id'])('rejects out-of-scope target %s', async key => {
    target()[key] = 'foreign';
    await expect(resolveBinding(scope)).rejects.toThrow('does not belong');
  });

  it.each(['site_id', 'instance_id'])('rejects out-of-scope linked source %s', async key => {
    content()[key] = 'foreign';
    await expect(resolveBinding(scope)).rejects.toThrow('Every Content source must exist');
  });

  it('checks returned node scope defensively even if a query layer returns foreign rows', async () => {
    injected = (query, rows) => query.ids ? rows.map(row => ({ ...row, site_id: 'foreign' })) : rows;
    await expect(resolveBinding(scope)).rejects.toThrow('out-of-scope Content source');
  });

  it('checks returned reference scope defensively', async () => {
    injected = (query, rows) => query.table === 'instance_node_contexts'
      ? rows.map(row => ({ ...row, target_node_id: 'other-node' })) : rows;
    await expect(resolveBinding(scope)).rejects.toThrow('out-of-scope Content reference');
  });

  it.each(['context', 'prompt', 'reference', 'audience'])('never falls back from %s to Content', async type => {
    ref().type = type;
    target().parent_node_id = 'content-1';
    target().prompt = { attachments: [videoUrl] };
    await expect(resolveBinding({ ...scope, toolOverrides: { publish: { media_urls: [videoUrl] } } })).rejects.toThrow('Connect between');
    expect(queries).toHaveLength(2);
  });

  it('rejects a deleted source without finding a generated sibling or global asset', async () => {
    ref().context_node_id = 'deleted';
    await expect(resolveBinding(scope)).rejects.toThrow('Every Content source must exist');
    expect(queries).toHaveLength(3);
  });

  it('reloads mutated references and results on each turn', async () => {
    expect(await resolveBinding(scope)).not.toBeNull();
    ref().context_node_id = 'foreign-node';
    await expect(resolveBinding(scope)).rejects.toThrow('Every Content source must exist');
    ref().context_node_id = 'content-1';
    content().result.outputs[0].data.url = 'https://untrusted.example.test/final.mp4';
    await expect(resolveBinding(scope)).rejects.toThrow('Invalid Content media URL');
  });

  it.each(['running', 'pending', 'failed', 'cancelled', 'stopped'])('rejects an incomplete %s source', async status => {
    content().status = status;
    await expect(resolveBinding(scope)).rejects.toThrow('source is not complete');
  });

  it.each([null, '{broken', [], { text: '' }, { text: ' \n\u200b' }, { outputs: [] }])('rejects empty or malformed result %j', async result => {
    content().settings = {};
    content().result = result;
    content().prompt = { attachments: [videoUrl] };
    await expect(resolveBinding(scope)).rejects.toThrow('Publish Content binding');
  });

  it.each([undefined, '', 'http://db.makinari.com/video.mp4', 'https://user:secret@media.outstand.so/org/final.mp4',
    'https://127.0.0.1/final.mp4', 'https://media.outstand.so:8443/final.mp4', imageUrl])('rejects invalid video URL %s', async url => {
    content().result.outputs = [output('video', url)];
    await expect(resolveBinding(scope)).rejects.toThrow('Invalid Content media URL');
  });

  it.each([['__proto__'], ['foreign-account-id'], [''], new Array(1), 'tiktok', null])('rejects malformed saved destinations %j', async destinations => {
    target().settings.publish_destinations = destinations;
    await expect(resolveBinding(scope)).rejects.toThrow('saved');
  });

  it('rejects audio-only social content', async () => {
    content().settings = { output_type: 'audio' };
    content().result = { outputs: [output('audio', 'https://media.outstand.so/org/audio.mp3')] };
    await expect(resolveBinding(scope)).rejects.toThrow('not audio attachments');
  });

  it('rejects over-limit Content references instead of silently truncating', async () => {
    tables.instance_node_contexts = Array.from({ length: 21 }, (_, index) => ({ ...ref(), context_node_id: `content-${index}` }));
    await expect(resolveBinding(scope)).rejects.toThrow('Connect between 1 and 20');
  });

  it('rejects over-limit outputs and oversized text/URLs', async () => {
    content().result.outputs = Array.from({ length: 21 }, () => output('video', videoUrl));
    await expect(resolveBinding(scope)).rejects.toThrow('Too many Content outputs');
    content().result = { text: 'x'.repeat(100_001) };
    await expect(resolveBinding(scope)).rejects.toThrow('oversized Content text');
    content().result = { outputs: [output('video', `${videoUrl}?x=${'x'.repeat(8192)}`)] };
    await expect(resolveBinding(scope)).rejects.toThrow('Invalid Content media URL');
  });

  it('caps total URLs across multiple sources', async () => {
    content().result.outputs = Array.from({ length: 20 }, () => output('video', videoUrl));
    tables.instance_nodes.push({ ...content(), id: 'content-2', result: { outputs: [output('video', secondVideo)] } });
    tables.instance_node_contexts.push({ ...ref(), context_node_id: 'content-2' });
    await expect(resolveBinding(scope)).rejects.toThrow('At most 20 Content media URLs');
  });

  it('rejects sparse, malformed and duplicate Content references', async () => {
    injected = (query, rows) => query.table === 'instance_node_contexts' ? [rows[0], undefined as any] : rows;
    await expect(resolveBinding(scope)).rejects.toThrow('Invalid or out-of-scope Content reference');
    injected = undefined;
    tables.instance_node_contexts.push({ ...ref() });
    await expect(resolveBinding(scope)).rejects.toThrow('Invalid or out-of-scope Content reference');
  });

  it.each(['instance_nodes', 'instance_node_contexts'])('sanitizes %s errors without fallback', async table => {
    errorTable = table;
    await expect(resolveBinding(scope)).rejects.toThrow('Publish Content binding');
    await expect(resolveBinding(scope)).rejects.not.toThrow('private database diagnostic');
  });

  it('rejects malformed scope before database access', async () => {
    await expect(resolveBinding({ ...scope, siteId: '' })).rejects.toThrow('authorized node');
    expect(from).not.toHaveBeenCalled();
  });
});