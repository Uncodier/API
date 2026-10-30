import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const content = '# Cloud note\nInitial text.\n';
const changed = '# Cloud note\nUpdated text.\n';
const hash = text => createHash('sha256').update(text).digest('hex');
const exact = text => ({ sha256: hash(text), bytes: Buffer.byteLength(text, 'utf8') });

// Proposed behavior contracts, not registered tools or simulated implementations.
// Read/search API names remain undecided; never substitute workspace tools.
export const cloudCases = [
  { id: 'cloud-search-name', operation: 'search',
    request: 'Find the private cloud document cloud-note.md by name without opening a workspace.',
    assertions: ['authorized_file_id', 'source_cloud', 'bounded_pagination', 'tenant_isolation'],
    blocker: 'CLOUD_SEARCH_NOT_IMPLEMENTED' },
  { id: 'cloud-search-content', operation: 'search',
    request: 'Search authorized cloud documents for Updated text with pagination; do not search the workspace.',
    assertions: ['content_match', 'source_cloud', 'bounded_pagination', 'tenant_isolation'],
    blocker: 'CLOUD_SEARCH_NOT_IMPLEMENTED' },
  { id: 'cloud-write-read', operation: 'create_read',
    request: 'Create cloud-note.md as a private UTF-8 document, then read it by its returned file ID.',
    input: { name: 'cloud-note.md', mime: 'text/markdown', content }, expected: exact(content),
    assertions: ['durable_file_id', 'version', 'private_by_default', 'independent_storage_bytes', 'authenticated_read'],
    blocker: 'CLOUD_FILE_EDIT_AND_READ_NOT_IMPLEMENTED' },
  { id: 'cloud-replace-read', operation: 'replace_read',
    request: 'Replace an authorized document using its file ID and expected version, then independently read the new version.',
    input: { content: changed }, expected: exact(changed),
    assertions: ['same_file_id', 'incremented_version', 'independent_storage_bytes', 'prior_version_preserved'],
    blocker: 'CLOUD_FILE_EDIT_AND_READ_NOT_IMPLEMENTED' },
  { id: 'cloud-patch-read', operation: 'patch_read',
    request: 'Patch Initial text. to Updated text. using the file ID and expected version; read the exact resulting bytes.',
    input: { old_text: 'Initial text.', new_text: 'Updated text.' }, expected: exact(changed),
    assertions: ['exact_patch', 'same_file_id', 'incremented_version', 'independent_storage_bytes'],
    blocker: 'CLOUD_FILE_EDIT_AND_READ_NOT_IMPLEMENTED' },
  { id: 'cloud-stale-version', operation: 'conflict',
    request: 'Attempt an edit with an obsolete expected version; verify conflict and unchanged current document bytes.',
    expected: exact(changed),
    assertions: ['version_conflict', 'current_version_returned', 'no_overwrite', 'independent_storage_bytes'],
    blocker: 'CLOUD_FILE_VERSIONING_NOT_IMPLEMENTED' },
].map(spec => ({ ...spec, source: 'cloud', requiresSandbox: false,
  requiresRequirement: false, requiresRepository: false,
  assertions: [...spec.assertions, 'zero_sandbox_provider_calls', 'no_workspace_fallback', 'trusted_actor_scope'] }));

export function cloudContractReport() {
  return {
    suite: 'harness-cloud-without-sandbox', mode: 'contract-only',
    state: 'blocked', healthGreen: false, behaviorPassed: false,
    liveExecution: false, sandboxProviderCalls: 0,
    note: 'No cloud file executor exists. Zero calls reflect no execution, not a behavioral pass. Independent live storage evidence is required before these cases can pass.',
    cases: cloudCases.map(spec => ({ ...spec, state: 'blocked', reason: spec.blocker, executed: false })),
  };
}

export function runCloudContracts(args = []) {
  const mode = args[0] || 'report';
  if (args.length > 1 || !['list', 'report'].includes(mode)) throw new Error('Supported cloud contract modes: list, report');
  return { output: mode === 'list' ? cloudCases : cloudContractReport(), exitCode: mode === 'list' ? 0 : 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { output, exitCode } = runCloudContracts(process.argv.slice(2));
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}