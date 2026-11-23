import {parseConnectorToolRef} from './connector-ref';
import {ConnectorError} from './types';

// An account binds both capabilities, but a report never has a provider action's identity.
// Keep the provider-only parser strict for legacy hosts that cannot serve internal reports.
export const METRICS_REPORT = 'MAKINARI_METRICS';
const reportPattern = new RegExp(`^report:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):${METRICS_REPORT}$`);
export function parseReportRef(name: string) {
  const match = typeof name === 'string' && name.length <= 64 && reportPattern.exec(name);
  if (!match || name !== match[0]) throw new ConnectorError('INVALID_TOOL_REFERENCE','Use the exact Makinari report reference returned by search.',400);
  return {connectorId:match[1]};
}
export function reportRef(connectorId: string) {
  const name = `report:${connectorId}:${METRICS_REPORT}`;
  parseReportRef(name);
  return name;
}
export function parseInstanceToolRef(name: string) {
  return typeof name === 'string' && name.startsWith('report:')
    ? {origin:'makinari_report' as const,...parseReportRef(name)}
    : {origin:'provider' as const,...parseConnectorToolRef(name)};
}