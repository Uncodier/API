'use step';

import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  logCronInfrastructureEvent,
  CronInfraEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { processDocsDigest, type RawDocFile } from '@/lib/services/docs-cycle-digest';
// Import from lib/tools — not instance_logs/route — so the workflow bundler
// does not pull next/server (__dirname is not defined).
import { createInstanceLogCore } from '@/lib/tools/instance-log-core';

/** Slim result for workflow serialization — full bodies live in instance_logs. */
export interface DocsDigestResult {
  emitted: boolean;
  fileCount: number;
  totalBytes: number;
}

/** Max bytes read per file from the sandbox before summarization. */
const RAW_READ_CAP_BYTES = 256 * 1024;

export async function emitDocsDigestStep(params: {
  sandboxId: string;
  siteId: string;
  instanceId: string;
  userId?: string;
  requirementId: string;
  audit?: CronAuditContext;
}): Promise<DocsDigestResult | null> {
  'use step';
  const { sandboxId, siteId, instanceId, userId, requirementId, audit } = params;
  const cwd = SandboxService.WORK_DIR;

  try {
    const liveSandbox = await getSandboxHandle(sandboxId);

    // Newest-first so we keep the latest deliverables when docs/ has many files.
    const findScript = `
cd "${cwd}" || exit 0
find docs -type f \\( -name '*.md' -o -name '*.mdx' -o -name '*.json' -o -name '*.csv' \\) 2>/dev/null | while IFS= read -r f; do
  ts=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
  printf '%s\\t%s\\n' "$ts" "$f"
done | sort -nr | head -40 | cut -f2-
`;

    const findRes = await liveSandbox.runCommand({
      cmd: 'sh',
      args: ['-c', findScript],
    });

    const findStdout = await findRes.stdout();
    const filePaths = findStdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (filePaths.length === 0) {
      console.log(`[DocsDigestStep] No matching docs found for ${requirementId}`);
      return null;
    }

    const rawFiles: RawDocFile[] = [];

    for (const path of filePaths) {
      const catRes = await liveSandbox.runCommand({
        cmd: 'sh',
        args: [
          '-c',
          `cd "${cwd}" && head -c ${RAW_READ_CAP_BYTES} -- "${path}" 2>/dev/null`,
        ],
      });
      let content = await catRes.stdout();

      const metaRes = await liveSandbox.runCommand({
        cmd: 'sh',
        args: [
          '-c',
          `cd "${cwd}" && echo "$(stat -c %Y "${path}" 2>/dev/null || stat -f %m "${path}" 2>/dev/null || echo 0) $(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"`,
        ],
      });
      const metaParts = (await metaRes.stdout()).trim().split(/\s+/);
      const mtime = parseInt(metaParts[0] || '0', 10) || 0;
      const sizeBytes = parseInt(metaParts[1] || '0', 10) || 0;

      if (sizeBytes > RAW_READ_CAP_BYTES) {
        content = `${content}\n\n... [raw read capped at ${RAW_READ_CAP_BYTES} of ${sizeBytes} bytes] ...\n`;
      }

      rawFiles.push({ path, content, mtime });
    }

    const digestedFiles = processDocsDigest(rawFiles);
    if (digestedFiles.length === 0) return null;

    const totalBytes = digestedFiles.reduce((acc, f) => acc + f.bytes, 0);
    const fileListStr = digestedFiles.map((f) => f.path).join(', ');
    const summaryMsg = `Cycle docs digest (${digestedFiles.length} files): ${fileListStr}`;

    await createInstanceLogCore({
      site_id: siteId,
      instance_id: instanceId,
      user_id: userId,
      log_type: 'agent_action',
      level: 'info',
      message: summaryMsg,
      details: {
        kind: 'cycle_docs_digest',
        requirement_id: requirementId,
        files: digestedFiles,
        generated_at: new Date().toISOString(),
      },
    });

    console.log(
      `[DocsDigestStep] Emitted digest log with ${digestedFiles.length} files (${totalBytes} bytes)`,
    );

    return { emitted: true, fileCount: digestedFiles.length, totalBytes };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[DocsDigestStep] Failed to emit digest for ${requirementId}:`, error);
    try {
      await logCronInfrastructureEvent(audit ?? { instanceId, siteId, requirementId }, {
        event: CronInfraEvent.FINAL_STATUS,
        level: 'warn',
        message: `Docs digest step failed: ${message}`,
        details: { phase: 'docs_digest', error: message },
      });
    } catch {
      // non-fatal
    }
    return null;
  }
}
