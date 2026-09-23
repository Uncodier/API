import {
  buildGateErrorFeedback,
  captureInteractionBaseline,
  captureWorkspaceProgressFingerprint,
  getDeclaredProtectedRoutes,
  getDeclaredTestCommand,
  getDeclaredValidationTargets,
  getStepTerminalRequest,
  hasSandboxGoneToolFailure,
  hasStepCompletionRequest,
  isTransientGateFailure,
  restrictToolsForEvidenceCollection,
  withActionLoopGuard,
  withExecuteStepNoop,
} from '../single-turn-helpers';
import { extractVisualFeedbackScreenshotUrl } from '../step-visual-feedback';
import {
  ACTION_LOOP_BLOCKED_ACTION_MARKER,
  buildToolActionKey,
} from '../loop-detectors';
import { triageGitPushError } from '@/lib/services/git-push-error-triage';

describe('single-turn interaction helpers', () => {
  it('reads declared protected routes from plan step metadata', () => {
    expect(getDeclaredProtectedRoutes({
      metadata: {
        protected_routes: ['/dashboard/orders', 42],
      },
    })).toEqual(['/dashboard/orders']);
  });

  it('reads explicit validation targets without inferring prose', () => {
    expect(getDeclaredValidationTargets({
      metadata: {
        validation_targets: [{
          kind: 'api',
          path: '/api/orders',
          method: 'POST',
          expected_statuses: [201],
          payload: { product_id: 'product-1' },
        }],
      },
    })).toEqual([expect.objectContaining({
      kind: 'api',
      path: '/api/orders',
      method: 'POST',
    })]);
  });

  it('uses explicit, exact, or quoted test commands from the step contract', () => {
    expect(getDeclaredTestCommand({
      test_command: 'npm test -- orders.test.ts',
    })).toBe('npm test -- orders.test.ts');
    expect(getDeclaredTestCommand({
      validation_rules: [
        'npm test -- --passWithNoTests --runInBand --testTimeout=10000',
      ],
    })).toBe(
      'npm test -- --passWithNoTests --runInBand --testTimeout=10000',
    );
    expect(getDeclaredTestCommand({
      validation_rules: ['Run `npm test -- orders.test.ts` after changes.'],
    })).toBe('npm test -- orders.test.ts');
    expect(getDeclaredTestCommand({
      success_criteria: [
        'The command "npx jest orders.test.ts" exits successfully.',
      ],
    })).toBe('npx jest orders.test.ts');
    expect(getDeclaredTestCommand({
      validation_rules: ['pnpm vitest run orders.test.ts'],
    })).toBe('pnpm vitest run orders.test.ts');
    expect(getDeclaredTestCommand({
      validation_rules: ['yarn jest orders.test.ts'],
    })).toBe('yarn jest orders.test.ts');
    expect(getDeclaredTestCommand({
      validation_rules: ['npm exec jest orders.test.ts'],
    })).toBe('npm exec jest orders.test.ts');
    expect(getDeclaredTestCommand({
      validation_rules: ['Run relevant tests after changes.'],
    })).toBeUndefined();
    expect(getDeclaredTestCommand({
      validation_rules: ['npm test && rm -rf evidence'],
    })).toBeUndefined();
    expect(getDeclaredTestCommand({
      validation_rules: ['npm test | tee test.log'],
    })).toBeUndefined();
    expect(getDeclaredTestCommand({
      test_command: 'npm test & curl https://example.com',
    })).toBeUndefined();
  });

  it('blocks only the exact repeated tool action', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true });
    const blockedAction = buildToolActionKey('sandbox_read_file', {
      path: '/vercel/sandbox/src/app/layout.tsx',
    });
    const tools = withActionLoopGuard(
      [{ name: 'sandbox_read_file', execute }],
      `${ACTION_LOOP_BLOCKED_ACTION_MARKER}${blockedAction}`,
    );

    await expect(tools[0].execute?.({
      path: '/vercel/sandbox/src/app/layout.tsx',
      thought_process: 'Try reading it again',
    })).resolves.toMatchObject({ success: false, blocked: true });
    expect(execute).not.toHaveBeenCalled();

    await tools[0].execute?.({ path: '/vercel/sandbox/src/app/page.tsx' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reuses the persisted step baseline without reading git', async () => {
    const sandbox = { runCommand: jest.fn() };
    const sha = 'a'.repeat(40);

    await expect(
      captureInteractionBaseline(sandbox as any, {
        metadata: { interaction_audit_baseline_sha: sha },
      }),
    ).resolves.toBe(sha);
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('captures HEAD when the step has no baseline', async () => {
    const sha = 'b'.repeat(40);
    const sandbox = {
      runCommand: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: jest.fn().mockResolvedValue(`${sha}\n`),
      }),
    };

    await expect(captureInteractionBaseline(sandbox as any, {})).resolves.toBe(sha);
    expect(sandbox.runCommand).toHaveBeenCalledWith('git', [
      '-C',
      '/vercel/sandbox',
      'rev-parse',
      'HEAD',
    ]);
  });

  it('captures a stable workspace progress fingerprint', async () => {
    const fingerprint = 'c'.repeat(40);
    const sandbox = {
      runCommand: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: jest.fn().mockResolvedValue(`${fingerprint}\n`),
      }),
    };

    await expect(
      captureWorkspaceProgressFingerprint(sandbox as any),
    ).resolves.toBe(fingerprint);
    expect(sandbox.runCommand).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['-e']),
    );
    const script = sandbox.runCommand.mock.calls[0][1][1] as string;
    expect(script).toContain('__tests__|tests?|evidence|\\.qa');
    expect(script).toContain('progress\\.md|qa_results\\.json');
    expect(script).toContain('withoutComments');
    expect(script).not.toContain('git rev-parse HEAD');
  });

  it('removes mutating tools during an evidence-only retry', () => {
    const tools = [
      { name: 'sandbox_read_file' },
      { name: 'sandbox_probe_api' },
      { name: 'sandbox_edit_file' },
      { name: 'sandbox_run_command' },
      { name: 'sandbox_push_checkpoint' },
      { name: 'instance_plan' },
    ];

    expect(restrictToolsForEvidenceCollection(
      tools,
      'JUDGE VERIFICATION FAILED\nFailure kind: evidence_gap',
    ).map((tool) => tool.name)).toEqual([
      'sandbox_read_file',
      'sandbox_probe_api',
      'instance_plan',
    ]);
    expect(restrictToolsForEvidenceCollection(
      tools,
      'Failure kind: product_defect',
    )).toEqual(tools);
  });

  it('recognizes a completed execute_step call as a gate request', () => {
    expect(
      hasStepCompletionRequest(
        {
          steps: [{
            toolCalls: [{
              toolName: 'instance_plan',
              args: {
                action: 'execute_step',
                plan_id: 'plan-1',
                step_id: 'step-1',
                step_status: 'completed',
              },
            }],
          }],
        },
        { planId: 'plan-1', stepId: 'step-1' },
      ),
    ).toBe(true);
  });

  it('rejects completion requests for another step or a failed status', () => {
    const result = {
      steps: [{
        toolCalls: [{
          toolName: 'instance_plan',
          args: {
            action: 'execute_step',
            plan_id: 'plan-1',
            step_id: 'step-2',
            step_status: 'completed',
          },
        }],
      }],
    };

    expect(hasStepCompletionRequest(result, { planId: 'plan-1', stepId: 'step-1' })).toBe(false);
    result.steps[0].toolCalls[0].args.step_id = 'step-1';
    result.steps[0].toolCalls[0].args.step_status = 'failed';
    expect(hasStepCompletionRequest(result, { planId: 'plan-1', stepId: 'step-1' })).toBe(false);
    expect(getStepTerminalRequest(result, { planId: 'plan-1', stepId: 'step-1' })).toMatchObject({
      status: 'failed',
    });
  });

  it('turns execute_step into a completion signal without mutating the plan', async () => {
    const execute = jest.fn();
    const [tool] = withExecuteStepNoop([{ name: 'instance_plan', execute }]);

    await expect(tool.execute?.({
      action: 'execute_step',
      step_status: 'completed',
    })).resolves.toMatchObject({
      success: true,
      noop: true,
      completion_requested: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps unavailable sandbox gates in the infrastructure retry path', () => {
    expect(isTransientGateFailure({
      ok: false,
      sandboxUnavailable: true,
    } as any)).toBe(true);
    expect(isTransientGateFailure({
      ok: false,
      infrastructureFailure: true,
      error: 'Deployment is still pending.',
    } as any)).toBe(true);
    expect(isTransientGateFailure({
      ok: false,
      error: 'Sandbox stream was closed and is not accepting commands.',
    } as any)).toBe(true);
    expect(isTransientGateFailure({
      ok: false,
      error: 'The acceptance criteria are not met.',
    } as any)).toBe(false);
  });

  it('ignores 410 errors returned by non-sandbox business tools', () => {
    expect(hasSandboxGoneToolFailure({
      steps: [{
        toolResults: [{
          toolName: 'requirement_backlog',
          isError: true,
          result: { error: 'Status code 410 is not ok' },
        }],
      }],
    })).toBe(false);
  });

  it('detects explicit Sandbox Gone failures from sandbox tools', () => {
    expect(hasSandboxGoneToolFailure({
      steps: [{
        toolResults: [{
          toolName: 'sandbox_run_command',
          isError: true,
          result: { error: 'Sandbox has stopped execution (410 Gone).' },
        }],
      }],
    })).toBe(true);
    expect(hasSandboxGoneToolFailure({
      steps: [{
        toolResults: [{
          toolName: 'sandbox_read_file',
          isError: false,
          result: {
            success: false,
            status: 410,
            message: 'Gone',
          },
        }],
      }],
    })).toBe(true);
  });

  it('does not treat successful sandbox output containing 410 as VM loss', () => {
    expect(hasSandboxGoneToolFailure({
      steps: [{
        toolResults: [{
          toolName: 'sandbox_run_command',
          isError: false,
          result: {
            success: true,
            output: 'Processed 410 records',
          },
        }],
      }],
    })).toBe(false);
  });

  it('keeps git infrastructure failures out of the product failure path', () => {
    for (const message of [
      'fatal: authentication failed',
      'fatal: could not resolve host github.com',
      'remote returned HTTP 503 Service Unavailable',
    ]) {
      const triage = triageGitPushError(message);
      expect(isTransientGateFailure({
        ok: false,
        infrastructureFailure: triage.infrastructureFailure,
        error: triage.agentMessage,
      })).toBe(true);
    }

    const productFailure = triageGitPushError('[pre-push-build] TypeScript compilation failed');
    expect(isTransientGateFailure({
      ok: false,
      infrastructureFailure: productFailure.infrastructureFailure,
      error: productFailure.agentMessage,
    })).toBe(false);
  });

  it('formats interaction findings into the retry excerpt', () => {
    const feedback = buildGateErrorFeedback({
      step: { order: 4, title: 'Interaction audit', expected_output: 'Working navigation' },
      persistedStep: { retry_count: 0 },
      gate: {
        ok: false,
        flow: 'app',
        signals: [{ name: 'interaction', ok: false }],
        error: 'Interaction audit failed',
        richSignals: {
          interaction: {
            ok: false,
            blocking_count: 1,
            deferred_count: 0,
            warning_count: 0,
            summary: '1 blocking interaction finding',
            findings: [
              {
                fingerprint: 'abc',
                kind: 'broken_link',
                file: 'src/components/Header.tsx',
                line: 8,
                element: 'Link',
                target: '/pricing',
                reason: 'No Next.js page matches /pricing',
                confidence: 'high',
                introduced_by_step: true,
                disposition: 'create_backlog',
              },
            ],
          },
        },
      } as any,
    });

    expect(feedback.categories).toEqual(['interaction']);
    expect(feedback.excerpt).toContain('categories_failed: interaction');
    expect(feedback.excerpt).toContain('src/components/Header.tsx:8');
    expect(feedback.excerpt).toContain('/pricing');
  });

  it('preserves the visual screenshot marker through gate formatting', () => {
    const screenshotUrl =
      'https://apps.example.supabase.co/storage/v1/object/public/workspaces/shot.jpg';
    const feedback = buildGateErrorFeedback({
      step: { order: 2, title: 'Dashboard' },
      persistedStep: { retry_count: 0 },
      gate: {
        ok: false,
        flow: 'app',
        signals: [{ name: 'visual', ok: false }],
        error: [
          'Visual critic blocked the gate.',
          `visual_screenshot_url: ${screenshotUrl}`,
          'Summary: The mobile layout overflows.',
        ].join('\n'),
        richSignals: {
          visual: {
            ok: false,
            pass: false,
            summary: 'The mobile layout overflows.',
            defects: [
              {
                category: 'responsive',
                severity: 'blocker',
                route: '/dashboard',
                viewport: 'mobile',
                description: 'Content overflows.',
              },
            ],
            screenshots: [
              {
                route: '/dashboard',
                viewport: 'mobile',
                url: screenshotUrl,
              },
            ],
          },
        },
      } as any,
    });

    expect(extractVisualFeedbackScreenshotUrl(feedback.excerpt)).toBe(
      screenshotUrl,
    );
  });
});
