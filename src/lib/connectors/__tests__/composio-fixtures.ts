import { randomBytes } from 'node:crypto';
import type { Connector, ConnectorProvider } from '../types';

export const secret = () => randomBytes(32).toString('hex');
export const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
export const toolkitFixture = () => ({
  slug: 'gmail', name: 'Gmail', type: 'native', toolkit_type: 'api',
  auth_schemes: ['OAUTH2'], meta: {
    description: 'Email toolkit.', logo: 'https://logos.composio.dev/api/gmail',
    categories: [{ name: 'Communication', slug: 'communication' }],
    tools_count: 12, triggers_count: 2, version: '20261119_00',
  },
});
export const accountFixture = () => ({
  id: 'ca_one', toolkit: { slug: 'gmail' }, auth_config: { id: 'ac_one', is_disabled: false },
  user_id: 'site_one', status: 'ACTIVE', is_disabled: false, alias: 'Sales email',
  experimental: { account_type: 'PRIVATE' }, state: { val: { scope: 'email.read profile' } },
});
export const providerFixture = (): ConnectorProvider => ({
  id: 'provider_one', site_id: 'site_one', provider: 'composio', project_id: 'project_one',
  provider_user_id: 'site_one', credential_revision: 'a'.repeat(64), status: 'active',
});
export const connectorFixture = (): Connector => ({
  id: 'connector_one', site_id: 'site_one', provider_id: 'provider_one', provider_project_id: 'project_one',
  toolkit_slug: 'gmail', provider_account_id: 'ca_one', auth_config_id: 'ac_one', display_name: 'Sales email',
  provider_status: 'ACTIVE', enabled: true, revocation_pending: false, granted_scopes: ['email.read'],
  created_by: 'actor_one', revision: 1, verified_at: '2026-11-19T00:00:00Z',
});
export const toolFixture = () => ({
  slug: 'GMAIL_FETCH_EMAILS', description: 'Fetch authorized messages.', toolkit: { slug: 'gmail' },
  version: '20261119_00', input_parameters: { type: 'object', properties: { max_results: { type: 'integer' } } },
  scopes: ['email.read'], scope_requirements: null, no_auth: false, is_deprecated: false,
});