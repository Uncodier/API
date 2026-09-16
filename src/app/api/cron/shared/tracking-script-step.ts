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
  buildHarnessTrackingScriptTag,
  buildLegacyTrackingScriptTag,
  HARNESS_TRACKING_SCRIPT_URL,
} from './tracking-script-contract';

export interface ProvisionTrackingScriptStepInput {
  sandboxId: string;
  siteId: string;
  audit?: CronAuditContext;
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

    // Check if it's already injected
    const hasScriptRes = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `grep -q '${HARNESS_TRACKING_SCRIPT_URL}' "${cwd}/${layoutPath}" && echo "YES" || echo "NO"`,
      ],
    });
    const hasScript = (await hasScriptRes.stdout()).toString().trim();
    
    if (hasScript === 'YES') {
      const legacyTag = buildLegacyTrackingScriptTag(siteId);
      const markedTag = buildHarnessTrackingScriptTag(siteId);
      const upgradeRes = await sandbox.runCommand({
        cmd: 'node',
        args: [
          '-e',
          [
            "const fs=require('fs');",
            'const [path, legacyTag, markedTag] = process.argv.slice(1);',
            "const source=fs.readFileSync(path,'utf8');",
            "if(source.includes(markedTag)){process.stdout.write('MARKED');process.exit(0);}",
            "if(!source.includes(legacyTag)){process.stdout.write('UNOWNED');process.exit(0);}",
            "fs.writeFileSync(path,source.replace(legacyTag,markedTag));",
            "process.stdout.write('UPDATED');",
          ].join(''),
          `${cwd}/${layoutPath}`,
          legacyTag,
          markedTag,
        ],
      });
      const upgradeStatus = (await upgradeRes.stdout()).trim();
      if (upgradeRes.exitCode === 0 && upgradeStatus === 'UPDATED') {
        console.log('[TrackingScript] Added harness ownership marker to legacy injection.');
        return { injected: true };
      }
      console.log('[TrackingScript] Tracking script already present; skipping.');
      return { injected: false };
    }

    // Inject the script
    const scriptTag = buildHarnessTrackingScriptTag(siteId);
    // Note: use sed without -i '' because Linux (Vercel Sandbox) sed -i behaves differently than macOS sed -i ''
    // A safer portable way is to write to a temp file and mv it back
    const injectRes = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `sed "s|</body>|${scriptTag}</body>|g" "${cwd}/${layoutPath}" > /tmp/layout_tmp && mv /tmp/layout_tmp "${cwd}/${layoutPath}"`,
      ],
    });

    if (injectRes.exitCode !== 0) {
      console.warn('[TrackingScript] Failed to inject script:', await injectRes.stderr());
      return { injected: false, error: 'injection failed' };
    }

    console.log(`[TrackingScript] Injected tracking script into ${layoutPath}`);

    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.GIT_WORKSPACE_READY,
      level: 'info',
      message: `Injected tracking script for site ${siteId} into ${layoutPath}`,
      details: {
        sandboxId,
        siteId,
        layoutPath,
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
