import type { Sandbox } from '@vercel/sandbox';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  HARNESS_TRACKING_BACKUP_PATH,
  rollbackHarnessTrackingScript,
  type HarnessTrackingBackup,
} from '../tracking-script-contract';

const BUILD_OUTPUT_MAX = 6_000;
const PRE_PUSH_BUILD_MARKER = '/tmp/makinari-pre-push-build-ok';
const WORKSPACE_FINGERPRINT_SCRIPT = [
  "const fs=require('fs');",
  "const path=require('path');",
  "const crypto=require('crypto');",
  'const root=process.argv[1];',
  "const ignored=new Set(['.git','.next','node_modules','.vercel','coverage']);",
  'const files=[];',
  'function walk(dir,relative){',
  'for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){',
  'if(ignored.has(entry.name))continue;',
  'const nextRelative=relative?relative+path.sep+entry.name:entry.name;',
  'const absolute=path.join(dir,entry.name);',
  'if(entry.isDirectory())walk(absolute,nextRelative);',
  'else if(entry.isFile()||entry.isSymbolicLink())files.push([absolute,nextRelative]);',
  '}}',
  'walk(root,"");',
  "const hash=crypto.createHash('sha256');",
  'for(const [absolute,relative] of files){',
  "hash.update(relative);hash.update('\\0');",
  'const stat=fs.lstatSync(absolute);hash.update(String(stat.mode));',
  "hash.update('\\0');",
  "hash.update(stat.isSymbolicLink()?fs.readlinkSync(absolute):fs.readFileSync(absolute));",
  "hash.update('\\0');",
  '}',
  'process.stdout.write(hash.digest("hex"));',
].join('');

export type ApplicationBuildValidation = {
  ok: boolean;
  error?: string;
  rolledBackHarnessMutation: boolean;
};

async function runBuild(
  sandbox: Sandbox,
  cwd: string,
): Promise<string | null> {
  const result = await sandbox.runCommand(
    'sh',
    ['-c', `cd "${cwd}" && npm run build 2>&1`],
  );
  if (result.exitCode === 0) return null;
  const stdout = await result.stdout().catch(() => '');
  const stderr = await result.stderr().catch(() => '');
  const combined = `${stdout}${stderr ? `\n${stderr}` : ''}`;
  return combined.length > BUILD_OUTPUT_MAX
    ? combined.slice(-BUILD_OUTPUT_MAX)
    : combined;
}

async function hasPendingPushWork(
  sandbox: Sandbox,
  cwd: string,
): Promise<boolean> {
  try {
    if (await SandboxService.hasWorkingTreeChanges(sandbox)) return true;
    const branch = await SandboxService.getCurrentBranch(sandbox);
    return (
      await SandboxService.countCommitsAheadOfRemote(sandbox, branch, cwd)
    ) > 0;
  } catch {
    // Fail closed: inability to prove that nothing will be pushed must not
    // bypass validation.
    return true;
  }
}

async function readTrackingBackup(
  sandbox: Sandbox,
): Promise<HarnessTrackingBackup | null> {
  const result = await sandbox.runCommand('node', [
    '-e',
    [
      "const fs=require('fs');",
      'const path=process.argv[1];',
      'if(!fs.existsSync(path))process.exit(2);',
      "process.stdout.write(fs.readFileSync(path,'utf8'));",
    ].join(''),
    HARNESS_TRACKING_BACKUP_PATH,
  ]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(await result.stdout()) as HarnessTrackingBackup;
    return (
      typeof parsed.path === 'string' &&
      typeof parsed.originalSource === 'string' &&
      typeof parsed.transformedSource === 'string' &&
      typeof parsed.siteId === 'string'
    ) ? parsed : null;
  } catch {
    return null;
  }
}

async function readSandboxFile(
  sandbox: Sandbox,
  path: string,
): Promise<string | null> {
  const result = await sandbox.runCommand('node', [
    '-e',
    "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
    path,
  ]);
  return result.exitCode === 0 ? result.stdout() : null;
}

async function removeTrackingBackup(sandbox: Sandbox): Promise<void> {
  await sandbox.fs.rm(HARNESS_TRACKING_BACKUP_PATH, { force: true });
}

async function computeWorkspaceFingerprint(
  sandbox: Sandbox,
  cwd: string,
): Promise<string | null> {
  const result = await sandbox.runCommand('node', [
    '-e',
    WORKSPACE_FINGERPRINT_SCRIPT,
    cwd,
  ]);
  if (result.exitCode !== 0) return null;
  const fingerprint = (await result.stdout()).trim();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

async function markPrePushBuildPassed(
  sandbox: Sandbox,
  cwd: string,
): Promise<void> {
  const workspaceFingerprint = await computeWorkspaceFingerprint(sandbox, cwd);
  if (!workspaceFingerprint) return;
  await sandbox.writeFiles([
    {
      path: PRE_PUSH_BUILD_MARKER,
      content: JSON.stringify({ workspaceFingerprint }),
    },
  ]);
}

async function clearPrePushBuildMarker(sandbox: Sandbox): Promise<void> {
  await sandbox.fs.rm(PRE_PUSH_BUILD_MARKER, { force: true });
}

export async function consumePrePushBuildMarker(
  sandbox: Sandbox,
  cwd: string,
): Promise<boolean> {
  const result = await sandbox.runCommand('node', [
    '-e',
    [
      "const fs=require('fs');",
      'const path=process.argv[1];',
      'if(!fs.existsSync(path))process.exit(2);',
      "process.stdout.write(fs.readFileSync(path,'utf8'));",
      'fs.unlinkSync(path);',
    ].join(''),
    PRE_PUSH_BUILD_MARKER,
  ]);
  if (result.exitCode !== 0) return false;
  try {
    const marker = JSON.parse(await result.stdout()) as {
      workspaceFingerprint?: unknown;
    };
    const currentFingerprint = await computeWorkspaceFingerprint(sandbox, cwd);
    return (
      typeof marker.workspaceFingerprint === 'string' &&
      marker.workspaceFingerprint === currentFingerprint
    );
  } catch {
    return false;
  }
}

export async function validateApplicationBeforePush(params: {
  sandbox: Sandbox;
  cwd: string;
  audit?: CronAuditContext;
}): Promise<ApplicationBuildValidation> {
  await clearPrePushBuildMarker(params.sandbox);
  if (!await hasPendingPushWork(params.sandbox, params.cwd)) {
    await removeTrackingBackup(params.sandbox);
    await markPrePushBuildPassed(params.sandbox, params.cwd);
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.PRE_PUSH_BUILD,
      message: 'Pre-push build skipped because the workspace is clean',
      details: { ok: true, skipped_clean_workspace: true },
    });
    return { ok: true, rolledBackHarnessMutation: false };
  }

  const firstError = await runBuild(params.sandbox, params.cwd);
  if (!firstError) {
    await removeTrackingBackup(params.sandbox);
    await markPrePushBuildPassed(params.sandbox, params.cwd);
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.PRE_PUSH_BUILD,
      message: 'Pre-push npm run build passed',
      details: { ok: true },
    });
    return { ok: true, rolledBackHarnessMutation: false };
  }

  const backup = await readTrackingBackup(params.sandbox);
  let didRollbackHarnessMutation = false;
  let finalError = firstError;
  if (backup && backup.path.startsWith(`${params.cwd}/src/app/`)) {
    const currentSource = await readSandboxFile(params.sandbox, backup.path);
    const rolledBackSource = currentSource === null
      ? null
      : rollbackHarnessTrackingScript(currentSource, backup);
    if (rolledBackSource !== null) {
      await params.sandbox.writeFiles([
        { path: backup.path, content: rolledBackSource },
      ]);
      didRollbackHarnessMutation = true;
    }
    await removeTrackingBackup(params.sandbox);
    const afterRollbackError = rolledBackSource === null
      ? firstError
      : await runBuild(params.sandbox, params.cwd);
    finalError = afterRollbackError || firstError;
    if (rolledBackSource !== null && !afterRollbackError) {
      await markPrePushBuildPassed(params.sandbox, params.cwd);
      await logCronInfrastructureEvent(params.audit, {
        event: CronInfraEvent.PRE_PUSH_BUILD,
        level: 'warn',
        message: 'Pre-push build recovered after rolling back harness tracking mutation',
        details: {
          ok: true,
          rolled_back_harness_mutation: true,
          initial_error: firstError.slice(-1_200),
        },
      });
      return { ok: true, rolledBackHarnessMutation: true };
    }
  } else {
    await removeTrackingBackup(params.sandbox);
  }

  await logCronInfrastructureEvent(params.audit, {
    event: CronInfraEvent.PRE_PUSH_BUILD,
    level: 'error',
    message: 'Pre-push npm run build failed; origin was not updated',
    details: {
      ok: false,
      error: finalError.slice(-1_200),
      initial_error: didRollbackHarnessMutation
        ? firstError.slice(-1_200)
        : undefined,
    },
  });
  return {
    ok: false,
    error: `Pre-push build failed; no commit was pushed:\n${finalError}`,
    rolledBackHarnessMutation: didRollbackHarnessMutation,
  };
}

export async function ensureApplicationBuildCurrent(params: {
  sandbox: Sandbox;
  cwd: string;
  audit?: CronAuditContext;
}): Promise<ApplicationBuildValidation> {
  if (await consumePrePushBuildMarker(params.sandbox, params.cwd)) {
    await markPrePushBuildPassed(params.sandbox, params.cwd);
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.PRE_PUSH_BUILD,
      message: 'Pre-push validation reused an unchanged successful build',
      details: { ok: true, reused_matching_workspace: true },
    });
    return { ok: true, rolledBackHarnessMutation: false };
  }
  return validateApplicationBeforePush(params);
}
