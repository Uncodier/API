import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  deductSandboxToolCredits,
  liveSandbox,
  normalizeSandboxFsPath,
  resolvePath,
  type SandboxToolsContext,
} from './assistantProtocol';
import {
  classifyFreshness,
  getGitPorcelainMap,
} from './sandbox-file-freshness';
import { isMissingPathError } from './sandbox-fs-errors';

const WORK_DIR = SandboxService.WORK_DIR;
const MAX_FILES = 12;
const DEFAULT_MAX_CHARS_PER_FILE = 12_000;
const MAX_CHARS_PER_FILE = 30_000;
const MAX_TOTAL_CONTENT_CHARS = 60_000;

function truncateContent(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  if (maxChars <= 0) {
    return { content: '', truncated: content.length > 0 };
  }
  const suffix = '\n…(truncated)';
  if (suffix.length >= maxChars) {
    return {
      content: content.slice(0, maxChars),
      truncated: true,
    };
  }
  return {
    content:
      `${content.slice(0, maxChars - suffix.length)}${suffix}`,
    truncated: true,
  };
}

export function sandboxReadFilesTool(
  sandbox: Sandbox,
  toolsCtx?: SandboxToolsContext,
) {
  return {
    name: 'sandbox_read_files',
    description:
      'Read up to 12 related text files in one call, capped at 60,000 content characters total. Prefer this over repeated sandbox_read_file calls when gathering context. Results preserve input order and report missing files without failing the batch.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_FILES,
          description: `File paths relative to ${WORK_DIR} or absolute paths.`,
        },
        max_chars_per_file: {
          type: 'number',
          minimum: 1_000,
          maximum: MAX_CHARS_PER_FILE,
          description:
            `Maximum characters returned per file (default ${DEFAULT_MAX_CHARS_PER_FILE}).`,
        },
      },
      required: ['paths'],
    },
    execute: async (args: {
      paths: string[];
      max_chars_per_file?: number;
    }) => {
      const uniquePaths = Array.from(new Set(
        Array.isArray(args.paths)
          ? args.paths.filter((path): path is string =>
              typeof path === 'string' && path.trim().length > 0
            )
          : [],
      )).slice(0, MAX_FILES);
      if (uniquePaths.length === 0) {
        return {
          success: false,
          error: 'paths must contain at least one file path.',
        };
      }
      const creditCheck = await deductSandboxToolCredits(
        toolsCtx,
        'sandbox_read_files',
        { paths: uniquePaths },
      );
      if (!creditCheck.success) {
        return { success: false, error: creditCheck.error };
      }

      const limit = Math.min(
        Math.max(
          Number(args.max_chars_per_file) || DEFAULT_MAX_CHARS_PER_FILE,
          1_000,
        ),
        MAX_CHARS_PER_FILE,
      );
      const activeSandbox = liveSandbox(sandbox, toolsCtx);
      const porcelain: Record<string, string> = await getGitPorcelainMap(
        activeSandbox,
        WORK_DIR,
      ).catch(() => ({} as Record<string, string>));
      const files = await Promise.all(uniquePaths.map(async (path) => {
        const resolved = normalizeSandboxFsPath(
          WORK_DIR,
          resolvePath(path, WORK_DIR),
        );
        try {
          const [content, stats] = await Promise.all([
            activeSandbox.fs.readFile(resolved, 'utf8'),
            activeSandbox.fs.stat(resolved).catch(() => null),
          ]);
          const relativePath = resolved.startsWith(`${WORK_DIR}/`)
            ? resolved.slice(WORK_DIR.length + 1)
            : resolved;
          const limited = truncateContent(content, limit);
          return {
            path: resolved,
            exists: true,
            content: limited.content,
            truncated: limited.truncated,
            mtime: stats?.mtime?.toISOString() || null,
            updated_this_cycle: classifyFreshness(
              stats?.mtime?.toISOString() || null,
              toolsCtx?.cycle_baseline_at,
            ),
            git_status: porcelain[relativePath] || null,
          };
        } catch (error: unknown) {
          if (isMissingPathError(error)) {
            return {
              path: resolved,
              exists: false,
              content: '',
              truncated: false,
              mtime: null,
              updated_this_cycle: null,
              git_status: null,
            };
          }
          return {
            path: resolved,
            exists: false,
            content: '',
            truncated: false,
            error:
              error instanceof Error ? error.message : String(error),
          };
        }
      }));
      let remainingContentChars = MAX_TOTAL_CONTENT_CHARS;
      const boundedFiles = files.map((file) => {
        const limited = truncateContent(
          file.content,
          remainingContentChars,
        );
        remainingContentChars -= limited.content.length;
        return {
          ...file,
          content: limited.content,
          truncated: file.truncated || limited.truncated,
        };
      });

      return {
        success: boundedFiles.every((file) => !('error' in file)),
        files: boundedFiles,
        total_content_chars:
          MAX_TOTAL_CONTENT_CHARS - remainingContentChars,
        max_total_content_chars: MAX_TOTAL_CONTENT_CHARS,
      };
    },
  };
}
