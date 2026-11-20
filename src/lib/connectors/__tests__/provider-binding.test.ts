import { randomBytes } from 'node:crypto';
import { connectorCallbackUrl, readProviderBinding } from '../provider-binding';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('../access', () => ({}));
const siteId = '11111111-1111-4111-8111-111111111111';
const revision = randomBytes(32).toString('hex');
const oldBindings = process.env.CONNECTOR_PROVIDER_BINDINGS;
const oldOrigin = process.env.CONNECTORS_WEB_ORIGIN;

beforeEach(() => {
  process.env.CONNECTORS_WEB_ORIGIN = 'https://app.example.test';
  delete process.env.CONNECTOR_PROVIDER_BINDINGS;
});
afterAll(() => {
  if (oldBindings === undefined) delete process.env.CONNECTOR_PROVIDER_BINDINGS; else process.env.CONNECTOR_PROVIDER_BINDINGS = oldBindings;
  if (oldOrigin === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = oldOrigin;
});

const binding = () => ({ site_id: siteId, project_id: 'proj_reviewed', credential_revision: revision, oauth_verifier_url: 'https://app.example.test/connectors/callback' });

it('requires explicit operator binding rather than assuming a project namespace', () => {
  expect(() => readProviderBinding(siteId, revision)).toThrow('Verify this credential');
});

it('accepts only the exact site, credential revision and verifier URL', () => {
  process.env.CONNECTOR_PROVIDER_BINDINGS = JSON.stringify([binding()]);
  expect(readProviderBinding(siteId, revision)).toEqual({ projectId: 'proj_reviewed', callbackUrl: 'https://app.example.test/connectors/callback' });
  expect(() => readProviderBinding(siteId, randomBytes(32).toString('hex'))).toThrow();
  expect(() => readProviderBinding('22222222-2222-4222-8222-222222222222', revision)).toThrow();
  process.env.CONNECTOR_PROVIDER_BINDINGS = JSON.stringify([{ ...binding(), oauth_verifier_url: 'https://foreign.example.test/connectors/callback' }]);
  expect(() => readProviderBinding(siteId, revision)).toThrow();
});

it('denies duplicate bindings and unsafe callback origins', () => {
  process.env.CONNECTOR_PROVIDER_BINDINGS = JSON.stringify([binding(), binding()]);
  expect(() => readProviderBinding(siteId, revision)).toThrow();
  for (const origin of ['http://localhost', 'https://app.example.test/path', 'https://user:password@app.example.test', 'https://app.example.test?redirect=elsewhere']) {
    process.env.CONNECTORS_WEB_ORIGIN = origin;
    expect(() => connectorCallbackUrl()).toThrow();
  }
});