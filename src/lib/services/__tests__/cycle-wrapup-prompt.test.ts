import {
  buildCycleWrapUpSystemPrompt,
  countPendingPlanSteps,
  feedbackRequiredBacklogItems,
  shouldRunCycleWrapUp,
  shouldSkipWrapUpForPendingSteps,
} from '../cycle-wrapup-prompt';

describe('cycle-wrapup-prompt', () => {
  it('embeds instructions, history, digest, and verdict rules', () => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Cotización demo',
      requirementId: 'req-123',
      instructions: 'Genera una cotización con price',
      historyPromptText: '=== USER MESSAGE HISTORY (ALL) ===\nUser:\nNecesito quote\n',
      historyMode: 'full',
      digestFiles: [
        {
          path: 'docs/quote.json',
          content: '{"price":20,"currency":"USD"}',
          bytes: 30,
          bytes_original: 30,
          summarized: false,
        },
      ],
      planCompleted: true,
      previewUrl: 'https://preview.example',
      repoUrl: 'https://github.com/org/repo/tree/branch',
    });

    expect(prompt).toContain('Genera una cotización con price');
    expect(prompt).toContain('USER MESSAGE HISTORY');
    expect(prompt).toContain('docs/quote.json');
    expect(prompt).toContain('"price":20');
    expect(prompt).toContain('INFERENCE ONLY');
    expect(prompt).toContain('DELIVERED');
    expect(prompt).toContain('NEEDS USER ITERATION');
    expect(prompt).toContain('User history mode: full');
    expect(prompt).toContain('req-123');
    expect(prompt).toContain('SAME language');
  });

  it('forbids asking the user when later plan steps remain', () => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Research',
      requirementId: 'req-1',
      instructions: 'Map channels',
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [],
      planCompleted: false,
      pendingPlanSteps: 2,
    });
    expect(prompt).toContain('Pending plan steps remaining: 2');
    expect(prompt).toContain('Do NOT ask the user for permission');
    expect(prompt).not.toContain('NEEDS USER ITERATION');
    expect(shouldSkipWrapUpForPendingSteps({ planCompleted: false, pendingPlanSteps: 2 })).toBe(true);
    expect(shouldSkipWrapUpForPendingSteps({ planCompleted: true, pendingPlanSteps: 2 })).toBe(false);
    expect(countPendingPlanSteps([
      { status: 'completed' },
      { status: 'failed' },
      { status: 'pending' },
      { status: 'in_progress' },
    ])).toBe(2);
  });

  it('asks for feedback when a forced wrap-up reports blocked pending work', () => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Research',
      requirementId: 'req-2',
      instructions: 'Map channels',
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [],
      planCompleted: false,
      pendingPlanSteps: 2,
      wrapUpReason: 'The active item exhausted its attempt budget.',
      requiresUserFeedback: true,
    });

    expect(prompt).toContain('USER FEEDBACK REQUIRED');
    expect(prompt).toContain('explicitly ask the user to reply');
    expect(prompt).toContain("stage='blocked'");
    expect(prompt).toContain('The active item exhausted its attempt budget.');
    expect(prompt).not.toContain('Do NOT ask the user for permission');
    expect(
      shouldSkipWrapUpForPendingSteps({
        planCompleted: false,
        pendingPlanSteps: 2,
        forceWrapUp: true,
      }),
    ).toBe(false);
  });

  it('shouldRunCycleWrapUp skips only when both empty', () => {
    expect(shouldRunCycleWrapUp({ hasDigest: false, userMessageCount: 0 })).toBe(false);
    expect(shouldRunCycleWrapUp({ hasDigest: true, userMessageCount: 0 })).toBe(true);
    expect(shouldRunCycleWrapUp({ hasDigest: false, userMessageCount: 2 })).toBe(true);
  });

  it('detects attempted pending items, review items, and exhausted active work', () => {
    const items = [
      { status: 'pending', attempts: 2, tier: 'ornamental' as const },
      { status: 'pending', attempts: 1, tier: 'core' as const },
      { status: 'in_progress', attempts: 4, tier: 'core' as const },
      { status: 'needs_review', attempts: 1, tier: 'core' as const },
      { status: 'done', attempts: 100, tier: 'core' as const },
    ];

    expect(feedbackRequiredBacklogItems(items, { core: 5, ornamental: 2 })).toEqual([
      items[0],
      items[1],
      items[3],
    ]);
  });
});
