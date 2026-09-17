'use step';

import type { Sandbox } from '@vercel/sandbox';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import {
  HARNESS_TRACKING_BACKUP_PATH,
  transformHarnessTrackingScript,
} from './tracking-script-contract';

export interface ProvisionTrackingScriptStepInput {
  sandboxId: string;
  siteId: string;
  audit?: CronAuditContext;
}

async function readSandboxFile(sandbox: Sandbox, path: string): Promise<string> {
  const result = await sandbox.runCommand({
    cmd: 'node',
    args: [
      '-e',
      "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
      path,
    ],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not read ${path}: ${await result.stderr()}`);
  }
  return result.stdout();
}

async function validateLayoutSyntax(
  sandbox: Sandbox,
  path: string,
  cwd: string,
): Promise<string | null> {
  const result = await sandbox.runCommand({
    cmd: 'node',
    cwd,
    args: [
      '-e',
      [
        "const fs=require('fs');",
        "const ts=require('typescript');",
        'const path=process.argv[1];',
        "const kind=/\\.tsx$/i.test(path)?ts.ScriptKind.TSX:ts.ScriptKind.JSX;",
        "const sf=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,kind);",
        "const errors=(sf.parseDiagnostics||[]).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '));",
        "if(errors.length){console.error(errors.join('\\n'));process.exit(1);}",
      ].join(''),
      path,
    ],
  });
  if (result.exitCode === 0) return null;
  const stderr = await result.stderr().catch(() => '');
  return stderr.trim() || 'TypeScript could not parse the transformed layout';
}

/**
 * Injects the Makinari tracking script into the root layout of the application
 * by replacing the closing </body> tag.
 */
export async function provisionTrackingScriptStep(
  input: ProvisionTrackingScriptStepInput,
): Promise<{ injected: boolean; error?: string }> {
  'use step';
  const { sandboxId, siteId, audit } = input;

  let sandbox: Sandbox;
  try {
    sandbox = await getSandboxHandle(sandboxId);
  } catch (e: unknown) {
    console.warn(
      `[TrackingScript] Sandbox ${sandboxId} unavailable (${e instanceof Error ? e.message : e}); skipping.`,
    );
    return { injected: false, error: 'sandbox unavailable' };
  }

  const cwd = SandboxService.WORK_DIR;

  try {
    const checkRes = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `cd "${cwd}" && (test -f src/app/layout.tsx && echo "src/app/layout.tsx" || (test -f src/app/layout.jsx && echo "src/app/layout.jsx" || echo "MISSING"))`,
      ],
    });
    
    const layoutPath = (await checkRes.stdout()).toString().trim();
    
    if (layoutPath === 'MISSING') {
      console.log('[TrackingScript] No root layout found; skipping tracking script injection.');
      return { injected: false };
    }

    const absoluteLayoutPath = `${cwd}/${layoutPath}`;
    await sandbox.fs.rm(HARNESS_TRACKING_BACKUP_PATH, { force: true });
    const source = await readSandboxFile(sandbox, absoluteLayoutPath);
    const transformed = transformHarnessTrackingScript(source, siteId);
    if (!transformed.changed) {
      console.log(
        `[TrackingScript] Tracking script unchanged (${transformed.reason}).`,
      );
      return { injected: false };
    }

    try {
      await sandbox.writeFiles([
        {
          path: HARNESS_TRACKING_BACKUP_PATH,
          content: JSON.stringify({
            path: absoluteLayoutPath,
            originalSource: source,
            transformedSource: transformed.source,
            reason: transformed.reason,
            siteId,
          }),
        },
        { path: absoluteLayoutPath, content: transformed.source },
      ]);
      const syntaxError = await validateLayoutSyntax(
        sandbox,
        absoluteLayoutPath,
        cwd,
      );
      if (syntaxError) throw new Error(syntaxError);
    } catch (transformError: unknown) {
      await sandbox.writeFiles([{ path: absoluteLayoutPath, content: source }]);
      await sandbox.fs.rm(HARNESS_TRACKING_BACKUP_PATH, { force: true });
      const message = transformError instanceof Error
        ? transformError.message
        : String(transformError);
      console.warn(`[TrackingScript] Rolled back invalid layout transform: ${message}`);
      return {
        injected: false,
        error: `tracking transform rolled back: ${message}`,
      };
    }

    console.log(
      `[TrackingScript] ${transformed.reason} tracking script in ${layoutPath}`,
    );

    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GIT_WORKSPACE_READY,
      level: 'info',
      message: `${transformed.reason} tracking script for site ${siteId} in ${layoutPath}`,
      details: {
        sandboxId,
        siteId,
        layoutPath,
        transform_reason: transformed.reason,
      },
    });

    return { injected: true };
  } catch (e: unknown) {
    console.warn(
      `[TrackingScript] Error injecting tracking script:`,
      e instanceof Error ? e.message : e,
    );
    return { injected: false, error: e instanceof Error ? e.message : String(e) };
  }
}
