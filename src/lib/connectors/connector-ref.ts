import {ConnectorError} from './types';

const refPattern = /^connector:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):((?!COMPOSIO_)[A-Z0-9][A-Z0-9_]{0,149})$/;
export function parseConnectorToolRef(name: string) {
  const match = typeof name === 'string' && name.length <= 197 && refPattern.exec(name);
  if (!match || match[0] !== name) throw new ConnectorError('INVALID_TOOL_REFERENCE', 'Use the exact connector reference returned by discovery.', 400);
  return {connectorId:match[1],toolSlug:match[2]};
}
export function connectorToolRef(connectorId: string, toolSlug: string) {
  const name = `connector:${connectorId}:${toolSlug}`;
  parseConnectorToolRef(name);
  return name;
}