import 'server-only';
import type { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadConnectorCredential } from './account-access';
import { sourceDigest } from './approval-source';
import { hashConnectorSchema } from './composio-tool-json';
import { parseConnectorToolRef } from './connector-ref';
import { modelAccountIdentity } from './model-account-identity';
import { snapshotDirectJson } from './provider-direct-schema';
import { describeDirectTool, executeDirectTool } from './provider-direct-transport';
import { providerResultFacts } from './provider-result-facts';
import { authorizeGenericSupport } from './support-generic-authority';
import { supportInput, memberSupportScope, type SupportConnectorScope } from './support-runtime-contract';
import { ConnectorError } from './types';

type MemberScope = Extract<SupportConnectorScope, {audience: 'member'}>;
type Request = Extract<z.infer<typeof supportInput>, {action: 'describe' | 'call'}>;
const unavailable = {success: false, status: 'unavailable'} as const;
const unconfirmed = {success: false, status: 'outcome_unconfirmed', automatic_retry: false} as const;
const providerDenials = new Set(['APP_AUTH_REJECTED', 'APP_RESOURCE_DENIED', 'APP_RESOURCE_UNAVAILABLE', 'APP_RATE_LIMITED',
  'PROVIDER_FORBIDDEN', 'PROVIDER_AUTH_FAILED', 'PROVIDER_NOT_FOUND', 'PROVIDER_RATE_LIMITED']);

/** Direct dispatch requires both the member and assigned agent use grants. The direct transport checks
 * the live account, pinned schema and arguments before entering the reservation callback. */
export async function executeGenericSupport(member: MemberScope, input: Request, recheckHost: () => Promise<void>) {
  let claimed = false;
  try {
    const scope = memberSupportScope.parse(member);
    const snapshot = snapshotDirectJson(input);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 8192) return unavailable;
    const request = supportInput.parse(snapshot);
    if (request.action !== 'describe' && request.action !== 'call') return unavailable;
    const {connectorId, toolSlug} = parseConnectorToolRef(request.name);
    await recheckHost();
    const authorize = () => authorizeGenericSupport(scope, connectorId, toolSlug);
    const initial = await authorize();
    const {target} = initial;
    if (!initial.releaseMemberResult || target.connector.id !== connectorId || target.connector.site_id !== scope.siteId || target.requestOnly) return unavailable;
    const stamp = hashConnectorSchema(initial);
    const recheck = async () => {
      await recheckHost();
      if (hashConnectorSchema(await authorize()) !== stamp) throw new Error('Support authority changed');
    };
    const credential = await loadConnectorCredential(scope.siteId);
    if (credential.revision !== target.provider.credential_revision) return unavailable;
    if (request.action === 'describe') {
      const d = await describeDirectTool(target, credential, toolSlug);
      const description = {success: true, name: request.name, tool_origin: 'provider', ...modelAccountIdentity(connectorId),
        toolkit: target.connector.toolkit_slug, description: `${toolSlug} on the selected account.`, effect: d.effect,
        version: d.version, schema_hash: d.schemaHash, parameters: d.parameters, require_approval: false};
      if (Buffer.byteLength(JSON.stringify(description)) > 8192) return unavailable;
      await recheck();
      return description;
    }

    const {version, schema_hash, arguments: args} = request;
    let response;
    try {
      response = await executeDirectTool(target, credential, toolSlug, {version, schema_hash, arguments: args}, async () => {
        await recheck();
        // Server turn identity, never arguments, schema revision or a model-generated retry key.
        const {data, error} = await supabaseAdmin.rpc('connector_claim_support_dispatch', {
          p_site_id: scope.siteId, p_agent_id: scope.agentId, p_user_id: scope.userId, p_conversation_id: scope.conversationId,
          p_connector_id: connectorId, p_slug: toolSlug, p_turn_digest: sourceDigest(scope.idempotencyKey),
        }).abortSignal(AbortSignal.timeout(5000));
        if (error || data !== true) throw new Error('Dispatch reservation not confirmed');
        claimed = true;
      });
    } catch (error) {
      if (!claimed) return {...unavailable, automatic_retry: false};
      if (error instanceof ConnectorError && providerDenials.has(error.code)) {
        await recheck();
        return {success: false, status: 'provider_denied', code: error.code, automatic_retry: false};
      }
      return unconfirmed;
    }
    if (!claimed) return unconfirmed;
    await recheck();
    const result = initial.releaseMemberResult === true ? providerResultFacts(response.data) : undefined;
    return {success: true, status: 'completed', ...(result ? {result} : {result_omitted: true})};
  } catch {
    return claimed ? unconfirmed : unavailable;
  }
}
