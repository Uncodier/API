import { createHash } from 'node:crypto';
import { validateJson } from './composio-transport';
import { ConnectorError } from './types';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function hashConnectorSchema(schema: unknown): string {
  validateJson(schema);
  return createHash('sha256').update(canonicalJson(schema)).digest('hex');
}

/** Reject file/URL coercion inputs; data is never dereferenced or downloaded by this adapter. */
export function validateConnectorArguments(input: unknown): asserts input is Record<string, unknown> {
  validateJson(input);
  if (!input || Array.isArray(input) || typeof input !== 'object' || Buffer.byteLength(JSON.stringify(input)) > 48_000) {
    denyArgument('CONNECTOR_INVALID_INPUT', 'Tool arguments must be a bounded JSON object.');
  }
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && (/^(?:\/|~\/|\.\.?[\\/]|[a-z]:[\\/])/i.test(item)
      || /(?:https?|file|ftp|data|s3):\/\//i.test(item) || /^(?:data|file):/i.test(item))) {
      denyArgument('CONNECTOR_UNSAFE_ARGUMENT', 'File paths and external URL loading are not supported.');
    }
    if (item && typeof item === 'object') for (const [key, value] of Object.entries(item)) {
      if (/(?:^|_)(?:file|files|filepath|path|url|uri|attachments?)(?:$|_)/i.test(key)
        || ['custom_auth_params', 'custom_connection_data', 'connected_account_id', 'user_id', 'version', 'text'].includes(key)) {
        denyArgument('CONNECTOR_UNSAFE_ARGUMENT', 'This argument requires an unsupported execution capability.');
      }
      visit(value);
    }
  };
  visit(input);
}

function denyArgument(code: string, message: string): never {
  throw Object.assign(new ConnectorError(code, message, 409), { executed: false, effectStarted: false });
}
