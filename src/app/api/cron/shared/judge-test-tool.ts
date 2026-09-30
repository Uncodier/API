import type { Sandbox } from '@vercel/sandbox';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';
import { computeApplicationBuildFingerprint } from './commit/pre-push-build-validation';
import { runDeclaredTestCommand } from './step-test-evidence';
import { SandboxService } from '@/lib/services/sandbox-service';
import { isDirectTestCommand, reportsExecutedTests } from './judge-test-repair';

/** One host-owned, bounded execution. No detached process can escape the repair budget. */
export function createJudgeTestTool(params: {
  sandbox: () => Sandbox;
  requirementId: string;
  backlogItemId: string;
  stepId: string;
  assertCurrent: () => Promise<void>;
}) {
  return {
    name: 'sandbox_run_tests',
    description: 'Run the existing repository test command with a bounded timeout and persist fresh test evidence. Use this tool, not shell/background tools, for the current automatic test repair. It does not approve or deliver the product.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { command: { type: 'string', description: 'Direct existing test invocation, e.g. npm test -- --runInBand. No shell operators or wrappers.' } },
      required: ['command'],
    },
    execute: async (args: { command: string }) => {
      await params.assertCurrent();
      if (!isDirectTestCommand(args.command)) {
        return { success: false, error: 'Use a direct test-runner command without shell operators or exit masking.' };
      }
      const sandbox = params.sandbox();
      const before = await computeApplicationBuildFingerprint(sandbox, SandboxService.WORK_DIR);
      if (!before) return { success: false, error: 'Cannot establish the test workspace identity.' };
      const result = await runDeclaredTestCommand(sandbox, args.command, {
        timeoutMs: 180_000, stepId: params.stepId, workspaceFingerprint: before,
      });
      await params.assertCurrent();
      if (result.ok && !result.tests.some(test => reportsExecutedTests(test.output_tail))) {
        return { success: false, error: 'Exit code 0 did not include a nonempty test-run summary. Run real tests, not a help/list/config command or an empty suite.' };
      }
      const after = await computeApplicationBuildFingerprint(sandbox, SandboxService.WORK_DIR);
      const fresh = !!after && before === after;
      const tests = result.tests.map(test => ({ ...test, ran_after_changes: fresh }));
      // Missing persistence must not turn a completed process into approval.
      await writeEvidence({
        requirementId: params.requirementId, itemId: params.backlogItemId,
        requireCanonicalPersistence: true,
        record: { producer_step_id: params.stepId, workspace_fingerprint: after || undefined,
          captured_at: new Date().toISOString(), tests },
      });
      await params.assertCurrent();
      return {
        success: result.ok && fresh,
        ...(fresh ? {} : { error: 'Workspace changed during test execution; fresh tests are required.' }),
        receipt: {
          kind: 'test_execution', requirement_id: params.requirementId,
          item_id: params.backlogItemId, step_id: params.stepId,
          workspace_fingerprint: after, tests,
        },
      };
    },
  };
}