import 'server-only';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { decryptCredential } from './crypto';
import { evaluateCapabilities } from './catalog';
import { claimSetup, finishSetup } from './setup-store';
import { publishConnection } from './store';
import { selectorFingerprint, selectorRequest, validateRecommendations } from './selector';
import { OpenRouterError, type ConnectionRow } from './types';
import type { Mutation } from './validation';
import { combinedChatPolicyIssue } from './chat-contract';

export async function recommendModels(row: ConnectionRow, actorId: string, input: Extract<Mutation, { operation: 'recommend' }>): Promise<ConnectionRow> {
  const preferences = { preferredVendor: input.preferredVendor, maxPromptPrice: input.maxPromptPrice, maxCompletionPrice: input.maxCompletionPrice };
  const selection = selectorRequest(row, preferences, input.maxCostUsd);
  if (Object.keys(selection.candidates).every(id => row.capabilities[id as keyof typeof row.capabilities].recommendation?.fingerprint === selectorFingerprint(row, preferences))) return row;
  const key = decryptCredential(row.encrypted_credential!, row.site_id, row.id, row.credential_version);
  await claimSetup(row, actorId, input.operationId, 'recommend', selection.fingerprint, input.maxCostUsd);
  let response: Record<string, any> | undefined;
  try {
    const http = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(selection.body), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    });
    if (!http.ok) throw new Error('Provider rejected setup');
    response = JSON.parse((await readResponseWithLimit(http, 128000)).toString('utf8'));
    if (response?.choices?.[0]?.finish_reason !== 'stop' || typeof response?.choices?.[0]?.message?.content !== 'string'
      || response.choices[0].message.tool_calls?.length) throw new Error('Incomplete selection');
    const recommendations = validateRecommendations(JSON.parse(response.choices[0].message.content), selection.candidates, selection.fingerprint);
    const cost = response?.usage?.cost;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > input.maxCostUsd) throw new Error('Uncertain setup charge');
    await finishSetup(row.site_id, input.operationId, 'completed', { generationId: typeof response.id === 'string' ? response.id.slice(0, 200) : null,
      gatewayCost: cost, modelId: selection.body.model, fingerprint: selection.fingerprint, recommendations, platformCharge: 0 });
    const capabilities = structuredClone(row.capabilities);
    for (const [id, recommendation] of Object.entries(recommendations)) capabilities[id as keyof typeof capabilities].recommendation = recommendation;
    // Publication is separately revision checked. Accepted inference is never replayed after a conflict.
    const evaluated = evaluateCapabilities(capabilities,row.catalog);
    const issue = combinedChatPolicyIssue(evaluated,row.catalog);
    if (issue) throw new OpenRouterError('combined_capability_unsupported',issue,422);
    return await publishConnection(row.site_id, actorId, row.revision, { ...row, capabilities: evaluated });
  } catch (error) {
    if (error instanceof OpenRouterError && error.code === 'revision_conflict') throw error;
    await finishSetup(row.site_id, input.operationId, 'uncertain', { generationId: typeof response?.id === 'string' ? response.id.slice(0, 200) : null, platformCharge: 0 }).catch(() => undefined);
    throw new OpenRouterError('setup_uncertain', 'AI selection was not published. Check setup status before authorizing another attempt; the request will not be replayed.', 409);
  }
}