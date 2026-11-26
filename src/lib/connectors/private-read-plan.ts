import { assertReportContract } from './supabase-report-contract';
import { isSupabaseReportAction } from './provider-report-action';
import { metadata, readContract, checkScopes, checkWorkflowArguments } from './workflow-read-policy';
import { unsupportedDirectTool } from './provider-direct-guards';
import type { ComposioAccount } from './composio-accounts';

/** A continuation is not an ordinary user-directed mutation. Validate the live
 * provider contract on describe AND dispatch, in addition to normal account policy.
 * Never infer read safety from the model's arguments or an action-name prefix.
 */
export function privateReadPlan(raw: unknown, project: string | null | undefined, savedScopes: string[], account: ComposioAccount) {
  try {
    const tool = metadata.parse(raw);
    if (isSupabaseReportAction(tool.toolkit.slug, tool.slug)) {
      if (!project) unsupportedDirectTool();
      // This exact provider release uses its read-only DB role; beta SQL does not.
      assertReportContract(tool);
      return;
    }
    if (project || (!account.apiKeyAuth && !account.scopesKnown)) unsupportedDirectTool();
    checkScopes(tool.scopes, savedScopes, account.apiKeyAuth);
    checkScopes(tool.scopes, account.scopes, account.apiKeyAuth);
    const {input_schema,outputContract} = readContract(tool);
    return {parameters:input_schema, outputContract, validate:(args:Record<string,unknown>) => checkWorkflowArguments(input_schema,args)};
  } catch { unsupportedDirectTool(); }
}
