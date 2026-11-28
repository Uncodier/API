import { freshPostgres } from '@/lib/procurement/__tests__/fixtures/workflow-postgres';

// SQL counterpart of candidates()'s PostgREST OR, conversations!inner,
// trusted conversation site filter and outer limit. No forced planner settings.
const providerPaths = ['provider_message_id', ...['pinned_text_delivery', 'native_media_delivery', 'template_delivery', 'audio_delivery']
  .map(kind => `${kind}.provider_message_id`)];
const attemptPaths = ['pinned_text_delivery.id', 'native_media_delivery.id'];
const paths = [...providerPaths, ...attemptPaths];
const indexNames = ['provider', 'text_provider', 'media_provider', 'template_provider', 'audio_provider', 'text_attempt', 'media_attempt']
  .map(name => `messages_zavu_${name}_idx`);
function filter(path: string, value: string) {
  const [first, second] = path.split('.');
  return `${second ? `custom_data->'${first}'->>'${second}'` : `custom_data->>'${first}'`} = '${value}'`;
}
function candidates(provider: string, attempt?: string, site = 1) {
  const predicates = providerPaths.map(path => filter(path, provider));
  if (attempt) predicates.push(...attemptPaths.map(path => filter(path, attempt)));
  return `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.site_id = ${site} AND (${predicates.join(' OR ')}) LIMIT 2`;
}

const migration = '20261128032000_zavu_delivery_identity_indexes.sql';
let pg: ReturnType<typeof freshPostgres>;
beforeAll(() => {
  pg = freshPostgres();
  pg.query(`CREATE TABLE conversations(id integer PRIMARY KEY, site_id integer NOT NULL);
    CREATE TABLE messages(id integer PRIMARY KEY, conversation_id integer REFERENCES conversations, custom_data jsonb);
    CREATE INDEX ON messages(conversation_id);
    CREATE INDEX ON conversations(site_id);
    INSERT INTO conversations SELECT i, (i % 2) + 1 FROM generate_series(1,200) i;
    INSERT INTO messages SELECT i, 1 + i % 200, CASE i % 8
      ${paths.map((path, i) => {
        const [first, second] = path.split('.');
        const value = `'noise-' || i`;
        return `WHEN ${i} THEN jsonb_build_object('${first}', ${second ? `jsonb_build_object('${second}', ${value})` : value})`;
      }).join('\n')} ELSE '{}'::jsonb END FROM generate_series(1,50000) i;
    INSERT INTO messages VALUES
      (50001,2,'{"provider_message_id":"both","pinned_text_delivery":{"id":"a","provider_message_id":"both"}}'),
      (50002,1,'{"provider_message_id":"both","native_media_delivery":{"id":"a"}}'),
      (50003,2,'{"audio_delivery":{"provider_message_id":"audio"}}'),
      (50004,2,'{"template_delivery":{"provider_message_id":"duplicate"}}'),
      (50005,2,'{"native_media_delivery":{"provider_message_id":"duplicate","id":"b"}}'),
      (50006,1,'{"provider_message_id":"foreign-only","site_id":1}');
    ANALYZE messages; ANALYZE conversations;`);
}, 30000);
afterAll(() => pg?.stop());

test('same candidate rows before and after indexing, including cross-path and cross-site collisions', () => {
  const cases: [string, number[]][] = [
    [candidates('both', 'a'), [50001]], [candidates('both', 'a', 2), [50002]],
    [candidates('foreign-only'), []], [candidates('duplicate'), [50004, 50005]],
    [candidates('audio', 'a'), [50001, 50003]], [candidates('missing', 'b'), [50005]],
    [candidates('missing', 'missing'), []],
  ];
  const check = () => cases.forEach(([sql, ids]) => {
    expect(pg.query(sql).split('\n').filter(Boolean).map(Number).sort((a,b) => a-b)).toEqual(ids);
  });
  check();
  const explain = (attempt?: string) => JSON.parse(pg.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidates('both', attempt)}`))[0].Plan;
  const blocks = (plan: Record<string, number>) => plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
  const before = [blocks(explain()), blocks(explain('a'))];
  pg.migrate(migration);
  check();

  for (const attempt of [undefined, 'a']) {
    const plan = explain(attempt);
    expect(blocks(plan)).toBeLessThan(before[attempt ? 1 : 0]);
    const nodes = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
    const steps = nodes(plan);
    expect(steps.filter(step => step['Relation Name'] === 'messages').map(step => step['Node Type'])).toEqual(['Bitmap Heap Scan']);
    expect(steps.some(step => step['Node Type'] === 'BitmapOr')).toBe(true);
    expect(steps.filter(step => step['Node Type'] === 'Bitmap Index Scan' && step['Index Name'].startsWith('messages_zavu_'))
      .map(step => step['Index Name']).sort()).toEqual(indexNames.slice(0, attempt ? 7 : 5).sort());
  }
});
