import { ConnectorError } from './types';

function isModelConnectorId(id: unknown): id is string {
  return typeof id === 'string' && id.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
}

/** Private Ask presentation only. Match the suffix in the picker; route by the full local ID.
 * Do not pass a provider binding, email or account display name into model-facing metadata. */
export function modelAccountIdentity(connectorId: string) {
  if (!isModelConnectorId(connectorId)) throw new ConnectorError('INVALID_TOOL_REFERENCE', 'Invalid local connection reference.', 400);
  return { connector_id: connectorId, account_label: `Account …${connectorId.slice(-8)}` };
}
