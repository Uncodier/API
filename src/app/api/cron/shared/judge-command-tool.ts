import type { Sandbox } from '@vercel/sandbox';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';
import { SandboxService } from '@/lib/services/sandbox-service';
import { computeApplicationBuildFingerprint } from './commit/pre-push-build-validation';
import { sanitizeRuntimeLog } from './runtime-log-context';
import { isCommandRepairAction, isValidationScript, validationCommand } from './judge-command-repair';
import type { RepairAction } from './judge-repair-controller';

/** One typed action, one existing validation script, no arbitrary shell/background tool. */
export function createJudgeCommandTool(params: {
  sandbox: () => Sandbox;
  requirementId: string;
  backlogItemId: string;
  stepId: string;
  action: RepairAction;
  assertCurrent: () => Promise<void>;
}) {
  return {
    name: 'sandbox_run_validation',
    description: `Run the host-bound validation command ${params.action.command} with a three-minute timeout and persist its own fresh evidence. No edits, deployment, SQL, custom commands or customer approval.`,
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    execute: async (_args: Record<string, never>) => {
      await params.assertCurrent();
      const command = validationCommand(params.action.command);
      if (!isCommandRepairAction(params.action) || !command) {
        return { success: false, error: 'No typed validation action is bound to this tool.' };
      }
      const sandbox = params.sandbox();
      const before = await computeApplicationBuildFingerprint(sandbox, SandboxService.WORK_DIR);
      if (!before) return { success: false, error: 'Cannot establish validation workspace identity.' };
      let scripts: Record<string, unknown>;
      try {
        const pkg = JSON.parse(await sandbox.fs.readFile(`${SandboxService.WORK_DIR}/package.json`, 'utf8'));
        scripts = pkg.scripts || {};
      } catch { return { success: false, error: 'Repository package scripts are unavailable.' }; }
      const scriptName = command.split(' ').at(-1)!;
      const script = scripts[scriptName];
      // Package managers run lifecycle hooks too. They are not this action.
      if (!isValidationScript(script, scriptName) || scripts[`pre${scriptName}`] || scripts[`post${scriptName}`]) {
        return { success: false, code: 'VALIDATION_PRODUCT_FAILURE',
          error: 'The declared validation script is absent or is not a direct existing validator. Repair its repository configuration; shell wrappers, fixes, downloads and lifecycle hooks are not authorized by evidence collection.' };
      }
      await params.assertCurrent();
      const ready = await computeApplicationBuildFingerprint(sandbox, SandboxService.WORK_DIR);
      if (ready !== before) return { success: false, error: 'Workspace changed while preparing validation.' };
      await params.assertCurrent();
      const capturedAt = new Date().toISOString();
      // SDK timeoutMs kills the command server-side; an aborted HTTP wait alone
      // would leave an unaccounted process. No detached execution is permitted.
      const result = await sandbox.runCommand({ cmd: command.split(' ')[0], args: command.split(' ').slice(1),
        cwd: SandboxService.WORK_DIR, timeoutMs: 180_000 });
      if (!Number.isInteger(result.exitCode) || result.exitCode < 0) {
        return { success: false, error: 'Validation completion has no known exit outcome. Reconcile execution before retrying; no passing receipt was created.' };
      }
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      await params.assertCurrent();
      const after = await computeApplicationBuildFingerprint(sandbox, SandboxService.WORK_DIR);
      const fresh = !!after && before === after;
      const commands = [{ command, exit_code: result.exitCode,
        output_tail: sanitizeRuntimeLog(`${stdout}\n${stderr}`).slice(-6000), ran_after_changes: fresh,
        captured_at: capturedAt, step_id: params.stepId, workspace_fingerprint: before,
        criterion_id: params.action.criterion_id }];
      await writeEvidence({ requirementId: params.requirementId, itemId: params.backlogItemId,
        requireCanonicalPersistence: true,
        record: { producer_step_id: params.stepId, workspace_fingerprint: after || before,
          captured_at: capturedAt, commands } });
      await params.assertCurrent();
      return { success: result.exitCode === 0 && fresh,
        ...(result.exitCode !== 0 ? { code: 'VALIDATION_PRODUCT_FAILURE', error: `Validation exited with code ${result.exitCode ?? -1}. Inspect its output and repair the repository.` }
          : !fresh ? { error: 'Workspace changed during validation; fresh evidence is required.' } : {}),
        receipt: { kind: 'command_execution', requirement_id: params.requirementId, item_id: params.backlogItemId,
          step_id: params.stepId, workspace_fingerprint: before, commands } };
    },
  };
}