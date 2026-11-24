import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getVisibleConnector } from './account-access';
import { verifyDirectAccountIdentity } from './composio-accounts';
import { getToolkit } from './composio-catalog';
import { providerClient, requireCurrentProviderProof } from './connection-service';
import { acceptsDirectAccount, acceptsDirectToolkit } from './direct-compatibility';
import { ConnectorError, type Connector } from './types';

type Reason = 'toolkit' | 'auth_scheme' | 'project_token_required';
type Compatibility = { ask_compatible: true } | { ask_compatible: false; ask_incompatibility: Reason } | { ask_compatible: null; ask_incompatibility: 'unverified' };
const unverified = { ask_compatible: null, ask_incompatibility: 'unverified' } as const;
const blocked = (reason: Reason): Compatibility => ({ ask_compatible: false, ask_incompatibility: reason });

/** Manager-only; attribution is local and immutable. Provider identifiers and
 * account metadata never leave this boundary. A legacy connection is unchanged. */
export async function hostedAskCompatibility(site: string, actor: string, id: string, known?: Connector): Promise<Compatibility | undefined> {
  const { data, error } = await supabaseAdmin.from('site_connector_auth_attempts')
    .select('setup_mode,user_id,provider_id,credential_revision,toolkit_slug,auth_config_id,provider_account_id')
    .eq('site_id', site).eq('connector_id', id).eq('status', 'completed').neq('setup_mode', 'legacy')
    .limit(2).abortSignal(AbortSignal.timeout(5000));
  // A database predating hosted starts cannot contain a hosted account.
  if (error?.code === '42703' && /\bsetup_mode\b/.test(error.message)) return undefined;
  if (error || !Array.isArray(data)) connectorDatabaseError(error);
  if (!data.length) return undefined;
  const c = known ?? await getVisibleConnector(site, actor, id);
  const [a] = data;
  if (data.length !== 1 || !a || !['hosted', 'hosted_credentials'].includes(a.setup_mode) ||
      c.id !== id || c.site_id !== site || a.user_id !== c.created_by || a.provider_id !== c.provider_id ||
      a.auth_config_id !== c.auth_config_id || a.provider_account_id !== c.provider_account_id ||
      a.toolkit_slug !== c.toolkit_slug || c.provider_account_id === 'instant_account') return unverified;
  if (c.toolkit_slug === 'supabase') return blocked('project_token_required'); // Neutral OAuth has no immutable project pin.
  try {
    const { provider, client } = await providerClient(c);
    if (a.credential_revision !== provider.credential_revision) return unverified;
    const kit = await getToolkit(client, c.toolkit_slug);
    if (!kit.toolkit_type) return unverified;
    if (!acceptsDirectToolkit(kit)) return blocked('toolkit');
    const account = await verifyDirectAccountIdentity(client, { accountId: c.provider_account_id,
      authConfigId: c.auth_config_id, userId: provider.provider_user_id, toolkitSlug: c.toolkit_slug });
    if (!account.authScheme || account.accountType !== 'PRIVATE') return unverified;
    if (!acceptsDirectAccount(account) || (a.setup_mode === 'hosted_credentials' ? !account.apiKeyAuth : !account.oauth2)) return blocked('auth_scheme');
    await requireCurrentProviderProof(c, provider);
    return { ask_compatible: true };
  } catch {
    // Unavailable evidence cannot support opt-in, but local disable must work.
    return unverified;
  }
}

export async function requireHostedAskCompatibility(site: string, actor: string, id: string, connector?: Connector) {
  const result = await hostedAskCompatibility(site, actor, id, connector);
  if (result && result.ask_compatible !== true) {
    throw new ConnectorError('ASK_INCOMPATIBLE', 'Ask compatibility could not be verified for this connection.', 409);
  }
}
