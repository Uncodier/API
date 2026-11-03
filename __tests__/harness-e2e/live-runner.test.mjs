import test from 'node:test';
import assert from 'node:assert/strict';
import { options, withinBudget } from '../../scripts/harness-live/run.mjs';

test('live runner requires an explicit isolated run and live acknowledgement', () => {
  assert.deepEqual(options(['run', 'live-app-20261103-01', '--ack-live-test']), { mode: 'run', id: 'live-app-20261103-01' });
  assert.equal(options(['run', 'live-app-20261103-cart', '--ack-live-test', '--case', 'quantity-subtotal']).selectedCase, 'quantity-subtotal');
  for (const args of [[], ['run'], ['run', 'live-app-20261103-01'], ['run', '../customer', '--ack-live-test'],
    ['deploy', 'live-app-20261103-01', '--ack-live-test'], ['run', 'live-app-20261103-01', '--ack-live-test', '--skip-verification']]) {
    assert.throws(() => options(args));
  }
});
test('queue and execution deadlines remain separate and never bypass global credit limits', () => {
  const start = Date.parse('2026-11-03T00:00:00Z');
  const run = { startedAt: new Date(start).toISOString(), maxCredits: 12,
    admissionDeadlineMs: 1200000, executionDeadlineMs: 600000, totalDeadlineMs: 2700000 };
  const spec = { startedAt: run.startedAt };
  assert.equal(withinBudget(run, spec, start + 900000, 2), true);
  assert.equal(withinBudget(run, spec, start + 1200001, 2), false);
  spec.executionObservedAt = new Date(start + 900000).toISOString();
  assert.equal(withinBudget(run, spec, start + 1400000, 2), true);
  assert.equal(withinBudget(run, spec, start + 1500001, 2), false);
  assert.equal(withinBudget(run, spec, start + 1000000, 12), false);
  assert.equal(withinBudget(run, spec, start + 1000000, NaN), false);
  spec.executionObservedAt = new Date(start + 2400000).toISOString();
  assert.equal(withinBudget(run, spec, start + 2700001, 2), false);
});