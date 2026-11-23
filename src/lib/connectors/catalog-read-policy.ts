import type { CatalogReadMetadata } from './catalog-read-metadata';
import { unsupportedAction, unsupportedScopes } from './catalog-read-metadata';
import type { ComposioAccount } from './composio-accounts';
import type { PublishedList } from './catalog-read-published';

const infrastructure = /supabase|database|postgres|mysql|sqlite|mongo|snowflake|bigquery|cloud|aws|azure|gcp|kubernetes|docker|vault|iam|auth|okta|password|secret|admin|proxy|storage|filesystem|drive|dropbox|composio|shell|terminal|payment|bank|payroll|keychain|security/i;
// Negative evidence is a veto, never proof. Positive proof additionally requires a native API,
// a verified private provider account, a resource-specific, exact read-only
// descriptor, and *both* a bounded page contract and an independently validated summary schema.
const sensitiveRoots = [
  // Identity, secrets, tenancy and business-sensitive domains.
  /credential|secret|password|passwd|token|key|auth|principal|identit|account|user|member|role|permi|grant|tenant|workspace|organi[sz]at|project|team|admin|session|cookie|vault|certific/,
  /billing|payment|payout|payroll|bank|card|invoice|credit|balance|salary|wage|employee|staff|patient|medical|health|socialsecurity|address|email|message|contact/,
  // Fetch targets, files, control plane, code execution and side effects.
  /config|setting|enviro|storage|bucket|file|folder|path|url|uri|link|proxy|webhook|callback|export|import|archive|backup|download|upload|dataset|database|table|sql|quer[yi]|request/,
  /command|script|code|snippet|mutation|writ|creat|updat|delet|destroy|send|publish|execut|function|log|debug|diagnostic|header|attachment|octet|binary|private|encrypt|checksum|signature|recovery/,
  /audit|vulnerabilit|endpoint|network|host|device|node|comput|server|cluster|instance|container|machine|pipeline|process|workflow|automation|agent|robot|tool|service|resolver|connector|integrat|deploy|repo|trace/,
];
const hazardousOperation = /\b(?:admin\w*|secrets?|credentials?|passwords?|tokens?|files?|attachments?|exports?|uploads?|downloads?|urls?|webhooks?|sql|proxy|scripts?|execut\w*|mutat\w*|writ\w*|creat\w*|updat\w*|delet\w*|send\w*|impersonat\w*|identit\w*)\b|:\/\//i;
const noun = (name: string) => /^[a-z]{2,30}s$/.test(name) && !sensitiveRoots.some(root => root.test(name));
function scopeResource(scope: string, toolkit: string) {
  // Exact scope syntax. Wildcards, generic read, OAuth identities, URL scopes, admin namespaces
  // or an unknown compound expression have no derived authority. Never guess from a suffix.
  const suffix = /^([a-z]+)[.:](?:read|readonly)$/.exec(scope);
  const prefix = /^read[:_]([a-z]+)$/.exec(scope);
  const hubspot = toolkit === 'hubspot' ? /^crm\.objects\.([a-z]+)\.read$/.exec(scope) : null;
  const resource = (suffix || prefix || hubspot)?.[1];
  return resource && noun(resource) ? resource : null;
}

function hasHazardousAnnotation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => typeof v === 'string' && (k === 'description' || k === 'title')
    ? (hazardousOperation.test(v) || /\b(?:email|identity|credentials?|keys?|secrets?|login|Bearer|passwords?)\b/i.test(v))
    : hasHazardousAnnotation(v));
}

// A naming convention is a discovery hint only. GET/FETCH can qualify as a bounded
// collection read only under the same independent schema, scope and account checks as LIST.
function collectionResource(toolkit: string, slug: string): string | undefined {
  if (infrastructure.test(toolkit)) return;
  const prefix = `${toolkit.toUpperCase()}_`;
  const match = slug.startsWith(prefix) && /^(?:LIST|GET|FETCH)_(?:ALL_)?([A-Z]+)$/.exec(slug.slice(prefix.length));
  if (!match) return;
  const resource = match[1].toLowerCase();
  return noun(resource) ? resource : undefined;
}

export function ordinaryCatalogResource(tool: CatalogReadMetadata) {
  const resource = collectionResource(tool.toolkit.slug, tool.slug);
  if (!resource || hazardousOperation.test(tool.description) ||
    hasHazardousAnnotation(tool.input_parameters) || hasHazardousAnnotation(tool.output_parameters)) unsupportedAction();
  if (tool.scopes.length === 0 || !tool.scopes.every(scope => scopeResource(scope, tool.toolkit.slug) === resource)) unsupportedScopes();
  return resource;
}

export function assertOrdinaryCatalogAccount(account: ComposioAccount, tool: CatalogReadMetadata, required: readonly string[]) {
  if (account.accountType !== 'PRIVATE' || (!account.oauth2 && !account.apiKeyAuth)) unsupportedScopes();
  if (!required.every(scope => tool.scopes.includes(scope))) unsupportedScopes();
  // This path has already constrained the operation, selectors and output. Its actual data
  // access is the provider's decision for this exact account, not a reconstruction from OAuth
  // metadata (which can be omitted, grant broader authority, or not exist for API keys).
}

export function publishedArguments(profile: PublishedList, args: Record<string, unknown>) {
  const limit = args[profile.limitField]; // already validated against the local model schema
  return profile.kind === 'hubspot' ? { limit, archived: false, properties: [profile.nameField] }
    : { max_results: limit, show_hidden: false, show_deleted: false };
}
