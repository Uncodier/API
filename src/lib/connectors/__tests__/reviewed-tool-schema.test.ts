import { reviewedInputSchema, assertReviewedInputLimits } from '../reviewed-tool-schema';
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