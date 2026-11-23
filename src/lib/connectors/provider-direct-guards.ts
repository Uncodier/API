import { classifyToolActions } from './tool-action-types';
import { ConnectorError } from './types';

export function unsupportedDirectTool(): never {
  throw new ConnectorError('TOOL_UNREVIEWED', 'This action is incompatible with the selected account or project binding.', 403);
}

export function unsupportedDirectSchema(): never {
  throw new ConnectorError('SCHEMA_UNSUPPORTED', 'The action does not expose a supported, bounded argument contract.', 409);
}

// Names and effect hints describe an operation; they do not grant or deny account access.
function words(value: string) {
  return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-z\d]+/gi, ' ').toLowerCase().trim();
}

// Keep authentication and account-binding overrides private, but do not classify
// declared SQL/code/file/network/admin parameters as forbidden capabilities.
const compactOverrides = /apikey|accesstoken|refreshtoken|bearertoken|privatekey|secretkey|clientsecret|authconfig|authparams|authscheme|authtoken|authheader|connectiondata|connectedaccount|connectionstring|serviceaccount|tenantid|workspaceid|projectref|projectid|organizationid|organisationid|accountid|userid|entityid|credential|password|passwd/;

export function directFieldSafe(name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) || /[^A-Za-z0-9_]/.test(name) ||
    Object.hasOwn(Object.prototype, name) || compactOverrides.test(name.replace(/_/g,'').toLowerCase())) return false;
  const field = words(name);
  return !['to json', 'prototype', 'ref', 'user id', 'mailbox', 'auth', 'authorization', 'authentication',
    'custom auth params', 'connection', 'connector id', 'site id', 'agent id', 'instance id'].includes(field);
}

const writes = /\b(?:add|archive|assign|book|cancel|change|close|copy|create|delete|duplicate|edit|insert|merge|move|patch|publish|put|remove|replace|reset|restore|save|send|set|submit|sync|transfer|update|upsert|write)\b/;
export function directEffect(tags: string[], kit: string, slug: string): 'read' | 'write' | 'unknown' {
  const hints = classifyToolActions(tags);
  if (hints.some(type => type !== 'read') || writes.test(words(slug.slice(kit.length + 1)))) return 'write';
  // An unrecognized behavior hint can contradict readOnlyHint. Missing metadata is not a read.
  if (hints.includes('read') && !tags.some(tag => /hint$/i.test(tag) && !['readOnlyHint', 'idempotentHint', 'openWorldHint'].includes(tag))) return 'read';
  return 'unknown';
}
