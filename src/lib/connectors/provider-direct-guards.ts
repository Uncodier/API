import { classifyToolActions } from './tool-action-types';
import { toolkitSlug, toolSlug } from './composio-validation';
import { ConnectorError } from './types';

export function unsupportedDirectTool(): never {
  throw new ConnectorError('TOOL_UNREVIEWED', 'This action requires capabilities outside the isolated business account.', 403);
}

export function unsupportedDirectSchema(): never {
  throw new ConnectorError('SCHEMA_UNSUPPORTED', 'The action does not expose a supported, bounded argument contract.', 409);
}

// Negative evidence only. The actual privilege boundary is an independently attested
// provider-enforced account. Neither a benign-looking name nor a read hint grants access.
function words(value: string) {
  return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-z\d]+/gi, ' ').toLowerCase().trim();
}

// Match capabilities, not toolkit brands. Keep business IDs, terms like postal_code,
// and search queries distinct from a credential selector or a code runner.
const execution = /\b(?:sql|nosql|graphql|sparql|soql|dax|bash|shell|powershell|terminal|workbench|interpreters?|python|javascript|wasm|scripts?|scripting|commands?|eval|exec|execut(?:e|es|ing|ion)|invoke|proxies|proxy|rpc|curl|ssh|tunnel|stdio)\b/;
const infrastructure = /\b(?:admin(?:istrat(?:ion|ive|or))?|iam|rbac|sudo|superuser|privileg(?:e|es|ed)|impersonat\w*|oauth\d*|authorization|authentication|credentials?|secrets?|passwords?|passphrases?|cookies?|sessions?|keystores?|certificates?|firewalls?|dns|roles?|policies|policy|permissions?|grants?|tenants?|service accounts?|service role|access control|control plane|environment variables?|deploy(?:ment|ments)?|containers?|clusters?|triggers?|webhooks?|callbacks?|migrations?|backups?|serverless|functions?|workflows?|automations?|pipelines?|tool router|api keys?|api tokens?)\b/;
const fileOrNetwork = /\b(?:files?|filepath|filenames?|filesystem|folders?|paths?|attachments?|downloads?|uploads?|multipart|blobs?|buckets?|binary|urls?|uris?|endpoints?|hostnames?|headers?|http requests?|api requests?|api calls?|rest calls?|raw requests?|network requests?|base url)\b/;
const selector = /\b(?:site|user|mailbox|account|agent|connector|project|org|organization|organisation|workspace|entity|instance|connection|principal|platform|schema|database|server|network|environment|host|key|keys|token|tokens|auth|config|configuration|settings|dsn|port|method|transport|payload|override|overrides|version|system)\b/;
// Also recognize compact/lowercase forms at the trust boundary. Do not depend
// on a particular provider's casing/underscore conventions for control fields.
const compactOverrides = /apikey|accesstoken|refreshtoken|bearertoken|privatekey|secretkey|clientsecret|authconfig|authparams|authscheme|authtoken|authheader|connectiondata|connectedaccount|connectionstring|serviceaccount|tenantid|workspaceid|projectref|projectid|organizationid|organisationid|accountid|userid|entityid|endpoint|hostname|headers|credential|password|passwd|filedata|filepath|filename|directory|baseurl|callbackurl|redirecturi|proxytarget|sourcecode|inlinecode|contentbytes|base64|requestbody|requestparams/;
const unsafeOperation = /\b(?:run|running|call|execute|evaluate|compile|inject|install|load|arbitrary|custom)\b.*\b(?:code|program|tool|expression|query|statement|template|package|plugin|binary|request|api)\b|\b(?:inline code|source code|code execution|raw query|raw api|database query|query database|control plane|connection string|service token|access token|private key)\b/;
const wholeScope = /\b(?:accounts?|organizations?|organisations?|workspaces?|instances?|databases?|configurations?|settings|auth|networks?|servers?|environments?)\b/;

function unsafeCapability(text: string) {
  return execution.test(text) || infrastructure.test(text) || fileOrNetwork.test(text) || unsafeOperation.test(text);
}

export function directActionNameSafe(kit: string, slug: string): boolean {
  if (!toolkitSlug.safeParse(kit).success || !toolSlug.safeParse(slug).success || /[^A-Z0-9_]/.test(slug)) return false;
  const prefix = `${kit.toUpperCase().replace(/-/g, '_')}_`;
  if (!slug.startsWith(prefix) || !/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(slug.slice(prefix.length))) return false;
  const operation = words(slug.slice(prefix.length));
  // Exact metadata reads on already-stored objects are not filesystem/URL access.
  // Longer names (such as GET_FILE_CONTENT or LIST_FILES_AND_DOWNLOAD) do not qualify.
  const storedMetadata = /^(?:list|find|search) (?:all )?(?:files|folders)$|^get (?:file|folder) (?:metadata|details)$/.test(operation);
  if (storedMetadata) return true;
  // Stripe's native retrieval takes a promotion_code_id (a coupon record), not
  // executable code. Do not exempt CODE generally, other verbs, or other toolkits.
  if (kit === 'stripe' && operation === 'retrieve promotion code') return true;
  return !unsafeCapability(operation) && !wholeScope.test(operation) && !/\b(?:tokens?|keys?|repl|code|batch actions?)\b/.test(operation);
}

// Provider prose, examples and names are never authority or executable schema.
// Deliberately do not classify descriptions (a calendar may mention attachment URLs).

export function directFieldSafe(name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) || /[^A-Za-z0-9_]/.test(name) ||
    Object.hasOwn(Object.prototype, name) || compactOverrides.test(name.replace(/_/g,'').toLowerCase())) return false;
  const field = words(name);
  // Pagination and read filters are not authority selectors. No access token/role setter is exposed.
  if (['min access role', 'max access role', 'file id', 'folder id', 'parent folder id', 'parent file id'].includes(field)) return true;
  return !unsafeCapability(field) && (!selector.test(field) || ['page token', 'next page token', 'previous page token', 'sync token'].includes(field)) && !['to json', 'prototype', 'code', 'program', 'statement', 'ref', 'argv', 'args', 'raw', 'expression', 'domain', 'full', 'cmd', 'request', 'request options', 'ip', 'ip address'].includes(field);
}

const writes = /\b(?:add|archive|assign|book|cancel|change|close|copy|create|delete|duplicate|edit|insert|merge|move|patch|publish|put|remove|replace|reset|restore|save|send|set|submit|sync|transfer|update|upsert|write)\b/;
export function directEffect(tags: string[], kit: string, slug: string): 'read' | 'write' | 'unknown' {
  const hints = classifyToolActions(tags);
  if (hints.some(type => type !== 'read') || writes.test(words(slug.slice(kit.length + 1)))) return 'write';
  // An unrecognized behavior hint can contradict readOnlyHint. Missing metadata is not a read.
  if (hints.includes('read') && !tags.some(tag => /hint$/i.test(tag) && !['readOnlyHint', 'idempotentHint', 'openWorldHint'].includes(tag))) return 'read';
  return 'unknown';
}
