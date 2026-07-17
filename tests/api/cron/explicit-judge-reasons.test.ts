import { runJudge, gateSignals } from '@/app/api/cron/shared/archetype-runner';
import { planNextHealingAction } from '@/lib/services/requirement-self-heal';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

describe('Explicit Judge Reasons', () => {
  describe('gateSignals', () => {
    it('extracts detail for failed build', () => {
      const sigs = gateSignals({ build: { command: 'npm run build', exit_code: 1, duration_ms: 100 } } as any);
      expect(sigs.build?.ok).toBe(false);
      expect(sigs.build?.detail).toBe('command="npm run build" exit_code=1');
    });

    it('extracts detail for failed runtime', () => {
      const sigs = gateSignals({ runtime: { route: '/login', http_status: 500 } } as any);
      expect(sigs.runtime?.ok).toBe(false);
      expect(sigs.runtime?.detail).toBe('route="/login" http_status=500');
    });

    it('extracts detail for failed scenarios', () => {
      const sigs = gateSignals({ 
        scenarios: [
          { name: 'Login', pass: false, duration_ms: 10 },
          { name: 'Signup', pass: true, duration_ms: 10 },
          { name: 'Logout', pass: false, duration_ms: 10 },
        ] 
      } as any);
      expect(sigs.scenarios?.ok).toBe(false);
      expect(sigs.scenarios?.detail).toBe('failed=[Login, Logout]');
    });
  });

  describe('runJudge - app gates', () => {
    const baseItem: BacklogItem = {
      id: '1', title: 'App Item', tier: 'ornamental', kind: 'app', status: 'in_progress', scope_level: 'full', acceptance: []
    } as unknown as BacklogItem;

    it('includes build detail in rejection', () => {
      const evidence = { build: { command: 'next build', exit_code: 1, duration_ms: 1 } } as any;
      const res = runJudge({ item: baseItem, evidence, flow: 'app' });
      expect(res.verdict).toBe('rejected');
      expect(res.reason).toContain('build gate failed: command="next build" exit_code=1');
      expect(res.reason).toContain('Fix the build errors');
    });
    
    it('includes runtime detail in rejection', () => {
      const evidence = { build: { exit_code: 0 }, runtime: { route: '/', http_status: 404 } } as any;
      const res = runJudge({ item: baseItem, evidence, flow: 'app' });
      expect(res.verdict).toBe('rejected');
      expect(res.reason).toContain('runtime gate failed: route="/" http_status=404');
    });
  });

  describe('runJudge - matchOrEscalate', () => {
    const baseItem: BacklogItem = {
      id: '1', title: 'App Item', tier: 'ornamental', kind: 'app', status: 'in_progress', scope_level: 'full', 
      // The keyword matcher needs exact lowercase token overlap unless we mock it, 
      // so let's mock it for the test or just use simpler inputs
      acceptance: ['User can login', 'Email is sent on success', 'User can logout']
    } as unknown as BacklogItem;

    it('includes sample unmatched criteria in rejection', () => {
      const evidence = { 
        build: { exit_code: 0 }, runtime: { http_status: 200 },
        // To force 1 match and 2 unmatched, we just provide the exact text
        tests: [{ command: 'jest', exit_code: 0, output_tail: 'User can login works', ran_after_changes: true }]
      } as any;
      const res = runJudge({ item: baseItem, evidence, flow: 'app' });
      expect(res.verdict).toBe('rejected');
      expect(res.reason).toContain('acceptance entries lack matching evidence');
      expect(res.reason).toContain('Unmatched:');
      expect(res.reason).toContain('Produce evidence');
    });
  });
  
  describe('Other Judges', () => {
    it('adds actionable Next: for doc judge', () => {
      const item: BacklogItem = { id: '1', title: 'Doc', kind: 'doc', status: 'in_progress', tier: 'ornamental', scope_level: 'full' } as unknown as BacklogItem;
      const res = runJudge({ item, evidence: { tests: [] } as any, flow: 'doc' });
      expect(res.verdict).toBe('rejected');
      expect(res.reason).toContain('Next: run a markdown/lint tool');
    });
  });

  describe('planNextHealingAction', () => {
    const baseItem: BacklogItem = {
      id: '1', title: 'App Item', tier: 'ornamental', kind: 'app', status: 'in_progress', scope_level: 'full', acceptance: []
    } as unknown as BacklogItem;

    it('incorporates explicit Next action from judge reason', () => {
      const action = planNextHealingAction({
        item: baseItem,
        attempts: 1,
        verdict: {
          verdict: 'rejected',
          reason: 'doc judge requires a lint/markdown tool call in evidence. Next: run a markdown/lint tool and keep the call in evidence.',
          matched_acceptance: [],
          unmatched_acceptance: []
        }
      });
      expect(action.kind).toBe('rotate_strategy');
      // @ts-ignore
      expect(action.hint).toContain('Keep scope');
      // @ts-ignore
      expect(action.hint).toContain('run a markdown/lint tool and keep the call in evidence.');
    });

    it('incorporates top unmatched item', () => {
      const action = planNextHealingAction({
        item: baseItem,
        attempts: 1,
        verdict: {
          verdict: 'rejected',
          reason: '2/3 acceptance entries lack matching evidence. Produce evidence (tool call / route / test) that proves those criteria.',
          matched_acceptance: [],
          unmatched_acceptance: ['Email is sent on success']
        }
      });
      // @ts-ignore
      expect(action.hint).toContain('Missing evidence for e.g. "Email is sent on success"');
      // @ts-ignore
      expect(action.hint).toContain('Produce evidence (tool call / route / test) that proves those criteria.');
    });
  });
});
