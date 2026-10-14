import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { z } from 'zod';
import { workspacePath } from './workspace';
import { sourceExportRisk } from './export-policy';
import type { HarnessTool, ToolResult, Workspace } from './types';

interface ArchiveDependencies {
  upload(path: string, bytes: Uint8Array): Promise<void>;
}

const defaults: ArchiveDependencies = {
  async upload(path, bytes) {
    const { resolveSourceArchiveStorageConfig } = await import('@/app/api/agents/tools/sandbox/sandbox-source-upload');
    const config = resolveSourceArchiveStorageConfig();
    if (!config) throw new Error('Archive storage is not configured');
    const { createClient } = await import('@supabase/supabase-js');
    const storage = createClient(config.url, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }).storage;
    const bucket = await storage.getBucket(config.bucket);
    if (bucket.error || !bucket.data || bucket.data.public) throw new Error('An existing private archive bucket is required');
    const result = await storage.from(config.bucket).upload(path, bytes, { contentType: 'application/zip', upsert: true });
    if (result.error) throw new Error('Archive upload failed');
  },
};

/** Text-source export; unlike the legacy tar, never blindly archives dotenv/credential files. */
export function createArchiveTool(options: { workspace: Workspace; allowed: string[]; siteId: string;
  redact: (text: string) => string }, dependencies: ArchiveDependencies = defaults): HarnessTool[] {
  if (!options.allowed.includes('source_archive')) return [];
  return [{ name: 'source_archive', effect: 'write',
    description: 'Export readable UTF-8 tracked/untracked source to private host storage without build/push gates. Skips credentials, symlinks, binaries, dependencies and sensitive content. Bounded to 1000 paths and 10MiB. Returns a receipt and exclusions, not a complete binary backup or public URL.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, context): Promise<ToolResult> {
      if (!z.object({}).strict().safeParse(args).success) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'No archive arguments accepted.' } };
      await context.assertActive();
      const list = await options.workspace.exec({ command: 'git ls-files --cached --others --exclude-standard -z', timeoutMs: 10000 }, context.signal);
      if (list.exitCode !== 0 || list.truncated) return { ok: false, error: { code: 'ARCHIVE_SOURCE_UNAVAILABLE', message: 'Cannot obtain a complete bounded source file list.' } };
      const paths = [...new Set(list.stdout.split('\0').filter(Boolean))].sort();
      if (paths.length > 1000) return { ok: false, error: { code: 'ARCHIVE_TOO_LARGE', message: 'Source export supports at most 1000 paths. Prepare a targeted archive instead.' } };
      const zip = new JSZip();
      const skipped: string[] = [];
      let bytes = 0; let files = 0;
      for (const path of paths) {
        context.signal.throwIfAborted();
        await context.assertActive();
        if (/(?:^|\/)(?:node_modules|\.next|\.venv|venv|dist|build|coverage)(?:\/|$)/.test(path)) { skipped.push(path); continue; }
        try {
          workspacePath(path, options.workspace.ref.root);
          const content = await options.workspace.readFile(path, context.signal);
          // readFile itself redacts known values; don't export a redacted source as if original.
          if (sourceExportRisk(path, content, options.redact)) {
            skipped.push(path); continue;
          }
          bytes += Buffer.byteLength(content);
          if (bytes > 10 * 1024 * 1024) return { ok: false, error: { code: 'ARCHIVE_TOO_LARGE', message: 'Readable source exceeds 10MiB; nothing uploaded.' } };
          zip.file(path, content, { date: new Date('2000-01-01T00:00:00Z') }); files++;
        } catch { skipped.push(path); }
      }
      if (!files) return { ok: false, error: { code: 'ARCHIVE_EMPTY', message: 'No exportable UTF-8 source files.' } };
      const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      const sha = createHash('sha256').update(output).digest('hex');
      const storagePath = `harness/${options.siteId}/${context.sessionId}/${sha}.zip`;
      await context.assertActive();
      try { await dependencies.upload(storagePath, output); }
      catch { return { ok: false, error: { code: 'ARCHIVE_UPLOAD_UNAVAILABLE', ambiguous: true,
        message: 'Upload is unavailable or its result is unknown. Inspect the private storage receipt before repeating.' }, output: { storagePath, sha256: sha } }; }
      return { ok: true, output: { storagePath, sha256: sha, files, bytes: output.length,
        skipped: skipped.slice(0, 100), skippedCount: skipped.length, completeBinaryBackup: false } };
    },
  }];
}