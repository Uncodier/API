/** Never copy provider text, field values, paths, URLs, headers or SDK causes into
 * durable errors. Only emit constants selected from bounded validation metadata. */
export type WorkspaceProviderOperation = 'get' | 'create' | 'update-network-policy' | 'update-tags' | 'adopt-update' | 'bootstrap';

const operations: WorkspaceProviderOperation[] = ['get', 'create', 'update-network-policy', 'update-tags', 'adopt-update', 'bootstrap'];
const codes = ['bad_request', 'invalid_request', 'validation_error', 'invalid_request_body', 'forbidden', 'unauthorized',
  'not_found', 'conflict', 'rate_limited', 'internal_server_error'];
const fields = ['name', 'projectId', 'teamId', 'resume', 'persistent', 'image', 'runtime', 'timeout', 'ports', 'resources',
  'networkPolicy', 'subnets', 'deny', 'allow', 'headers', 'transform', 'env', 'tags', 'harnessSession',
  'harnessRepository', 'harnessReady', 'keepLastSnapshots', 'count', 'snapshotExpiration', 'source', 'region'];
const rules: Record<string, RegExp> = {
  additionalProperties: /additional propert(?:y|ies)|additionalProperties/i,
  required: /\brequired\b|must have required property/i,
  maxLength: /maxLength|too long|longer than|at most .{0,12}characters|maximum length/i,
  minLength: /minLength|too short|shorter than|at least .{0,12}characters|minimum length/i,
  pattern: /\bpattern\b|regular expression/i,
  format: /\bformat\b/,
  ipv4: /\bipv4\b/i,
  ipv6: /\bipv6\b/i,
  cidr: /\bcidr\b/i,
  type: /\btype\b|must be (?:a |an )?(?:string|number|integer|boolean|object|array)/i,
  enum: /\benum\b|allowed values/i,
  minimum: /\bminimum\b|greater than/i,
  maximum: /\bmaximum\b|less than/i,
  unsupported: /\bunsupported\b|not supported/i,
  snapshotMissing: /no snapshot available/i,
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export function workspaceProviderDiagnostic(error: unknown, operation?: WorkspaceProviderOperation): string {
  if (!operation || !operations.includes(operation)) return '';
  const provider = record(record(record(error).json).error);
  const code = typeof provider.code === 'string' && codes.includes(provider.code) ? provider.code : 'unclassified';
  // The installed SDK's APIError exposes json.error. Do not fall back to its
  // message/text/cause: those may include request credentials or response HTML.
  const details = [provider, ...[provider.errors, provider.issues].flatMap(value => Array.isArray(value) ? value.slice(0, 8) : [])];
  const text = details.flatMap(value => {
    const detail = record(value);
    return [detail.message, detail.keyword, detail.instancePath, detail.dataPath, detail.path,
      record(detail.params).missingProperty, record(detail.params).additionalProperty];
  }).filter((value): value is string => typeof value === 'string').map(value => value.slice(0, 2048)).join(' ');
  const mentioned = fields.filter(field => new RegExp(`\\b${field}\\b`).test(text));
  const validation = Object.entries(rules).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return ` [workspace-v1 operation=${operation}; provider_code=${code}; fields=${mentioned.join(',') || 'unclassified'}; rules=${validation.join(',') || 'unclassified'}]`;
}