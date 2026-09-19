import {
  activeBacklogItemIdsFromPlanSteps,
  buildCycleWrapUpSystemPrompt,
  countPendingPlanSteps,
  feedbackRequiredBacklogItems,
  hasRunnableBacklogWork,
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
    expect(shouldSkipWrapUpForPendingSteps({
      planCompleted: false,
      pendingPlanSteps: 0,
      hasRunnableBacklogWork: true,
    })).toBe(true);
    expect(shouldSkipWrapUpForPendingSteps({ planCompleted: true, pendingPlanSteps: 2 })).toBe(false);
    expect(countPendingPlanSteps([
      { status: 'completed' },
      { status: 'failed', retry_count: 2 },
      { status: 'pending' },
      { status: 'in_progress' },
    ])).toBe(2);
    expect(countPendingPlanSteps([
      { status: 'failed', retry_count: 1 },
    ])).toBe(1);
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

  it('does not let historical review items block runnable work', () => {
    const items = [
      { id: 'old-review', phase_id: 'outline', status: 'needs_review', attempts: 4, tier: 'core' as const },
      { id: 'active', phase_id: 'build', status: 'in_progress', attempts: 3, tier: 'core' as const },
      { id: 'next', phase_id: 'build', status: 'pending', attempts: 0, tier: 'core' as const },
    ];

    expect(feedbackRequiredBacklogItems(
      items,
      { core: 4, ornamental: 2 },
      { currentPhaseId: 'build' },
    )).toEqual([]);
  });

  it('continues when independent backlog work remains after a failure', () => {
    expect(hasRunnableBacklogWork([
      {
        id: 'failed',
        status: 'needs_review',
        attempts: 4,
        tier: 'core',
      },
      {
        id: 'independent',
        status: 'pending',
        attempts: 0,
        tier: 'core',
      },
    ], { core: 4, ornamental: 2 })).toBe(true);
  });

  it('does not call dependency-blocked work runnable', () => {
    expect(hasRunnableBacklogWork([
      {
        id: 'failed',
        status: 'needs_review',
        attempts: 4,
        tier: 'core',
      },
      {
        id: 'dependent',
        status: 'pending',
        attempts: 0,
        tier: 'core',
        depends_on: ['failed'],
      },
    ], { core: 4, ornamental: 2 })).toBe(false);
  });

  it('asks for feedback only when the relevant scope has no runnable work', () => {
    const items = [
      { id: 'review', phase_id: 'outline', status: 'needs_review', attempts: 4, tier: 'core' as const },
      { id: 'exhausted', phase_id: 'outline', status: 'in_progress', attempts: 4, tier: 'core' as const },
      { id: 'unrelated', phase_id: 'build', status: 'pending', attempts: 0, tier: 'core' as const },
    ];

    expect(feedbackRequiredBacklogItems(
      items,
      { core: 4, ornamental: 2 },
      { currentPhaseId: 'outline' },
    )).toEqual([items[0], items[1]]);
  });

  it('suppresses backlog feedback while the current plan can continue', () => {
    const items = [
      { id: 'review', status: 'needs_review', attempts: 4, tier: 'core' as const },
    ];

    expect(feedbackRequiredBacklogItems(
      items,
      { core: 4, ornamental: 2 },
      { hasRunnablePlanSteps: true },
    )).toEqual([]);
  });

  it('extracts unique backlog ids from pending plan steps', () => {
    expect(activeBacklogItemIdsFromPlanSteps([
      { status: 'completed', metadata: { backlog_item_id: 'done' } },
      { status: 'failed', retry_count: 1, metadata: { backlog_item_id: 'retry' } },
      { status: 'in_progress', metadata: { backlog_item_id: 'active' } },
      { status: 'pending', backlog_item_id: 'active' },
      { status: 'pending', backlog_item_id: 'next' },
    ])).toEqual(['retry', 'active', 'next']);
  });
});
