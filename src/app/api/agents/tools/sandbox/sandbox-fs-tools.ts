/**
 * Filesystem tools for the Vercel Sandbox (write / read / edit / delete / list / lints).
 * Split from assistantProtocol.ts to keep files under the 500-line rule.
 */
import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  liveSandbox,
  resolvePath,
  normalizeSandboxFsPath,
  deductSandboxToolCredits,
  type SandboxToolsContext,
} from './assistantProtocol';
import {
  getGitPorcelainMap,
  classifyFreshness,
  formatListLine,
  type StructuredListEntry,
} from './sandbox-file-freshness';

import { isMissingPathError } from './sandbox-fs-errors';
import { mergeWriteContent } from './sandbox-fs-write';

const WORK_DIR = SandboxService.WORK_DIR;

export { isMissingPathError } from './sandbox-fs-errors';
export { mergeWriteContent } from './sandbox-fs-write';

export function sandboxWriteFileTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_write_file',
    description: 'Write a file in the Vercel Sandbox filesystem. Use mode=append to add to an existing research doc instead of overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `File path relative to ${WORK_DIR} (e.g. "src/app/foo/page.tsx") or absolute. Use src/app/ for routes — do NOT use a top-level app/ folder; the tool will remap mistaken app/ paths to src/app/.`,
        },
        content: { type: 'string', description: 'Content to write to the file' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'overwrite (default) replaces the file. append concatenates content onto the existing file — use this for research verticals.',
        },
      },
      required: ['path', 'content']
    },
    execute: async (args: { path: string, content: string, mode?: string }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_write_file', { path: args.path });
      if (!creditCheck.success) {
        return { success: false, error: creditCheck.error };
      }

      let resolved = resolvePath(args.path, WORK_DIR);
      resolved = normalizeSandboxFsPath(WORK_DIR, resolved);

      const s0 = liveSandbox(sandbox, toolsCtx);
      const parentDir = resolved.includes('/')
        ? resolved.slice(0, resolved.lastIndexOf('/'))
        : WORK_DIR;
      if (parentDir) {
        await s0.fs.mkdir(parentDir, { recursive: true });
      }
      let existing: string | null = null;
      if (String(args.mode || '').toLowerCase() === 'append') {
        try {
          existing = await s0.fs.readFile(resolved, 'utf8');
        } catch {
          existing = null;
        }
      }
      const content = mergeWriteContent(existing, args.content, args.mode);
      await s0.writeFiles([{ path: resolved, content }]);
      return {
        success: true,
        path: resolved,
        mode: String(args.mode || '').toLowerCase() === 'append' ? 'append' : 'overwrite',
      };
    }
  };
}

export function sandboxReadLargeFileTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_read_large_file',
    description: 'Read the contents of a very large file from the Vercel Sandbox filesystem with pagination (by line numbers) to avoid crashing the context. Useful for large logs, error outputs, or massive code files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Absolute path to the file, e.g. ${WORK_DIR}/error.log` },
        start_line: { type: 'number', description: 'The 1-based line number to start reading from (inclusive).' },
        limit_lines: { type: 'number', description: 'Maximum number of lines to return. Default is 500. Keep it reasonable (e.g. 200-1000) to avoid context bloat.' }
      },
      required: ['path', 'start_line']
    },
    execute: async (args: { path: string, start_line: number, limit_lines?: number }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_read_large_file', args);
      if (!creditCheck.success) {
        throw new Error(creditCheck.error);
      }

      const resolved = normalizeSandboxFsPath(WORK_DIR, resolvePath(args.path, WORK_DIR));
      const s0 = liveSandbox(sandbox, toolsCtx);
      try {
        const content = await s0.fs.readFile(resolved, 'utf8');
        const lines = content.split('\n');
        const totalLines = lines.length;
        
        const start = Math.max(1, args.start_line) - 1; // 0-indexed
        const limit = args.limit_lines && args.limit_lines > 0 ? args.limit_lines : 500;
        const end = Math.min(start + limit, totalLines);
        
        const slicedLines = lines.slice(start, end);
        // Prepend line numbers so the agent knows where they are
        const paginatedContent = slicedLines.map((line, idx) => `${start + idx + 1} | ${line}`).join('\n');
        
        return { 
          file_path: resolved,
          total_lines: totalLines,
          showing_lines: `${start + 1} to ${end}`,
          has_more: end < totalLines,
          content: paginatedContent 
        };
      } catch (e: unknown) {
        if (isMissingPathError(e)) {
          return {
            exists: false,
            file_path: resolved,
            content: '',
            hint: 'File does not exist yet. Create it with sandbox_write_file.',
          };
        }
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to read large file: ${msg}`);
      }
    }
  };
}

export function sandboxReadFileTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_read_file',
    description: 'Read a file from the Vercel Sandbox. Missing files return exists=false (not an error) — create them with sandbox_write_file. If updated_this_cycle is false, the file was not modified since this step started.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Absolute path to the file, e.g. ${WORK_DIR}/package.json` }
      },
      required: ['path']
    },
    execute: async (args: { path: string }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_read_file', args);
      if (!creditCheck.success) {
        throw new Error(creditCheck.error);
      }

      const resolved = normalizeSandboxFsPath(WORK_DIR, resolvePath(args.path, WORK_DIR));
      const s0 = liveSandbox(sandbox, toolsCtx);
      try {
        const content = await s0.fs.readFile(resolved, 'utf8');
        
        let mtime: string | null = null;
        let updated_this_cycle: boolean | null = null;
        let git_status: string | null = null;
        
        try {
          const stats = await s0.fs.stat(resolved);
          if (stats?.mtime) {
            mtime = stats.mtime.toISOString();
            updated_this_cycle = classifyFreshness(mtime, toolsCtx?.cycle_baseline_at);
          }
        } catch (e) {
          // ignore stat errors
        }
        
        try {
          const porcelain = await getGitPorcelainMap(s0, WORK_DIR);
          const relPath = resolved.startsWith(WORK_DIR + '/') ? resolved.substring(WORK_DIR.length + 1) : resolved;
          git_status = porcelain[relPath] || null;
        } catch (e) {
          // ignore porcelain errors
        }
        
        return { success: true, exists: true, content, path: resolved, mtime, updated_this_cycle, git_status };
      } catch (e: unknown) {
        if (isMissingPathError(e)) {
          return {
            success: true,
            exists: false,
            content: '',
            path: resolved,
            hint: 'File does not exist yet. Create parent dirs automatically via sandbox_write_file.',
          };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: `Failed to read file: ${msg}` };
      }
    }
  };
}

export function sandboxEditFileTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_edit_file',
    description: 'Performs exact string replacements in a file in the Vercel Sandbox filesystem. Use this instead of sandbox_write_file to edit parts of large files without overwriting the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `File path relative to ${WORK_DIR} (e.g. "src/app/foo/page.tsx") or absolute.`,
        },
        old_string: { type: 'string', description: 'The exact text to replace. Must be unique in the file.' },
        new_string: { type: 'string', description: 'The text to replace it with.' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    execute: async (args: { path: string, old_string: string, new_string: string }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_edit_file', { path: args.path });
      if (!creditCheck.success) {
        return { success: false, error: creditCheck.error };
      }

      let resolved = resolvePath(args.path, WORK_DIR);
      resolved = normalizeSandboxFsPath(WORK_DIR, resolved);
      const s0 = liveSandbox(sandbox, toolsCtx);

      try {
        const content = await s0.fs.readFile(resolved, 'utf8');
        
        if (!content.includes(args.old_string)) {
          return { 
            success: false, 
            error: 'old_string not found in file. Make sure you provided the exact text including whitespace and indentation.' 
          };
        }

        const occurrences = content.split(args.old_string).length - 1;
        if (occurrences > 1) {
          return {
            success: false,
            error: `old_string is not unique (found ${occurrences} times). Please provide a larger string with more surrounding context.`
          };
        }

        const newContent = content.replace(args.old_string, args.new_string);
        await s0.writeFiles([{ path: resolved, content: newContent }]);
        
        return { success: true, path: resolved };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to edit file: ${msg}`);
      }
    }
  };
}

export function sandboxDeleteFileTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_delete_file',
    description: 'Deletes a file or directory in the Vercel Sandbox filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `File or directory path relative to ${WORK_DIR} (e.g. "src/app/foo/page.tsx") or absolute.`,
        }
      },
      required: ['path']
    },
    execute: async (args: { path: string }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_delete_file', args);
      if (!creditCheck.success) {
        throw new Error(creditCheck.error);
      }

      let resolved = resolvePath(args.path, WORK_DIR);
      resolved = normalizeSandboxFsPath(WORK_DIR, resolved);
      const s0 = liveSandbox(sandbox, toolsCtx);

      try {
        const result = await s0.runCommand('rm', ['-rf', resolved]);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to delete: ${await result.stderr()}`);
        }
        return { success: true, path: resolved };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to delete file: ${msg}`);
      }
    }
  };
}

export function sandboxReadLintsTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_read_lints',
    description: 'Read and display linter and TypeScript errors from the Vercel Sandbox workspace. Use this to quickly verify your changes without waiting for a full build.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of file paths to check. If empty, checks the entire workspace.',
        }
      }
    },
    execute: async (args: { paths?: string[] }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_read_lints', args);
      if (!creditCheck.success) {
        throw new Error(creditCheck.error);
      }

      try {
        const s0 = liveSandbox(sandbox, toolsCtx);
        const pathsArg = (args.paths && args.paths.length > 0) ? args.paths.join(' ') : '';
        
        // Run tsc for TypeScript errors (no file emission)
        const tscCmd = `npx tsc --noEmit ${pathsArg}`;
        const tscResult = await s0.runCommand('sh', ['-c', `cd ${WORK_DIR} && ${tscCmd}`]);
        const tscOutput = await tscResult.stdout();
        const tscError = await tscResult.stderr();
        
        const eslintCmd = `npx eslint ${pathsArg || '.'} --format stylish`;
        const eslintResult = await s0.runCommand('sh', ['-c', `cd ${WORK_DIR} && ${eslintCmd}`]);
        const eslintOutput = await eslintResult.stdout();
        const eslintError = await eslintResult.stderr();

        const combinedOutput = [
          '--- TypeScript Diagnostics ---',
          tscOutput.trim() || tscError.trim() || 'No TypeScript errors.',
          '',
          '--- ESLint Diagnostics ---',
          eslintOutput.trim() || eslintError.trim() || 'No ESLint errors.'
        ].join('\n');

        return { 
          success: tscResult.exitCode === 0 && eslintResult.exitCode === 0,
          diagnostics: combinedOutput 
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to read lints: ${msg}`);
      }
    }
  };
}

export function sandboxListFilesTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_list_files',
    description: 'List files in a sandbox directory. A missing directory returns exists=false and an empty list (not an error). Files are tagged with updated_this_cycle.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Absolute path to the directory, defaults to ${WORK_DIR}` }
      }
    },
    execute: async (args: { path?: string }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_list_files', args);
      if (!creditCheck.success) {
        throw new Error(creditCheck.error);
      }

      const dir = normalizeSandboxFsPath(WORK_DIR, resolvePath(args.path, WORK_DIR));
      const s0 = liveSandbox(sandbox, toolsCtx);
      
      let entries: StructuredListEntry[] = [];
      let filesString = '';
      
      try {
        const porcelain = await getGitPorcelainMap(s0, WORK_DIR);
        const lsResult = await s0.fs.readdir(dir, { withFileTypes: true });
        
        const SKIP_NAMES = new Set(['.git', 'node_modules', '.next']);
        for (const item of lsResult) {
          if (SKIP_NAMES.has(item.name)) continue;

          const itemPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`.replace(/\/+/g, '/');
          const relPath = itemPath.startsWith(WORK_DIR + '/') ? itemPath.substring(WORK_DIR.length + 1) : itemPath;
          
          let mtime: string | null = null;
          let size = 0;
          try {
            const stats = await s0.fs.stat(itemPath);
            mtime = stats?.mtime?.toISOString() || null;
            size = stats?.size || 0;
          } catch(e) {}
          
          let type: 'file'|'dir'|'symlink'|'other' = 'other';
          if (item.isDirectory()) type = 'dir';
          else if (item.isFile()) type = 'file';
          else if (item.isSymbolicLink()) type = 'symlink';
          
          const updated_this_cycle = classifyFreshness(mtime, toolsCtx?.cycle_baseline_at);
          const git_status = porcelain[relPath] || null;
          
          entries.push({
            name: item.name,
            type,
            size,
            mtime,
            updated_this_cycle,
            git_status
          });
        }
        
        filesString = entries.map(formatListLine).join('\n');
      } catch (e) {
        if (isMissingPathError(e)) {
          return {
            success: true,
            exists: false,
            files: '',
            entries: [],
            path: dir,
            hint: 'Directory does not exist yet. sandbox_write_file creates parent folders.',
          };
        }
        const result = await s0.runCommand('ls', ['-la', dir]);
        const stderr = await result.stderr();
        if (result.exitCode !== 0) {
          if (isMissingPathError(stderr)) {
            return {
              success: true,
              exists: false,
              files: '',
              entries: [],
              path: dir,
              hint: 'Directory does not exist yet. sandbox_write_file creates parent folders.',
            };
          }
          return { success: false, error: `Failed to list files: ${stderr}`, path: dir };
        }
        filesString = await result.stdout();
      }
      
      return { success: true, exists: true, files: filesString, entries: entries.length > 0 ? entries : undefined, path: dir };
    }
  };
}
