import { randomUUID } from 'node:crypto';
import { hashConnectorSchema } from '../composio-tool-json';
import { reviewedInputSchema, validateTableDispatchSchema, assertReviewedInputLimits } from '../reviewed-tool-schema';
import { validateConnectorInput } from '../schema-validation';

// Public documented input shapes, not a captured/live version or evidence of OAuth readiness.
// https://docs.composio.dev/toolkits/gmail.md (leader reviewed 2026-11-19)
const gmail = { type: 'object', properties: {
  query: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
  user_id: { type: 'string', default: 'me', description: 'Authenticated user; other users require delegation.' },
  verbose: { type: 'boolean', default: true }, ids_only: { type: 'boolean', default: false },
  label_ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
  page_token: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  max_results: { type: 'integer', default: 10 }, include_payload: { type: 'boolean', default: true },
  include_spam_trash: { type: 'boolean', default: false },
}, required: ['user_id'] };

test('Gmail exposes documented input types but strips only its private self-mailbox selector', () => {
  const before = JSON.stringify(gmail);
  const model = reviewedInputSchema('GMAIL_FETCH_EMAILS', gmail);
  expect(model.additionalProperties).toBe(false);
  expect(model.properties.max_results).toEqual({ type: 'integer', minimum: 1, maximum: 500, default: 10 });
  expect(model.properties.label_ids.anyOf).toEqual([
    { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 8000, description: expect.stringContaining('UTF-16') } }, { type: 'null' },
  ]);
  expect(model.properties.user_id).toBeUndefined();
  expect(model.required).toEqual([]);
  expect(JSON.stringify(gmail)).toBe(before);
  expect(() => validateConnectorInput(model, { query: 'is:unread', label_ids: ['INBOX'], max_results: 10 })).not.toThrow();
  expect(() => validateConnectorInput(model, { query: null, label_ids: null })).not.toThrow();
  for (const user_id of ['me', 'other@example.invalid']) {
    expect(() => validateConnectorInput(model, { user_id })).toThrow();
  }
  expect(() => validateConnectorInput(model, { label_ids: [123] })).toThrow();
  expect(() => assertReviewedInputLimits('GMAIL_FETCH_EMAILS', { max_results: 501 })).toThrow();
});

test('HubSpot supports only its documented string, boolean, integer, and string-array fields', () => {
  const hubspot = { type: 'object', properties: {
    after: { type: 'string' }, limit: { type: 'integer' }, archived: { type: 'boolean' },
    properties: { type: 'array', items: { type: 'string' } }, associations: { type: 'array', items: { type: 'string' } },
    propertiesWithHistory: { type: 'array', items: { type: 'string' } },
  } };
  const model = reviewedInputSchema('HUBSPOT_LIST_CONTACTS', hubspot);
  expect(() => validateConnectorInput(model, { limit: 5, archived: false, properties: ['email'] })).not.toThrow();
  expect(() => reviewedInputSchema('HUBSPOT_LIST_CONTACTS', gmail)).toThrow();
  expect(() => reviewedInputSchema('HUBSPOT_LIST_CONTACTS', { ...hubspot,
    properties: { ...hubspot.properties, remote_fetch: { type: 'string' } } })).toThrow();
});

test.each([{minimum:501},{maximum:0},{enum:[501,502]}])('refuses an unusable provider count at describe, not after an agent call',bounds=>{
  expect(()=>reviewedInputSchema('GMAIL_FETCH_EMAILS',{...gmail,properties:{...gmail.properties,
    max_results:{anyOf:[{type:'integer',...bounds},{type:'null'}]}}})).toThrow(expect.objectContaining({code:'SCHEMA_UNSUPPORTED'}));
});

test('changed mailbox schema cannot smuggle unknown constraints or a non-self selector', () => {
  for (const user of [{ type: 'number' }, { type: 'string', const: 'someone' },
    { type: 'string', enum: ['someone'] }, { type: 'string', pattern: 'someone' }, { type: 'string', maxLength: 1 }]) {
    expect(() => reviewedInputSchema('GMAIL_FETCH_EMAILS', { ...gmail, properties: { ...gmail.properties, user_id: user } })).toThrow();
  }
});

test('nullable alternatives validate every branch and never ignore sibling constraints', () => {
  expect(() => reviewedInputSchema('GMAIL_FETCH_EMAILS', { ...gmail,
    properties: { ...gmail.properties, query: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] } } })).toThrow();
  expect(() => reviewedInputSchema('GMAIL_FETCH_EMAILS', { ...gmail,
    properties: { ...gmail.properties, query: { anyOf: [{ type: 'string' }, { type: 'null' }], maxLength: 5 } } })).toThrow();
});
const projectCount = (field: object) => reviewedInputSchema('GMAIL_FETCH_EMAILS', {
  type: 'object', properties: { max_results: field },
});

test.each([
  { type: ['integer', 'null'], minimum: -100, maximum: 900 },
  { anyOf: [{ type: 'null' }, { type: 'integer', minimum: -100, maximum: 900 }] },
])('enforces the published range on supplied integers, not on omissions or permitted null', field => {
  const schema = projectCount(field);
  const projected = schema.properties.max_results;
  expect(projected.anyOf?.[1] ?? projected).toMatchObject({ minimum: 1, maximum: 500 });
  expect(projected.anyOf?.[0] ?? { type: 'null' }).toEqual({ type: 'null' });
  for (const value of [null, 1, 500]) expect(() => validateConnectorInput(schema, { max_results: value })).not.toThrow();
  expect(() => validateConnectorInput(schema, {})).not.toThrow();
  for (const value of [-1, 0, 1.5, 501]) expect(() => validateConnectorInput(schema, { max_results: value })).toThrow();
});

test('preserves tighter numeric bounds, enum, const and valid defaults; no field is added to an older shape', () => {
  const schema = projectCount({ anyOf: [{ type: 'integer', enum: [5, 7], minimum: 4, maximum: 8 }, { type: 'null' }], default: 7 });
  expect(schema.properties.max_results.anyOf[0]).toEqual({ type: 'integer', enum: [5, 7], minimum: 4, maximum: 8 });
  expect(schema.properties.max_results.default).toBe(7);
  for (const max_results of [5, 7, null]) expect(() => validateConnectorInput(schema, { max_results })).not.toThrow();
  for (const max_results of [0, 4, 6, 8, 9]) expect(() => validateConnectorInput(schema, { max_results })).toThrow();
  const fixed = projectCount({ type: 'integer', const: 3 });
  expect(fixed.properties.max_results).toMatchObject({ const: 3, minimum: 1, maximum: 500 });
  expect(() => validateConnectorInput(fixed, { max_results: 2 })).toThrow();
  expect(reviewedInputSchema('GMAIL_FETCH_EMAILS', { type: 'object', properties: {} })).toEqual({
    type: 'object', properties: {}, additionalProperties: false,
  });
});

test('does not apply guessed defaults or execute an omission with a known contradictory provider default', () => {
  for (const def of [501, -1, 3, '5', null, { prose: 'not a count' }]) {
    const model = projectCount({ type: 'integer', minimum: 4, default: def });
    expect(model.required).toEqual(['max_results']);
    expect(model.properties.max_results).not.toHaveProperty('default');
    expect(() => validateConnectorInput(model, {})).toThrow();
    expect(() => validateConnectorInput(model, { max_results: 4 })).not.toThrow();
  }
  for (const field of [{ type: 'integer' }, { type: 'integer', default: 10 }, { type: ['integer', 'null'], default: null }]) {
    const args = Object.freeze({});
    expect(() => validateConnectorInput(projectCount(field), args)).not.toThrow();
    expect(args).toEqual({});
  }
});

test('exposes the enforced array, string and unknown-key ceilings at each supported schema node', () => {
  const lengths = { type: 'object', properties: {
    label_ids: { type: ['array', 'null'], maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 99999 } },
    query: { type: 'string', maxLength: 9 }, page_token: { type: ['string', 'null'] },
  } };
  const model = reviewedInputSchema('GMAIL_FETCH_EMAILS', lengths);
  expect(model.properties.label_ids).toMatchObject({ type: ['array', 'null'], maxItems: 100,
    items: { minLength: 1, maxLength: 8000, description: expect.stringContaining('UTF-16 code units') } });
  expect(model.properties.query).toEqual({ type: 'string', maxLength: 9 });
  expect(model.properties.page_token).toMatchObject({ type: ['string', 'null'], maxLength: 8000 });
  expect(() => validateConnectorInput(model, { label_ids: Array(100).fill('a'), page_token: '🙂'.repeat(4000) })).not.toThrow();
  for (const invalid of [{ label_ids: Array(101).fill('a') }, { label_ids: ['a'.repeat(8001)] }, { label_ids: [''] },
    { page_token: '🙂'.repeat(4001) }, { query: 'a'.repeat(10) }, { user_id: 'me' }]) {
    expect(() => validateConnectorInput(model, invalid)).toThrow();
  }
  lengths.properties.label_ids.maxItems = 3;
  expect(reviewedInputSchema('GMAIL_FETCH_EMAILS', lengths).properties.label_ids.maxItems).toBe(3);
});

test('never publishes unreviewed provider annotations or rewrites pinned metadata, even through a returned reference', () => {
  const marker = randomUUID();
  const provider = { ...gmail, examples: [{ user_id: marker }], description: marker, title: marker, $schema: marker,
    properties: { ...gmail.properties, query: { anyOf: [{ type: 'string', description: marker }, { type: 'null' }],
      default: marker, examples: [{ instructions: marker }] }, verbose: { type: 'boolean', default: { instructions: marker } } } };
  const before = structuredClone(provider);
  const pin = hashConnectorSchema(provider);
  const model = reviewedInputSchema('GMAIL_FETCH_EMAILS', provider);
  expect(JSON.stringify(model)).not.toContain(marker);
  expect(JSON.stringify(model)).not.toContain('user_id');
  model.properties.query.anyOf[0].minimum = 99; model.required.push('query');
  expect(provider).toEqual(before);
  expect(hashConnectorSchema(provider)).toBe(pin);
  const changed = { ...provider, description: 'different provider document' };
  expect(reviewedInputSchema('GMAIL_FETCH_EMAILS', changed)).toEqual(reviewedInputSchema('GMAIL_FETCH_EMAILS', provider));
  expect(hashConnectorSchema(changed)).not.toBe(pin); // identical public shape is not a substitute for the retained pin
  for (const field of [{ type: 'string', const: marker }, { type: 'string', enum: [{ instructions: marker }] }]) {
    expect(() => reviewedInputSchema('GMAIL_FETCH_EMAILS', { ...gmail, properties: { query: field } })).toThrow(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  }
});

test('a hidden or unreviewed alternative cannot become a caller-facing selector', () => {
  for (const extra of [{ anyOf: [{ type: 'object', properties: { mailbox: { type: 'string' } } }] },
    { const: { mailbox: 'me' } }, { enum: [{ mailbox: 'me' }] }]) {
    expect(() => reviewedInputSchema('GMAIL_FETCH_EMAILS', { ...gmail, ...extra })).toThrow(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  }
});

test('a provider incompatibility with injected table arguments is not a caller-correctable error', () => {
  const schema = { type: 'object', required: ['project_ref'], properties: {
    project_ref: { type: 'string', minLength: 20 }, schemas: { type: 'array', items: { type: 'string' } },
    include_metadata: { type: 'boolean', const: true }, include_views: { type: 'boolean' }, include_system_schemas: { type: 'boolean' },
  } };
  const args = { project_ref: 'a'.repeat(20), include_metadata: false, include_views: false, include_system_schemas: false };
  let thrown; try { validateTableDispatchSchema(schema, args); } catch (e) { thrown = e; }
  expect(thrown).toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
  expect(thrown).not.toHaveProperty('issue');
  expect(String(thrown)).not.toMatch(/project_ref|include_metadata|aaaaa/);
});
