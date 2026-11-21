import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError } from './access';
import { verifyAccountIdentity } from './composio-accounts';
import { manageable, providerClient, requireCurrentProviderProof, revisionBodySchema } from './connection-service';
import { ConnectorError } from './types';

const ref = z.string().length(20).regex(/^[a-z]{20}$/);
const projectBindingInput = revisionBodySchema.extend({ project_ref: ref }).strict();
// Manager maintenance only; this slug is intentionally absent from the assistant's reviewed tools.
const slug = 'SUPABASE_GET_PROJECT';
const version = '20261116_00'; // https://docs.composio.dev/toolkits/supabase.md
const annotations = { title: z.string().optional(), description: z.string().optional() };
const descriptor = z.object({
  slug: z.literal(slug), toolkit: z.object({ slug: z.literal('supabase') }), version: z.literal(version),
  is_deprecated: z.literal(false), deprecated: z.object({ is_deprecated: z.literal(false).optional() }).nullish(), no_auth: z.literal(false),
  // Supabase documents projects:read for v1-get-project. Never accept broader scopes or compound rules.
  scopes: z.tuple([z.string().regex(/^projects:read$/i)]), scope_requirements: z.null(),
  input_parameters: z.object({ ...annotations, type: z.literal('object'), required: z.tuple([z.literal('ref')]),
    properties: z.object({ ref: z.object({ ...annotations, type: z.literal('string'), pattern: z.enum(['^[a-z]{20}$', '^[a-z]+$']).optional(), examples: z.array(ref).optional(),
      minLength: z.literal(20).optional(), maxLength: z.literal(20).optional() }).strict() }).strict(),
    additionalProperties: z.literal(false).optional(),
  }).strict(),
});

function unproven(stage: 'account' | 'schema' | 'read' | 'identity'): never {
  const messages = {
    account: 'Composio could not confirm a hosted Supabase token account.',
    schema: 'The project verification tool does not match its reviewed schema.',
    read: 'The connected account did not complete the project metadata read.',
    identity: 'The metadata returned did not confirm the requested project identity.',
  };
  throw new ConnectorError(`SUPABASE_BIND_${stage.toUpperCase()}`, messages[stage], 422);
}

export async function bindSupabaseProject(actor: string, id: string, body: unknown) {
  const { site_id: site, expected_revision: revision, project_ref: project } = projectBindingInput.parse(body);
  const current = async () => {
    const c = await manageable(site, actor, id, revision);
    if (c.toolkit_slug !== 'supabase' || c.supabase_project_ref !== null || !c.verified_at || c.provider_status !== 'ACTIVE'
      || c.enabled !== true || c.revocation_pending !== false) {
      throw new ConnectorError('CONNECTOR_NOT_BINDABLE', 'Only an active, verified account without a project binding can be bound.', 409);
    }
    return c;
  };
  const connector = await current();
  if (connector.provider_account_id === 'instant_account') unproven('account'); // reserved provider selector, not an existing account
  const { provider, client } = await providerClient(connector);
  if (!descriptor.safeParse(await client.request(`/tools/${slug}?version=${version}`)).success) unproven('schema');
  const account = await verifyAccountIdentity(client, { accountId: connector.provider_account_id, userId: provider.provider_user_id,
    toolkitSlug: 'supabase', authConfigId: connector.auth_config_id });
  if (!account.hostedSupabasePat) unproven('account');
  await current(); await requireCurrentProviderProof(connector, provider);
  // Fixed, authenticated project metadata GET. No proxy, secrets, SQL, listing or account selection fallback.
  const result = await client.request(`/tools/execute/${slug}`, { method: 'POST', body: {
    connected_account_id: account.id, user_id: provider.provider_user_id, version, arguments: { ref: project },
  } });
  // v1-get-project: require the canonical ref AND project metadata, not echoed arguments, names or aliases.
  const proof = z.object({ successful: z.literal(true), error: z.null(), data: z.object({
    ref: z.literal(project), id: z.literal(project), organization_id: z.string().min(1),
  }) });
  if (!z.object({ successful: z.literal(true), error: z.null() }).safeParse(result).success) unproven('read');
  if (!proof.safeParse(result).success) unproven('identity');
  await requireCurrentProviderProof(connector, provider);
  const { data, error } = await supabaseAdmin.rpc('connector_bind_supabase_project', {
    p_site_id: site, p_connector_id: id, p_actor_id: actor, p_expected_revision: revision,
    p_project_ref: project, p_credential_revision: provider.credential_revision,
  }).abortSignal(AbortSignal.timeout(5_000));
  if (error) connectorDatabaseError(error);
  if (data?.connector_id !== id || data?.revision !== revision + 1) {
    throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'The local binding could not be confirmed. Refresh before retrying.', 502);
  }
  return { connector_id: id, revision: revision + 1 };
}
