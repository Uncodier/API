import type { Capabilities, CatalogModel } from './types';

export type ChatCapability = 'text' | 'summary' | 'vision' | 'tools' | 'structured';

/** Combined calls use one primary policy, not equality between independent model pins.
 * Priority is semantic summary, then vision, tools, structured and plain text.
 */
export function supportsChatContract(model: CatalogModel, required: readonly ChatCapability[]): boolean {
  return model.inputModalities?.includes('text') === true && model.outputModalities?.includes('text') === true
    && required.every(capability => capability === 'tools' ? model.supportedParameters?.includes('tools')
      : capability === 'structured' ? model.supportedParameters?.includes('structured_outputs')
      : capability === 'vision' ? model.inputModalities?.includes('image') : true);
}

/** Return an actionable configuration problem without changing any manual pin. */
export function combinedChatPolicyIssue(policies: Capabilities, catalog: CatalogModel[]): string | null {
  const enabled = (['vision','tools','structured'] as const).filter(id => policies[id].mode !== 'disabled'
    && ['available','unverified'].includes(policies[id].status));
  for (const primary of enabled) {
    const required = enabled.slice(enabled.indexOf(primary));
    const model = catalog.find(model => model.id === policies[primary].modelId);
    if (model && !supportsChatContract(model, required)) {
      return `The ${primary} model must also support enabled ${required.join(', ')} capabilities for combined requests. Choose a compatible model or disable the unsupported capability.`;
    }
  }
  return null;
}