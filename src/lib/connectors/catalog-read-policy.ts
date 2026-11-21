import type { CatalogReadMetadata } from './catalog-read-metadata';
import { unsupportedAction, unsupportedScopes } from './catalog-read-metadata';
import type { ComposioAccount } from './composio-accounts';
import { calendarReadScopes, publishedList, type PublishedList } from './catalog-read-published';
import { ConnectorError } from './types';

const infrastructure = /supabase|database|postgres|mysql|sqlite|mongo|snowflake|bigquery|cloud|aws|azure|gcp|kubernetes|docker|vault|iam|auth|okta|password|secret|admin|proxy|storage|filesystem|drive|dropbox|composio|shell|terminal|payment|bank|payroll|keychain|security/i;
// Negative evidence is a veto, never proof. Positive proof additionally requires a native API,
// a private OAuth2 account with exclusively resource-specific read grants, an exact read-only
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

export function ordinaryCatalogResource(tool: CatalogReadMetadata) {
  const prefix = `${tool.toolkit.slug.toUpperCase()}_LIST_`;
  if (!tool.slug.startsWith(prefix) || infrastructure.test(tool.toolkit.slug) || hazardousOperation.test(tool.description) ||
    hasHazardousAnnotation(tool.input_parameters) || hasHazardousAnnotation(tool.output_parameters)) unsupportedAction();
  const resource = tool.slug.slice(prefix.length).toLowerCase();
  if (!noun(resource)) unsupportedAction();
  if (tool.scopes.length === 0 || !tool.scopes.every(scope => scopeResource(scope, tool.toolkit.slug) === resource)) unsupportedScopes();
  return resource;
}

export function assertOrdinaryCatalogAccount(account: ComposioAccount, tool: CatalogReadMetadata, required: readonly string[]) {
  if (account.accountType !== 'PRIVATE' || !account.oauth2) unsupportedScopes();
  if (!required.every(scope => tool.scopes.includes(scope))) unsupportedScopes();
  const profile = publishedList(tool.toolkit.slug, tool.slug);
  if (profile) {
    if (profile.kind === 'calendar') {
      // CalendarList.list accepts ANY of the four documented scopes. Only the
      // two explicit read-only scopes in the live private account can authorize us.
      if (!account.scopesKnown) unsupportedScopes();
      // A writer may have provider access but is outside this profile; that is not a missing permission.
      if (account.scopes.some(s => !calendarReadScopes.includes(s))) unsupportedScopes();
      if (!account.scopes.some(s => calendarReadScopes.includes(s)) || !required.every(s => account.scopes.includes(s))) missingScope();
      return;
    }
    // The exact pinned, portal-bound CRM list enforces its resource scope upstream.
    // An omitted scope is not an explicit empty grant; never generalize to other actions.
    if (!account.scopesKnown) return;
    if (!tool.scopes.every(scope => account.scopes.includes(scope))) missingScope();
    // HubSpot's required OAuth protocol scope is not authority for additional data.
    if (account.scopes.some(s => s !== 'oauth' && !/^crm\.objects\.(?:companies|deals)\.read$/.test(s))) unsupportedScopes();
    return;
  }
  if (!account.scopesKnown) unsupportedScopes();
  if (!tool.scopes.every(scope => account.scopes.includes(scope))) missingScope();
  if (account.scopes.some(scope => !scopeResource(scope, tool.toolkit.slug))) unsupportedScopes();
}

function missingScope(): never {
  throw new ConnectorError('CONNECTOR_SCOPE_MISSING', 'The connected account does not report the required resource read permission. Review its OAuth grant.', 403);
}

export function publishedArguments(profile: PublishedList, args: Record<string, unknown>) {
  const limit = args[profile.limitField]; // already validated against the local model schema
  return profile.kind === 'hubspot' ? { limit, archived: false, properties: [profile.nameField] }
    : { max_results: limit, show_hidden: false, show_deleted: false };
}
