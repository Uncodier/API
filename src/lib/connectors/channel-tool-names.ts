// Persisted tool names can restrict recovery but can never grant authority.
export const SUPPORT_CONNECTOR_TOOL = 'support_connectors';
export const CHANNEL_REVIEW_TOOL = 'request_connector_review';

export function isChannelConnectorDefinition(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object') return false;
  const def = tool as { name?: unknown; function?: { name?: unknown } };
  return [def.name, def.function?.name].some(name => name === SUPPORT_CONNECTOR_TOOL || name === CHANNEL_REVIEW_TOOL);
}

export function requiresAssignedChannelAgent(command: { tools?: unknown }): boolean {
  return Array.isArray(command.tools) && command.tools.some(isChannelConnectorDefinition);
}
