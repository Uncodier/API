import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { cloudCases, cloudContractReport, runCloudContracts } from '../../scripts/harness-cloud-contracts.mjs';

test('covers search, writes, reads, replacement, patching and stale-version conflict', () => {
  assert.equal(cloudCases.length, 6);
  assert.equal(new Set(cloudCases.map(spec => spec.id)).size, 6);
  assert.deepEqual(cloudCases.map(spec => spec.operation), ['search', 'search', 'create_read', 'replace_read', 'patch_read', 'conflict']);
  for (const spec of cloudCases) {
    assert.equal(spec.source, 'cloud');
    assert.equal(spec.requiresSandbox, false);
    assert.equal(spec.requiresRequirement, false);
    assert.equal(spec.requiresRepository, false);
    for (const assertion of ['zero_sandbox_provider_calls', 'no_workspace_fallback', 'trusted_actor_scope']) assert.ok(spec.assertions.includes(assertion));
    assert.ok(spec.blocker.endsWith('NOT_IMPLEMENTED'));
  }
});

test('read-after-write contracts demand exact independent UTF-8 hashes and byte lengths', () => {
  for (const spec of cloudCases.filter(spec => spec.expected)) {
    const text = spec.operation === 'create_read' ? '# Cloud note\nInitial text.\n' : '# Cloud note\nUpdated text.\n';
    assert.equal(spec.expected.sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(spec.expected.bytes, Buffer.byteLength(text, 'utf8'));
    assert.ok(spec.assertions.includes('independent_storage_bytes'));
  }
});

test('unimplemented capabilities are blocked, not skipped, executed or passed', () => {
  const report = cloudContractReport();
  assert.equal(report.state, 'blocked');
  assert.equal(report.healthGreen, false);
  assert.equal(report.behaviorPassed, false);
  assert.equal(report.liveExecution, false);
  for (const result of report.cases) {
    assert.equal(result.state, 'blocked');
    assert.equal(result.executed, false);
    assert.equal(result.reason, result.blocker);
  }
  assert.equal(runCloudContracts().exitCode, 2);
  assert.equal(runCloudContracts(['list']).exitCode, 0);
  assert.throws(() => runCloudContracts(['run']), /Supported/);
  assert.throws(() => runCloudContracts(['report', '--ack-production-canary']), /Supported/);
});

test('real CLI reports blocked with a nonzero exit instead of a green live-test result', () => {
  const result = spawnSync(process.execPath, [new URL('../../scripts/harness-cloud-contracts.mjs', import.meta.url).pathname, 'report'],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000 });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthGreen, false);
  assert.equal(report.cases.length, 6);
  assert.ok(report.cases.every(spec => spec.state === 'blocked'));
});