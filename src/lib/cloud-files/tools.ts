import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  assertToolScreenAccess, ToolScreenAccessDenied, ToolScreenAccessUnavailable,
} from '@/app/api/agents/tools/router/screen-access';
import { CloudGitError, publishCloudRevision } from './git';
import type { CloudFileStore } from './store';
import { CloudFileStoreError, type CloudRevision, type CloudScope } from './types';

const MAX_BYTES = 256 * 1024;
const uuid = z.string().uuid();
const version = z.number().int().min(1).max(2147483647);
const text = z.string().max(MAX_BYTES).refine(value => {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= MAX_BYTES && bytes.toString('utf8') === value && !value.includes('\0');
}, 'Use UTF-8 text of at most 262144 bytes without NUL.');
const name = z.string().min(1).max(200).refine(value =>
  value === value.trim() && Buffer.byteLength(value) <= 512
  && !/[\/\\:\x00-\x1f\x7f]/.test(value) && !/[. ]$/.test(value)
  && !['.', '..', '.git', '.github'].includes(value.toLowerCase())
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), 'Use a document basename, not a path.');
const mime = z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json',
  'text/html', 'text/css', 'text/javascript', 'application/javascript',
  'application/xml', 'text/xml', 'application/yaml', 'text/yaml']);
const thought = { thought_process: z.string().max(2000).optional() };
const readSchema = z.object({ file_id: uuid, version: version.optional(),
  offset: z.number().int().min(0).max(MAX_BYTES).optional(),
  max_chars: z.number().int().min(1).max(8000).optional(), ...thought }).strict();
const listSchema = z.object({
  requirement_id: uuid.optional(), query: z.string().max(200).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  limit: z.number().int().min(1).max(100).optional(), ...thought,
}).strict();
const writeSchema = z.object({
  action: z.enum(['create', 'replace', 'patch']), file_id: uuid.optional(),
  expected_version: version.optional(), requirement_id: uuid.optional(),
  name: name.optional(), mime: mime.optional(), content: text.optional(),
  changes: z.array(z.object({ old_text: text.refine(value => value.length > 0), new_text: text }).strict())
    .min(1).max(100).optional(), ...thought,
}).strict().superRefine((value, context) => {
  const invalid = value.action === 'create'
    ? value.file_id !== undefined || value.expected_version !== undefined || value.changes !== undefined
      || value.name === undefined || value.content === undefined
    : value.file_id === undefined || value.expected_version === undefined
      || (value.action === 'replace' ? value.content === undefined || value.changes !== undefined
        : value.content !== undefined || value.changes === undefined);
  if (invalid) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid action fields.' });
  if (value.changes && value.changes.reduce((sum, edit) => sum + Buffer.byteLength(edit.old_text)
    + Buffer.byteLength(edit.new_text), 0) > MAX_BYTES * 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Patch payload too large.' });
  }
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface CloudToolResult {
  ok: boolean;
  output: { [key: string]: Json };
  error?: { code: string; message: string; effectStarted?: boolean };
}
export interface CloudFileToolOptions {
  /** Host-owned stable UUID for durable replay; never accepted from tool arguments. */
  operationId?: () => string;
  store?: CloudFileStore;
  publish?: typeof publishCloudRevision;
  /** Only the durable requirement execution owner may set this. */
  allowRequirementWrite?: boolean;
}
const messages = {
  invalid_input: 'Use the cloud file schema, bounded UTF-8 text, and document basenames.',
  forbidden: 'Cloud file access denied.',
  not_found: 'Cloud file revision not found.',
  operation_mismatch: 'This operation was already used with different input.',
  patch_conflict: 'Patch text must match exactly once; reread the file before editing.',
  quota_exceeded: 'Cloud file storage quota reached. No document or revision was changed.',
  unavailable: 'Cloud file service is temporarily unavailable.',
  inactive: 'Cloud file execution is no longer active.',
  requirement_owner_required: 'Requirement document writes must use the requirement execution owner.',
} as const;
class InactiveCloudToolError extends Error {}
function failure(code: keyof typeof messages): CloudToolResult {
  const error = { code, message: messages[code], ...(code === 'unavailable' ? {} : { effectStarted: false }) };
  return { ok: false, error, output: { error } };
}

/** Private document tools only: no sandbox, shell, workspace, deployment, or public storage. */
export function createCloudFileTools(
  trustedScope: CloudScope, assertActive: () => Promise<void>, options: CloudFileToolOptions = {},
) {
  // Snapshot identity rather than retaining a mutable caller-owned authorization object.
  const scope: CloudScope = { siteId: trustedScope.siteId, userId: trustedScope.userId,
    instanceId: trustedScope.instanceId, ...(trustedScope.requirementId ? { requirementId: trustedScope.requirementId } : {}) };
  const validScope = z.object({ siteId: uuid, userId: uuid, instanceId: uuid,
    requirementId: uuid.optional() }).safeParse(trustedScope).success;
  function receipt(revision: CloudRevision): { [key: string]: Json } {
    if (!uuid.safeParse(revision.file_id).success || !version.safeParse(revision.version).success
      || revision.instance_id !== scope.instanceId
      || (scope.requirementId !== undefined && revision.requirement_id !== scope.requirementId)) {
      throw new CloudFileStoreError('unavailable');
    }
    const base = `/api/robots/instance/${scope.instanceId}/cloud-files/${revision.file_id}?version=${revision.version}`;
    return { file_id: revision.file_id, version: revision.version, name: revision.name,
      mime: revision.mime, sha256: revision.sha256, bytes: revision.bytes,
      requirement_id: revision.requirement_id, instance_id: revision.instance_id,
      git_status: revision.git_status, git_commit_sha: revision.git_commit_sha ?? null,
      git_repository: revision.git_repository ?? null, git_ref: revision.git_ref ?? null,
      git_path: revision.git_path ?? null,
      archive_url: `${base}&format=zip`, download_url: `${base}&format=text` };
  }
  const definitions = [
    { name: 'read_cloud_file', schema: readSchema,
      description: 'Read a private cloud document by file_id and optional immutable version. Content is paginated by UTF-16 offset/max_chars (default/max 8000); use next_offset and the returned version until null. A Unicode pair may exceed max_chars=1; offsets must not split pairs. JSON response budgeting may shorten a page. Includes authenticated relative full source-download/ZIP URLs; no sandbox access.' },
    { name: 'list_cloud_files', schema: listSchema,
      description: 'List private cloud documents in this instance. query searches names and content; requirement_id defaults to the bound requirement and cannot override it. offset/limit pagination (default 0/20, maximum 100).' },
    { name: 'write_cloud_file', schema: writeSchema,
      description: 'Save a private UTF-8 document (maximum 262144 bytes). create requires name/content; replace requires file_id/expected_version/content; patch requires file_id/expected_version/changes with exact single-match old_text/new_text edits applied atomically. Only listed text MIME types; default text/plain. Names are basenames, not paths. Requirement binding and operation IDs are host-owned. Returns exact saved version and Git status; pending/failed is not fully delivered. No sandbox or deployment.' },
  ];
  return definitions.map(definition => ({
    name: definition.name, description: definition.description,
    parameters: zodToJsonSchema(definition.schema, { $refStrategy: 'none' }) as Record<string, unknown>,
    async execute(raw: unknown): Promise<CloudToolResult> {
      const active = async () => {
        try { await assertActive(); } catch { throw new InactiveCloudToolError(); }
        await assertToolScreenAccess(definition.name, scope);
      };
      try {
        if (!validScope) return failure('forbidden');
        await active();
        const parsed = definition.schema.safeParse(raw);
        if (!parsed.success) return failure('invalid_input');
        const filter = 'requirement_id' in parsed.data ? parsed.data.requirement_id : undefined;
        if (filter !== undefined && scope.requirementId !== undefined && filter !== scope.requirementId) {
          return failure('forbidden');
        }
        if (definition.name === 'write_cloud_file') {
          if (filter !== undefined && filter !== scope.requirementId) return failure('forbidden');
          if (scope.requirementId && options.allowRequirementWrite !== true) return failure('requirement_owner_required');
        }
        const store = options.store ?? (await import('./store')).createCloudFileStore();
        await active();
        if (definition.name === 'read_cloud_file') {
          const args = readSchema.parse(raw);
          const revision = await store.read(scope, args.file_id, args.version);
          if (!revision) return failure('not_found');
          const offset = args.offset ?? 0;
          const splitsPair = (position: number) => position > 0 && position < revision.content.length
            && /[\ud800-\udbff]/.test(revision.content[position - 1])
            && /[\udc00-\udfff]/.test(revision.content[position]);
          if (offset > revision.content.length || splitsPair(offset)) return failure('invalid_input');
          const metadata = receipt(revision);
          let end = Math.min(revision.content.length, offset + (args.max_chars ?? 8000));
          const output = () => ({ ...metadata, content: revision.content.slice(offset, end), offset,
            total_chars: revision.content.length, next_offset: end < revision.content.length ? end : null });
          // Escaped control characters and multibyte text can overflow the durable
          // receipt budget despite a character cap. Always return an explicit cursor.
          while (Buffer.byteLength(JSON.stringify(output())) > 11000 && end > offset) {
            end = offset + Math.floor((end - offset) / 2);
          }
          // Keep each page independently valid Unicode, and still advance when
          // the caller requests one UTF-16 code unit at a supplementary character.
          if (splitsPair(end)) end += end - offset === 1 ? 1 : -1;
          return { ok: true, output: output() };
        }
        if (definition.name === 'list_cloud_files') {
          const { thought_process: _thought, ...args } = listSchema.parse(raw);
          const result = await store.list(scope, { ...args,
            ...(scope.requirementId ? { requirement_id: scope.requirementId } : {}) });
          const files: { [key: string]: Json }[] = [];
          for (const revision of result.files) {
            if (args.requirement_id && revision.requirement_id !== args.requirement_id) throw new CloudFileStoreError('unavailable');
            const item = receipt(revision);
            if (files.length && Buffer.byteLength(JSON.stringify([...files, item])) > 10000) break;
            files.push(item);
          }
          return { ok: true, output: { files, next_offset: files.length < result.files.length
            ? (args.offset ?? 0) + files.length : result.next_offset } };
        }
        const { requirement_id: _requirement, thought_process: _thought, ...args } = writeSchema.parse(raw);
        const operationId = (options.operationId ?? randomUUID)();
        if (!uuid.safeParse(operationId).success) return failure('invalid_input');
        const saved = await store.write(scope, { ...args, operation_id: operationId });
        const savedReceipt = receipt(saved);
        if (saved.state === 'conflict') return { ok: false,
          error: { code: 'conflict', message: 'Version changed; reread before editing.', effectStarted: false },
          output: { ...savedReceipt, state: 'conflict' } };
        let revision: CloudRevision = saved;
        let gitBlocker: string | undefined;
        // Saving and delivery are different outcomes. The durable pending intent
        // survives publication failure and will be recovered independently.
        if (saved.git_status !== 'committed') {
          try {
            await active();
            revision = await (options.publish ?? publishCloudRevision)(scope, saved, { store, assertActive: active });
          } catch (error) {
            if (error instanceof CloudGitError && error.code === 'repository_uninitialized') gitBlocker = error.code;
            // A publisher can persist a failed/conflict result before throwing.
            // Refresh only under current authorization, without risking another
            // publication or erasing the already acknowledged durable save.
            try {
              await active();
              const current = await store.read(scope, saved.file_id, saved.version);
              if (current && current.file_id === saved.file_id && current.version === saved.version
                && current.sha256 === saved.sha256 && current.name === saved.name
                && current.mime === saved.mime && current.bytes === saved.bytes
                && current.content === saved.content && current.requirement_id === saved.requirement_id) {
                receipt(current);
                revision = current;
              }
            } catch { /* Fixed saved receipt remains safe when refresh is unavailable. */ }
          }
        }
        return { ok: true, output: { ...receipt(revision), state: saved.state, saved: true,
          ...(gitBlocker ? { git_blocker: gitBlocker, git_next_action: 'Initialize the dedicated private Git repository with an initial commit; the saved revision remains pending.' } : {}) } };
      } catch (error) {
        if (error instanceof ToolScreenAccessDenied) return failure('forbidden');
        if (error instanceof ToolScreenAccessUnavailable) return failure('unavailable');
        if (error instanceof CloudFileStoreError) return failure(error.code);
        if (error instanceof InactiveCloudToolError) return failure('inactive');
        return failure('unavailable');
      }
    },
  }));
}