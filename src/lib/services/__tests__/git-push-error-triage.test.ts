import { extractConflictFiles, triageGitPushError } from '../git-push-error-triage';

describe('triageGitPushError', () => {
  it('marks auth as not agent-actionable with ops message', () => {
    const t = triageGitPushError('remote: HTTP Basic: Access denied\nfatal: authentication failed');
    expect(t.failureKind).toBe('auth');
    expect(t.agentActionable).toBe(false);
    expect(t.agentMessage).toContain('escalate');
  });

  it('marks protected branch as not agent-actionable', () => {
    const t = triageGitPushError('remote: error: GH013: protected branch');
    expect(t.failureKind).toBe('protected_branch');
    expect(t.agentActionable).toBe(false);
  });

  it('marks network as not agent-actionable', () => {
    const t = triageGitPushError('fatal: could not resolve host github.com');
    expect(t.failureKind).toBe('network');
    expect(t.agentActionable).toBe(false);
  });

  it('extracts a single CONFLICT line', () => {
    expect(extractConflictFiles('CONFLICT (content): Merge conflict in only.md')).toEqual(['only.md']);
  });

  it('includes conflict file names in agent message for rebase_conflict', () => {
    const long = `Rebasing (1/1)
CONFLICT (content): Merge conflict in progress.md
CONFLICT (content): Merge conflict in feature_list.json
Automatic merge failed; fix conflicts and then commit the result.`;
    const t = triageGitPushError(long);
    expect(t.failureKind).toBe('rebase_conflict');
    expect(t.agentActionable).toBe(true);
    expect(t.agentMessage).toContain('progress.md');
    expect(t.agentMessage).toContain('feature_list.json');
    expect(t.operatorMessage.length).toBeGreaterThan(10);
  });

  it('treats resolve-index as agent-actionable with hint', () => {
    const t = triageGitPushError('error: You need to resolve your current index first');
    expect(t.failureKind).toBe('attach_index');
    expect(t.agentActionable).toBe(true);
    expect(t.agentMessage).toMatch(/git status|rebase/);
  });

  it('treats invalid ref as agent-actionable', () => {
    const t = triageGitPushError('not a full refname: HEAD');
    expect(t.failureKind).toBe('invalid_ref');
    expect(t.agentActionable).toBe(true);
  });

  it('classifies automatic rebase with could not apply as rebase_conflict, not non_fast_forward', () => {
    const msg = `Failed to push branch feature/req-fa9f1eb3: Push rejected and automatic rebase on origin/feature/req-fa9f1eb3 produced conflicts — manual resolution required: Rebasing (1/5) error: could not apply 525f41ce... [checkpoint] hint: Resolve all conflicts manually`;
    const t = triageGitPushError(msg);
    expect(t.failureKind).toBe('rebase_conflict');
    expect(t.agentActionable).toBe(true);
    expect(t.agentMessage).toMatch(/Rebase|conflict|rebase/);
  });
});
