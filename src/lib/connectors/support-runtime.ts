import { supportConnectorTool, supportInput, supportScope, type SupportConnectorHost } from './support-runtime-contract';
import { discoverSupport } from './support-runtime-discovery';
import { authorizeSupportAction, denied, GMAIL, publicDescription } from './support-runtime-access';
import { publishedGmailInput, publishedGmailResult } from './support-public-gmail';
import { loadConnectorCredential } from './access';
import { parseConnectorToolRef } from './reviewed-tools';
import { validateJson } from './composio-transport';
import { describeConnectorTool, executeConnectorTool, hashConnectorSchema, validateConnectorArguments } from './composio-sessions';
import { reviewedInputSchema, assertReviewedInputLimits } from './reviewed-tool-schema';
import { validateConnectorInput } from './schema-validation';
import { supportMemberInput } from './support-member-input';
import { assertScopes } from './action-policy';
import { ConnectorError } from './types';
import { proposeExactSupportAction } from './approval-proposals';

export * from './support-runtime-contract';
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const capField = (slug: string) => slug === GMAIL ? 'max_results' : slug === 'HUBSPOT_LIST_CONTACTS' ? 'limit' : null;

/** No model-supplied context. The caller controls only discovery filters, an exact reference and public arguments. */
export async function executeSupportConnectorTool(host: SupportConnectorHost, name: string, args: unknown) {
  try {
    if (name !== supportConnectorTool.name) throw denied();
    validateJson(args);
    const encoded = JSON.stringify(args);
    if (Buffer.byteLength(encoded) > 8192) throw denied();
    const request = supportInput.parse(JSON.parse(encoded));
    const currentScope = async () => {
      const value = supportScope.parse(await host.resolve());
      if (value.siteId !== host.siteId || value.agentId !== host.agentId) throw denied();
      return value;
    };
    const scope = await currentScope();
    const recheckHost = async () => { if (hashConnectorSchema(scope) !== hashConnectorSchema(await currentScope())) throw denied(); };
    if (request.action === 'list' || request.action === 'search') {
      try { return await discoverSupport(scope, request, recheckHost); }
      catch (error) {
        // A valid continuation can become stale after the inventory changes. No account details are needed to restart.
        if (error instanceof ConnectorError && error.code === 'STALE_CURSOR') return { success: false, status: 'stale_cursor', hint: 'Repeat the search or list without the cursor.' };
        throw error;
      }
    }
    const {connectorId, toolSlug} = parseConnectorToolRef(request.name);
    const authorize = () => authorizeSupportAction(scope, connectorId, toolSlug);
    const initial = await authorize();
    const {access, tool, publication} = initial;
    const reauthorize = async () => {
      await recheckHost();
      if (hashConnectorSchema(await authorize()) !== hashConnectorSchema(initial)) throw denied();
    };
    const credential = await loadConnectorCredential(scope.siteId);
    if (credential.revision !== access.provider.credential_revision) throw denied();
    const target = { credential, provider: access.provider, connector: access.connector, toolSlug: tool.slug };
    const descriptor = await describeConnectorTool({ ...target, ...(request.action === 'call' ? { toolkitVersion: request.version } : {}) });
    if (descriptor.slug !== tool.slug || descriptor.toolkitSlug !== tool.toolkit || descriptor.scopeRequirements !== null) throw denied();
    assertScopes(access, tool, descriptor.scopes);
    const reviewed = reviewedInputSchema(tool.slug, descriptor.inputSchema);
    const fixed = publication ? publishedGmailInput(publication.labelId) : null;
    if (fixed) validateConnectorInput(reviewed, fixed);
    // The exposed hash also pins the selected account, publication label, approval state and policy revisions.
    const schemaHash = hashConnectorSchema([request.name, descriptor.schemaHash, descriptor.toolkitVersion, access, publication]);
    // The only public read is the existing explicitly published, label-bound title projection.
    // It is not permission to run a private operation on behalf of a visitor.
    if (scope.audience !== 'member' && !publication) throw denied();
    const needsReview = publication ? access.policy.require_approval !== false : access.requestOnly === true;
    const field = capField(tool.slug);
    const { parameters, readLimit } = publication ? {parameters:emptySchema, readLimit:undefined} : supportMemberInput(reviewed, field);
    if (request.action === 'describe') {
      if (Buffer.byteLength(JSON.stringify(parameters)) > 8192) throw denied();
      await reauthorize();
      return { success: true, name: request.name, version: descriptor.toolkitVersion, schema_hash: schemaHash,
        description: publication ? publicDescription : tool.description, parameters,
        ...(readLimit && {read_limit:readLimit}), require_approval: needsReview };
    }
    if (request.version !== descriptor.toolkitVersion || request.schema_hash !== schemaHash) throw denied();
    validateConnectorArguments(request.arguments);
    if (publication && Object.keys(request.arguments).length) throw denied();
    const input = fixed ?? {...request.arguments};
    if (!publication) {
      validateConnectorInput(parameters, input);
      if (readLimit?.default !== undefined && !Object.hasOwn(input, readLimit.field)) input[readLimit.field] = readLimit.default;
    }
    validateConnectorInput(reviewed, input);
    assertReviewedInputLimits(tool.slug, input);
    if (needsReview) {
      await reauthorize();
      const { siteId, conversationId, agentId, idempotencyKey, source } = scope;
      const origin = scope.audience === 'member' ? {kind: 'support_member' as const, user_id: scope.userId} :
        {kind: 'support_publication' as const, audience: scope.audience, publication_hash: hashConnectorSchema(publication),
          lead_id: scope.audience === 'verified' ? scope.leadId : null};
      const receipt = await proposeExactSupportAction({siteId, conversationId, agentId, idempotencyKey, ...(source && {source})}, origin, access, descriptor, input);
      return {success: true, status: receipt.status};
    }
    const result = await executeConnectorTool({ ...target, toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash,
      input, allowedTools: [tool.slug], requiredScopes: tool.requiredScopes, beforeDispatch: reauthorize });
    await reauthorize(); // Revocation or reassignment after provider dispatch must withhold the response.
    if (publication) return {success:true,status:'completed',result:publishedGmailResult(result, publication.labelId)};
    return {success: true, status: 'completed', ...(Buffer.byteLength(JSON.stringify(result.data)) <= 8192 ?
      {result: result.data} : {result_omitted: true})};
  } catch {
    // Never surface grant, account, provider or policy diagnostics in a customer conversation.
    return {success: false, status: 'unavailable'};
  }
}