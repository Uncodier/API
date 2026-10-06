export const NODE_CONTEXT_REQUIRES_NODE = 'NODE_CONTEXT_REQUIRES_NODE';
export const NODE_CONTEXT_REQUIRES_NODE_MESSAGE =
  'Node-specific context requires instance_node_id scoped to the requested instance and site.';

const NODE_OUTPUT_TYPES = new Set([
  'image', 'video', 'audio', 'text', 'prompt', 'response', 'audience', 'publish',
  'generate-image', 'generate-video', 'generate-audio', 'generate-audience',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nodeOutputType(value: unknown): boolean {
  return nonemptyString(value) && NODE_OUTPUT_TYPES.has(value.trim().toLowerCase().replaceAll('_', '-'));
}

/**
 * Only inspect top-level selectors from the visual-node context contract, not
 * prose, generic parameters, attachments, or nested records describing nodes.
 * Legacy callers omit nodeType and use media/output selectors or destinations;
 * the UI proxy also supplies ui_contract. None of these can establish identity.
 */
export function isNodeSpecificContext(contextString?: string): boolean {
  if (!contextString) return false;
  let context: unknown;
  try { context = JSON.parse(contextString); } catch { return false; }
  if (!record(context)) return false;

  return nonemptyString(context.nodeType)
    || nonemptyString(context.instance_node_id)
    || nonemptyString(context.instanceNodeId)
    || [context.mediaType, context.media_type, context.output_type].some(nodeOutputType)
    || Array.isArray(context.publish_destinations)
    || (record(context.ui_contract) && nodeOutputType(context.ui_contract.output_type));
}

export function assertNodeContextHasNode(contextString?: string, instanceNodeId?: string): void {
  if (!nonemptyString(instanceNodeId) && isNodeSpecificContext(contextString)) {
    // Never promote an ID embedded in untrusted context into execution scope.
    // A supplied ID is still validated by the scoped UI/publish node lookups.
    throw new Error(`${NODE_CONTEXT_REQUIRES_NODE}: ${NODE_CONTEXT_REQUIRES_NODE_MESSAGE}`);
  }
}