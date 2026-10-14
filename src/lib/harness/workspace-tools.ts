import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { HarnessTool, Json, ToolContext, ToolResult, Workspace } from './types';
import { MAX_COMMAND_MS, MAX_COMMAND_OUTPUT, WorkspaceError, workspaceFileOperation, workspacePath } from './workspace';

const path = z.string().min(1).max(4096);
const processId = z.string().min(1).max(250);
const fileRequest = z.object({ path, startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional() }).strict().refine(x => !x.endLine || x.endLine >= (x.startLine ?? 1),
  'endLine must not precede startLine');
const change = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), path, content: z.string().max(16000) }).strict(),
  z.object({ operation: z.literal('replace'), path, oldText: z.string().min(1).max(16000), newText: z.string().max(16000) }).strict(),
]);

function errorResult(error: unknown, effect: HarnessTool['effect'] = 'read'): ToolResult {
  if (error instanceof WorkspaceError) {
    const rejectedBeforeWrite = ['INVALID_PATH', 'PATH_DENIED', 'INVALID_COMMAND', 'INVALID_TIMEOUT', 'INVALID_PROCESS_ID',
      'RUNTIME_ENVIRONMENT_UNAVAILABLE', 'FILE_TOO_LARGE', 'FILE_NOT_FOUND', 'BINARY_FILE', 'PATCH_CONFLICT'].includes(error.code);
    return { ok: false, error: { code: error.code, message: error.message,
    ...(effect === 'write' && error.effectStarted !== false && ['ABORTED', 'COMMAND_FAILED', 'COMMAND_OUTPUT_UNAVAILABLE', 'PROCESS_UNAVAILABLE', 'FILE_OPERATION_FAILED'].includes(error.code)
      ? { ambiguous: true } : {}),
    ...(error.effectStarted !== undefined ? { effectStarted: error.effectStarted } : rejectedBeforeWrite ? { effectStarted: false } : {}) } };
  }
  // Never echo arbitrary validation inputs, SDK requests, command arguments or errors.
  return { ok: false, error: { code: 'WORKSPACE_TOOL_FAILED', message: 'Workspace tool could not complete. No prerequisite or product gate was applied.',
    ...(effect === 'write' ? { ambiguous: true } : {}) } };
}

/** Generic workspace tools: no package manager, app layout, deploy or completion gates. */
export function createWorkspaceTools(workspace: Workspace): HarnessTool[] {
  const active = async (context: ToolContext) => {
    context.signal.throwIfAborted();
    await context.assertActive();
    context.signal.throwIfAborted();
  };
  const tool = <S extends z.ZodTypeAny>(name: string, description: string, effect: HarnessTool['effect'],
    schema: S, execute: (args: z.infer<S>, context: ToolContext) => Promise<Json>): HarnessTool => ({
    name, description, effect,
    parameters: zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>,
    async execute(input, context) {
      const result = schema.safeParse(input);
      if (!result.success) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Arguments do not match the tool JSON schema.', effectStarted: false } };
      let invoked = false;
      try {
        await active(context);
        invoked = true;
        const output = await execute(result.data, context);
        await active(context);
        if (name === 'exec' && output && typeof output === 'object' && !Array.isArray(output) &&
            typeof output.exitCode === 'number' && output.exitCode !== 0) {
          return { ok: false, output, error: { code: 'COMMAND_EXIT_NONZERO', message: 'Command exited with a nonzero status.' } };
        }
        if (name === 'apply_patch' && output && typeof output === 'object' && !Array.isArray(output) && output.complete === false) {
          return { ok: false, output, error: output.error as NonNullable<ToolResult['error']> };
        }
        return { ok: true, output };
      } catch (error) {
        if (!invoked) return { ok: false, error: { code: 'ABORTED', message: 'Workspace tool is no longer active.', effectStarted: false } };
        return errorResult(error, effect);
      }
    },
  });

  const fileOperation = async (input: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> => {
    await active(context);
    const result = await workspaceFileOperation(workspace, input, context.signal);
    await active(context);
    return result;
  };

  const tools = [
    tool('read_files', 'Read UTF-8 workspace files with optional inclusive one-based startLine/endLine. Secret/config paths, symlinks, binary and oversized files are rejected. Total output is bounded.', 'read',
      z.object({ files: z.array(fileRequest).min(1).max(10) }).strict(), async ({ files }, context) => {
        let remaining = MAX_COMMAND_OUTPUT;
        const output: Json[] = [];
        for (const request of files) {
          await active(context);
          workspacePath(request.path, workspace.ref.root);
          try {
            const content = await workspace.readFile(request.path, context.signal);
            await active(context);
            const lines = content.split('\n');
            const selected = lines.slice((request.startLine ?? 1) - 1, request.endLine).join('\n');
            const bounded = selected.slice(0, Math.max(0, remaining));
            remaining -= bounded.length;
            output.push({ path: request.path, content: bounded, totalLines: lines.length, truncated: bounded.length < selected.length });
          } catch (error) {
            await active(context);
            const result = errorResult(error);
            output.push({ path: request.path, error: result.error! });
          }
        }
        return { files: output };
      }),
    tool('list_files', 'List up to 50 workspace entries, skipping secrets, symlinks, .git, node_modules and virtualenvs. Paths are repository-relative; traversal is bounded and may be truncated.', 'read',
      z.object({ path: path.default('.'), recursive: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(50) }).strict(),
      async (args, context) => {
        workspacePath(args.path, workspace.ref.root);
        return await fileOperation({ ...args, op: 'list' }, context) as Json;
      }),
    tool('search', 'Search literal text (NOT regex) in UTF-8 files recursively. Returns up to 50 matches with line numbers and 100-character excerpts; skips secrets, symlinks, binary/large files and dependency directories.', 'read',
      z.object({ query: z.string().min(1).max(1000), path: path.default('.'), caseSensitive: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(50) }).strict(), async (args, context) => {
        workspacePath(args.path, workspace.ref.root);
        return await fileOperation({ ...args, op: 'search' }, context) as Json;
      }),
    tool('apply_patch', 'Apply exact text changes, NOT unified diff/apply_patch syntax. changes[] uses operation:create with content (fails if file exists), or operation:replace with nonempty oldText and newText (oldText must occur exactly once). Each file change uses no-follow file IO; batches run sequentially, are NOT atomic, and stop at first error with applied paths. No deletes/renames.', 'write',
      z.object({ changes: z.array(change).min(1).max(20) }).strict(), async ({ changes }, context): Promise<Json> => {
        // Validate the complete batch before its first side effect.
        for (const item of changes) workspacePath(item.path, workspace.ref.root);
        const applied: string[] = [];
        for (const item of changes) {
          await active(context);
          try {
            await fileOperation(item.operation === 'create'
              ? { op: 'patch', path: item.path, create: true, content: item.content }
              : { op: 'patch', path: item.path, oldText: item.oldText, newText: item.newText }, context);
            applied.push(item.path);
          } catch (error) {
            const failure = errorResult(error, 'write').error!;
            return { applied, complete: false, failedPath: item.path,
              error: { ...failure, ...(applied.length ? { effectStarted: true } : {}) } };
          }
        }
        return { applied, complete: true };
      }),
    tool('exec', 'Run arbitrary bash in the isolated VM for scaffolding, installing dependencies, tests, builds or git. No host shell or inherited host secrets. cwd is confined at launch; shell itself may access VM filesystem. Server-enforced timeout <=120s, bounded output. background returns a workspace-scoped processId. useRuntimeEnvironment explicitly opts into host-authorized application values; never configure platform credentials.', 'write',
      z.object({ command: z.string().min(1).max(64 * 1024), cwd: path.optional(), timeoutMs: z.number().int().min(1).max(MAX_COMMAND_MS).optional(),
        background: z.boolean().optional(), useRuntimeEnvironment: z.boolean().optional() }).strict(),
      async (args, context) => {
        workspacePath(args.cwd ?? '.', workspace.ref.root);
        const output = await workspace.exec(args, context.signal);
        return { ...output };
      }),
    tool('process_status', 'Get bounded process output and exitCode (null while running). IDs are scoped to this workspace; after VM snapshot restore old OS processes may be unavailable, never silently restarted.', 'read',
      z.object({ processId }).strict(), async (args, context) => ({ ...await workspace.processStatus(args.processId, context.signal) })),
    tool('process_stop', 'Stop a process in this workspace with SIGKILL. Does not stop/snapshot the workspace or change session completion status.', 'write',
      z.object({ processId }).strict(), async (args, context) => {
        await workspace.stopProcess(args.processId, context.signal);
        return { stopped: true, processId: args.processId };
      }),
  ];
  const patch = tools.find(tool => tool.name === 'apply_patch');
  if (patch) patch.reconcile = async (args, context) => {
    const parsed = z.object({ changes: z.array(change).min(1).max(20) }).strict().safeParse(args);
    if (!parsed.success) return { state: 'unknown' };
    let allApplied = true;
    let allOriginal = true;
    for (const item of parsed.data.changes) {
      await active(context);
      let content: string;
      try { content = await workspace.readFile(item.path, context.signal); }
      catch (error) {
        if (item.operation === 'create' && error instanceof WorkspaceError && error.code === 'FILE_NOT_FOUND') { allApplied = false; continue; }
        return { state: 'unknown' };
      }
      if (item.operation === 'create') {
        allOriginal = false;
        if (content !== item.content) return { state: 'unknown' };
      } else {
        const matches = (value: string) => value.length ? content.split(value).length - 1 : 0;
        if (matches(item.oldText) === 1 && (!item.newText || matches(item.newText) === 0)) allApplied = false;
        else if (item.newText && matches(item.newText) === 1 && matches(item.oldText) === 0) allOriginal = false;
        else return { state: 'unknown' };
      }
    }
    // Never replay a partially applied batch; the agent can make a new patch for the remainder.
    if (allApplied) return { state: 'applied', proof: 'workspace:exact-target-content', result: { ok: true, output: { reconciled: true } } };
    if (allOriginal) return { state: 'not_applied', proof: 'workspace:exact-original-content' };
    return { state: 'unknown' };
  };
  return tools;
}