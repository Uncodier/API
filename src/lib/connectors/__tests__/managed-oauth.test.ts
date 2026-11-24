import { createManagedOAuth } from '../managed-oauth';
import { ConnectorError } from '../types';

const prepare = jest.fn();
const acquire = jest.fn();
const release = jest.fn();
const toolkit = jest.fn();
const configs = jest.fn();
const request = jest.fn();
jest.mock('../provider-binding', () => ({ prepareConnectorProvider: (...args: unknown[]) => prepare(...args) }));
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: (...args: unknown[]) => acquire(...args), releaseLock: (...args: unknown[]) => release(...args) }));
jest.mock('../composio-catalog', () => ({ getToolkit: (...args: unknown[]) => toolkit(...args), listAuthConfigs: (...args: unknown[]) => configs(...args) }));
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'), createComposioClient: () => ({ request }) }));

const slug = 'googlecalendar';
const scope = 'https://www.googleapis.com/auth/calendar.events.readonly';
const existing = { items: [{ id: 'ac_calendar', authScheme: 'OAUTH2', status: 'ENABLED' }], next_cursor: null };
const empty = { items: [], next_cursor: null };
const created = { toolkit: { slug }, auth_config: { id: 'ac_calendar', is_composio_managed: true, auth_scheme: 'OAUTH2' } };

beforeEach(() => {
  jest.resetAllMocks();
  prepare.mockResolvedValue({ provider: { project_id: 'project-1' }, credential: {} });
  acquire.mockResolvedValue({ state: 'acquired', token: 'lock-owner' });
  toolkit.mockResolvedValue({ slug, managed_oauth_scopes: [scope] });
  configs.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockResolvedValue(existing);
  request.mockResolvedValue(created);
});

it('creates only the approved preset and confirms the exact enabled configuration before releasing the project lock', async () => {
  await expect(createManagedOAuth('site', 'user', slug)).resolves.toEqual({ status: 'available' });
  expect(prepare).toHaveBeenCalledWith('site', 'user');
  expect(request).toHaveBeenCalledWith('/auth_configs', { method: 'POST', body: {
    toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth', name: 'Makinari Google Calendar (read-only)', credentials: { scopes: scope } },
  } });
  expect(configs).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0], 'lock-owner');
});

it('does not write when an enabled OAuth config already exists', async () => {
  configs.mockReset().mockResolvedValue(existing);
  await expect(createManagedOAuth('site', 'user', slug)).resolves.toEqual({ status: 'available' });
  expect(request).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});

it('never creates for an unauthorized workspace or an unreviewed toolkit', async () => {
  prepare.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  await expect(createManagedOAuth('site', 'user', slug)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await expect(createManagedOAuth('site', 'user', 'supabase')).rejects.toMatchObject({ code: 'MANAGED_OAUTH_UNAVAILABLE' });
  expect(toolkit).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it('fails closed if the scope or distributed lock is unavailable', async () => {
  toolkit.mockResolvedValueOnce({ slug, managed_oauth_scopes: [] });
  await expect(createManagedOAuth('site', 'user', slug)).rejects.toMatchObject({ code: 'MANAGED_OAUTH_UNAVAILABLE' });
  configs.mockReset().mockResolvedValue(empty);
  acquire.mockResolvedValueOnce({ state: 'contended' }).mockResolvedValueOnce({ state: 'unconfigured' });
  await expect(createManagedOAuth('site', 'user', slug)).rejects.toMatchObject({ code: 'AUTH_CONFIG_PENDING' });
  await expect(createManagedOAuth('site', 'user', slug)).rejects.toMatchObject({ code: 'AUTH_CONFIG_SETUP_REQUIRED' });
  expect(request).not.toHaveBeenCalled();
});

it('retains the lease when the created ID cannot be verified, without replaying the write', async () => {
  request.mockResolvedValue({ ...created, auth_config: { ...created.auth_config, id: 'ac_not_visible' } });
  await expect(createManagedOAuth('site', 'user', slug)).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
  expect(release).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it('releases the lease on a definite provider config validation rejection without retrying', async () => {
  request.mockRejectedValueOnce(new ConnectorError('PROVIDER_AUTH_CONFIG_INVALID', 'Rejected.', 422));
  await expect(createManagedOAuth('site', 'user', slug)).rejects.toMatchObject({ code: 'PROVIDER_AUTH_CONFIG_INVALID' });
  expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0], 'lock-owner');
  expect(request).toHaveBeenCalledTimes(1);
});
