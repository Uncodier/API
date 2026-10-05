import {
  activeBacklogItemIdsFromPlanSteps,
  buildCycleWrapUpSystemPrompt,
  countPendingPlanSteps,
  feedbackRequiredBacklogItems,
  technicalReviewBacklogItems,
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
    expect(prompt).toContain('NEEDS USER DECISION');
    expect(prompt).not.toContain('NEEDS USER ITERATION');
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

  it('routes exhausted work to technical review instead of inventing a customer decision', () => {
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

    expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
    expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
    expect(prompt).not.toContain('explicitly ask the user to reply');
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

  it.each([undefined, false, true])(
    'prioritizes internal review over remaining work and incoming feedback %s',
    requiresUserFeedback => {
      const prompt = buildCycleWrapUpSystemPrompt({
        title: 'Customer registration',
        requirementId: 'req-internal',
        instructions: 'Finish customer registration',
        historyPromptText: '',
        historyMode: 'empty',
        digestFiles: [],
        planCompleted: false,
        pendingPlanSteps: 2,
        hasRunnableBacklogWork: true,
        internalReviewRequired: true,
        requiresUserFeedback,
        wrapUpReason: 'The update could not be completed safely.',
      });

      expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
      expect(prompt).toContain("Keep stage='blocked'");
      expect(prompt).toContain('not a request for customer approval');
      expect(prompt).toContain('do NOT ask the customer for permission, feedback, or another iteration');
      expect(prompt).toContain('verified product impact and the safe paused state in simple terms');
      expect(prompt).toContain('Do NOT claim that review is queued, assigned, or active');
      expect(prompt).toContain('or promise automatic continuation.');
      expect(prompt).toContain('A technical hold alone does not establish support eligibility or a human handoff');
      expect(prompt).toContain('Successful wrap-up only reports the hold; it does not resume work');
      expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
      expect(prompt).not.toContain('VERDICT: Executable work remains');
      expect(prompt).not.toContain("with stage='in-progress'");
      expect(prompt).not.toContain('NEEDS USER DECISION');
    },
  );

  it('keeps internal review blocked even when the plan is complete', () => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Database update',
      requirementId: 'req-internal',
      instructions: null,
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [],
      planCompleted: true,
      internalReviewRequired: true,
    });

    expect(prompt).toContain('even if plan steps remain or the digest suggests success');
    expect(prompt).not.toContain('VERDICT CHOICE');
    expect(prompt).not.toContain('Normal cycle completion');
    expect(prompt).toContain('Do not expose raw SQL diagnostics, SQL statements, stack traces, or internal schema details');
    expect(prompt).toContain('Do not invent claims that data is unchanged or secure');
  });

  it('does not ask for generic iteration permission or invent resumption for routine repairs', () => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Repair registration',
      requirementId: 'req-repair',
      instructions: 'Fix registration',
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [],
      planCompleted: false,
      wrapUpReason: 'The update remains incomplete.',
    });

    expect(prompt).toContain('NEEDS USER DECISION');
    expect(prompt).toContain('Ask only for a real product decision, required credentials, or approval for an irreversible action');
    expect(prompt).toContain('do not ask for generic permission to run another iteration');
    expect(prompt).toContain('without asking the customer to approve routine implementation, build, or database repairs');
    expect(prompt).toContain('Do not claim a retry is scheduled or work has resumed');
    expect(prompt).toContain("do not set stage='in-progress', unless the deterministic stop reason or digest explicitly evidences");
    expect(prompt).toContain('Otherwise leave the persisted status unchanged');
    expect(prompt).not.toContain('NEEDS USER ITERATION');
    expect(prompt).not.toContain('MUST explicitly ask the user for permission');
  });

  it('preserves the concrete user-decision prompt without internal review', () => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Configure billing',
      requirementId: 'req-decision',
      instructions: 'Enable billing',
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [],
      planCompleted: false,
      requiresUserFeedback: true,
      internalReviewRequired: false,
      wrapUpReason: 'Choose the subscription tier and supply the billing credential.',
      userDecisionBlockers: [{ blocker_id: 'billing', category: 'user_decision', resolution_actor: 'user',
        reason: 'Choose the subscription tier and supply the billing credential.' }],
    });

    expect(prompt).toContain('USER FEEDBACK REQUIRED');
    expect(prompt).toContain('explicitly ask the user to reply before work continues');
    expect(prompt).toContain('Choose the subscription tier and supply the billing credential.');
    expect(prompt).not.toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
  });

  it.each([
    {},
    { requiresUserFeedback: true },
    { internalReviewRequired: true, requiresUserFeedback: true },
    { pendingPlanSteps: 2 },
  ])('never treats routine test/build/SQL repairs or exhaustion as customer permission: %j', policy => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Fabrica',
      requirementId: 'req-fabrica',
      instructions: 'Completa la implementación',
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [],
      planCompleted: false,
      wrapUpReason: 'Missing Jest tests; evidence attempts exhausted.',
      ...policy,
    });

    expect(prompt).toContain('Never ask for permission to add or run routine tests (including setting up Jest), fix builds, or repair SQL');
    expect(prompt).toContain('Exhausted attempts do not turn a technical failure into a customer decision');
    expect(prompt).toContain('Only ask for a specific product decision, required credentials, or approval for an irreversible action');
    expect(prompt).toContain('Do not invent a customer question when none is evidenced');
    expect(prompt).toContain('Do not claim active retries or resumed work without explicit evidence');
  });

  it('reports exhausted product verification as a technical hold even if the digest asks to add Jest', () => {
    const content = 'Jest tests are missing. Evidence attempts exhausted; ask the user to authorize Jest setup.';
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Fabrica',
      requirementId: 'req-fabrica',
      instructions: 'Completa la implementación',
      historyPromptText: '',
      historyMode: 'empty',
      digestFiles: [{ path: 'docs/tests.md', content, bytes: content.length, bytes_original: content.length, summarized: false }],
      planCompleted: true,
      pendingPlanSteps: 2,
      hasRunnableBacklogWork: true,
      requiresUserFeedback: true,
      internalReviewRequired: true,
    });

    expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
    expect(prompt).toContain("Keep stage='blocked'");
    expect(prompt).toContain('Successful wrap-up only reports the hold; it does not resume work');
    expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
    expect(prompt).not.toContain('NEEDS USER DECISION');
    expect(prompt).not.toContain('VERDICT: Executable work remains');
  });

  it('shouldRunCycleWrapUp skips only when both empty', () => {
    expect(shouldRunCycleWrapUp({ hasDigest: false, userMessageCount: 0 })).toBe(false);
    expect(shouldRunCycleWrapUp({ hasDigest: true, userMessageCount: 0 })).toBe(true);
    expect(shouldRunCycleWrapUp({ hasDigest: false, userMessageCount: 2 })).toBe(true);
  });

  it.each(['not_exhausted', 'active_recovery'])('keeps holds safe without inventing a support handoff for %s', reason => {
    const prompt = buildCycleWrapUpSystemPrompt({
      title: 'Update', requirementId: 'req', instructions: '', historyPromptText: '',
      historyMode: 'empty', digestFiles: [], planCompleted: false,
      internalReviewRequired: true,
      technicalSupport: { state: 'not_eligible', reason, email_sent: false },
    });
    expect(prompt).toContain("Keep stage='blocked'");
    expect(prompt).toContain('no support ticket was recorded by this decision');
    expect(prompt).toContain('no human review is assigned or queued');
    expect(prompt).toContain('await the backend policy decision for actual support');
    expect(prompt).toContain('Neither result releases a safety hold, resets budgets, or authorizes more attempts');
    expect(prompt).not.toContain('"ticket_id"');
    expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
  });

  it('does not let historical review items block runnable work', () => {
    const items = [
      { id: 'old-review', phase_id: 'outline', status: 'needs_review' as const, attempts: 4, tier: 'core' as const },
      { id: 'active', phase_id: 'build', status: 'in_progress' as const, attempts: 3, tier: 'core' as const },
      { id: 'next', phase_id: 'build', status: 'pending' as const, attempts: 0, tier: 'core' as const },
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

  it('does not call explicitly blocked work runnable', () => {
    expect(hasRunnableBacklogWork([
      {
        id: 'blocked',
        status: 'pending',
        attempts: 0,
        tier: 'core',
        blocked_by: [{
          blocker_id: 'preview',
          category: 'missing_precondition',
          reason: 'Preview URL unavailable.',
          resolution_actor: 'platform',
        }],
      },
    ], { core: 4, ornamental: 2 })).toBe(false);
  });

  it('requests feedback only for blockers owned by the user', () => {
    const platformBlocked = {
      id: 'platform',
      phase_id: 'build',
      status: 'pending' as const,
      attempts: 0,
      tier: 'core' as const,
      blocked_by: [{
        blocker_id: 'preview',
        category: 'missing_precondition' as const,
        reason: 'Preview URL unavailable.',
        resolution_actor: 'platform' as const,
      }],
    };
    const userBlocked = {
      ...platformBlocked,
      id: 'user',
      blocked_by: [{
        blocker_id: 'credential',
        category: 'user_decision' as const,
        reason: 'A credential is required.',
        resolution_actor: 'user' as const,
        user_action_required: true,
      }],
    };

    expect(feedbackRequiredBacklogItems(
      [platformBlocked],
      { core: 4, ornamental: 2 },
      { currentPhaseId: 'build' },
    )).toEqual([]);
    expect(feedbackRequiredBacklogItems(
      [platformBlocked, userBlocked],
      { core: 4, ornamental: 2 },
      { currentPhaseId: 'build' },
    )).toEqual([userBlocked]);
  });

  it('separates technical exhaustion from customer blockers in the relevant scope', () => {
    const items = [
      { id: 'review', phase_id: 'outline', status: 'needs_review' as const, attempts: 4, tier: 'core' as const },
      { id: 'exhausted', phase_id: 'outline', status: 'in_progress' as const, attempts: 4, tier: 'core' as const },
      { id: 'unrelated', phase_id: 'build', status: 'pending' as const, attempts: 0, tier: 'core' as const },
    ];

    expect(feedbackRequiredBacklogItems(
      items,
      { core: 4, ornamental: 2 },
      { currentPhaseId: 'outline' },
    )).toEqual([]);
    expect(technicalReviewBacklogItems(items, { core: 4, ornamental: 2 }, { currentPhaseId: 'outline' }))
      .toEqual([items[0], items[1]]);
  });

  it('retains user blockers from an earlier phase in terminal feedback', () => {
    const priorUserBlocked = {
      id: 'credential',
      phase_id: 'research',
      status: 'pending' as const,
      attempts: 0,
      tier: 'core' as const,
      blocked_by: [{
        blocker_id: 'user-key',
        category: 'user_decision' as const,
        reason: 'API key required.',
        resolution_actor: 'user' as const,
        user_action_required: true,
      }],
    };

    expect(feedbackRequiredBacklogItems(
      [priorUserBlocked],
      { core: 4, ornamental: 2 },
      { currentPhaseId: 'build' },
    )).toEqual([priorUserBlocked]);
  });

  it('suppresses backlog feedback while the current plan can continue', () => {
    const items = [
      { id: 'review', status: 'needs_review' as const, attempts: 4, tier: 'core' as const },
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
