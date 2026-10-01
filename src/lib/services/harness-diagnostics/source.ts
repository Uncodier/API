import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { redactRuntimeSecrets } from '@/app/api/cron/shared/runtime-log-context';
import { HARNESS_SOURCE_ALLOWLIST } from './reference';

export const HARNESS_SOURCE_LIMITS = Object.freeze({
  file_bytes: 128 * 1024,
  response_chars: 16_000,
  line_chars: 2_000,
  read_lines: 200,
  search_matches: 50,
});
const allowedPaths = new Set<string>(HARNESS_SOURCE_ALLOWLIST);
// Exact membership rejects absolute paths, traversal, encodings, globs and env files.
const sourcePath = z.string().max(240).refine(path => allowedPaths.has(path), 'Path not allowlisted');
export const harnessSourceInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'), path: sourcePath,
    start_line: z.number().int().min(1).max(1_000_000).default(1),
    limit: z.number().int().min(1).max(HARNESS_SOURCE_LIMITS.read_lines).default(80),
  }).strict(),
  z.object({
    action: z.literal('search'),
    query: z.string().min(1).max(200).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'Expected a single-line literal'),
    path: sourcePath.optional(),
    limit: z.number().int().min(1).max(HARNESS_SOURCE_LIMITS.search_matches).default(20),
  }).strict(),
]);
export type HarnessSourceInput = z.input<typeof harnessSourceInputSchema>;

function hash(text: string) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function maskSpan(text: string) { return text.replace(/[^\n]+/g, '[REDACTED]'); }

/** Redact BEFORE splitting/paging/searching; preserve original line numbers.
 * Runtime redaction is pure, but logs alone do not cover PEM/source literals.
 * This is defense in depth, not permission to add customer/credential files.
 */
function redactSource(raw: string): string {
  return raw.replace(/\r\n?/g, '\n')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, maskSpan)
    .replace(/\b[\w$]*(?:token|password|passwd|secret|api[_-]?key|service[_-]?(?:role[_-]?)?key|private[_-]?key|authorization|cookie)[\w$]*["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|`(?:\\[\s\S]|[^`\\])*(?:`|$))/gi, maskSpan)
    .split('\n').map(line => redactRuntimeSecrets(line
      .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, '[REDACTED_CONNECTION]@')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sb_secret_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED_KEY]')
      .replace(/\b[\w$]*(?:token|password|passwd|secret|api[_-]?key|service[_-]?(?:role[_-]?)?key|private[_-]?key)[\w$]*["']?[ \t]*[:=][ \t]*[^\n]+/gi, '[REDACTED]'),
    )).join('\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

type SourceError = 'unavailable' | 'unsafe_file' | 'file_too_large' | 'not_text';
type LoadedSource = { ok: true; path: string; lines: string[]; sha256: string } |
  { ok: false; path: string; error: SourceError };

async function loadSource(root: string, path: string): Promise<LoadedSource> {
  const fail = (error: SourceError): LoadedSource => ({ ok: false, path, error });
  try {
    if (!allowedPaths.has(path)) return fail('unsafe_file');
    const absolute = resolve(root, path);
    // Fail closed even for a symlink to another allowlisted file. No recursive index.
    if (await realpath(absolute) !== absolute) return fail('unsafe_file');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || await realpath(absolute) !== absolute) return fail('unsafe_file');
      if (stat.size > HARNESS_SOURCE_LIMITS.file_bytes) return fail('file_too_large');
      // Do not trust stat size alone: cap allocation and reads even if the file grows.
      const buffer = Buffer.alloc(HARNESS_SOURCE_LIMITS.file_bytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > HARNESS_SOURCE_LIMITS.file_bytes) return fail('file_too_large');
      const bytes = buffer.subarray(0, size);
      if (bytes.includes(0)) return fail('not_text');
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return fail('not_text'); }
      const text = redactSource(raw);
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return { ok: true, path, lines, sha256: hash(text) };
    } finally { await handle.close(); }
  } catch {
    // Never expose OS errors (absolute paths, mount layout, credentials, etc.).
    return fail('unavailable');
  }
}

/** Node-only, no routes/DB/sandbox execution. cwd is host-owned project root.
 * Invalid input throws ZodError. Missing traced files return unavailable, never
 * trigger a repository scan/fallback. Search is case-sensitive literal includes.
 * Hashes identify REDACTED content, not original bytes or a deployed DB version.
 */
export async function readHarnessSource(input: unknown) {
  const args = harnessSourceInputSchema.parse(input);
  const metadata = {
    read_only: true,
    build_revision: process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    scope: 'Local/bundled allowlisted source; deployment and database state are not verified.',
    hash_scope: 'sha256 of full redacted UTF-8 source with LF newlines; content_sha256 hashes returned content',
  };
  let root: string;
  try { root = await realpath(resolve(process.cwd())); }
  catch { return { ...metadata, action: args.action, error: 'unavailable' as const }; }

  if (args.action === 'read') {
    const file = await loadSource(root, args.path);
    if (!file.ok) return { ...metadata, action: args.action, path: file.path, error: file.error };
    const page: string[] = [];
    const truncatedLines: number[] = [];
    let chars = 0;
    let cursor = args.start_line - 1;
    while (cursor < file.lines.length && page.length < args.limit) {
      const line = file.lines[cursor].slice(0, HARNESS_SOURCE_LIMITS.line_chars);
      const cost = line.length + (page.length ? 1 : 0);
      if (chars + cost > HARNESS_SOURCE_LIMITS.response_chars) break;
      if (line.length < file.lines[cursor].length) truncatedLines.push(cursor + 1);
      page.push(line);
      chars += cost;
      cursor++;
    }
    const content = page.join('\n');
    return {
      ...metadata, action: args.action, path: file.path, sha256: file.sha256,
      total_lines: file.lines.length, start_line: args.start_line,
      end_line: page.length ? cursor : null,
      next_start_line: cursor < file.lines.length ? cursor + 1 : null,
      truncated_lines: truncatedLines, content, content_sha256: hash(content),
    };
  }

  const index: Array<{ path: string; total_lines: number; sha256: string }> = [];
  const unavailable: Array<{ path: string; error: SourceError }> = [];
  const matches: Array<{ path: string; line: number; content: string; truncated: boolean; sha256: string }> = [];
  let totalMatches = 0;
  let chars = 0;
  // At most allowlist.length * file_bytes inspected; no model-supplied RegExp.
  for (const path of args.path ? [args.path] : HARNESS_SOURCE_ALLOWLIST) {
    const file = await loadSource(root, path);
    if (!file.ok) { unavailable.push({ path, error: file.error }); continue; }
    index.push({ path, total_lines: file.lines.length, sha256: file.sha256 });
    file.lines.forEach((line, offset) => {
      const at = line.indexOf(args.query);
      if (at < 0) return;
      totalMatches++;
      const start = Math.max(0, at - 80);
      const content = line.slice(start, start + HARNESS_SOURCE_LIMITS.line_chars);
      if (matches.length >= args.limit || chars + content.length > HARNESS_SOURCE_LIMITS.response_chars) return;
      chars += content.length;
      matches.push({ path, line: offset + 1, content, truncated: content.length < line.length, sha256: file.sha256 });
    });
  }
  return {
    ...metadata, action: args.action, index, unavailable, matches,
    total_matches: totalMatches, truncated: totalMatches > matches.length,
    pagination: 'Search is bounded; narrow query/path, then read using one-based start_line and next_start_line. Oversized lines are flagged, not returned in full.',
  };
}