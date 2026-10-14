import { randomBytes, randomUUID } from 'node:crypto';
import { progressReceipt } from '../requirement-progress-receipt';

it('uses atomic statuses and counts, never requested state or untrusted provider metadata', () => {
  const secret = randomBytes(24).toString('hex');
  const result = progressReceipt({ state: 'updated', status_changed: true, message_recorded: false, plan_id: randomUUID(),
    plan_status: 'pending', step_id: 'step', step_status: 'completed', item_id: 'item', item_status: 'done',
    plan_steps_total: 100, plan_steps_completed: 3, backlog_items_total: 80, backlog_items_completed: 2,
    message: secret, metadata: { token: secret }, env: { secret }, requirement_status: secret });
  expect(result.plan).toMatchObject({ status: 'pending', stepsCompleted: 3, stepsTotal: 100 });
  expect(result.availableAction).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(secret);
});
it('does not infer a closure opportunity from absent, malformed or partial counts', () => {
  for (const completed of [null, undefined, '2', NaN, -1]) {
    const result = progressReceipt({ state: 'unchanged', status_changed: false, plan_id: randomUUID(), plan_status: 'pending', plan_steps_total: 2, plan_steps_completed: completed });
    expect(result.availableAction).toBeUndefined();
  }
});
it('never suggests resuming paused plans and allows explicit partial task completion', () => {
  for (const state of ['paused', 'cancelled']) {
    const result = progressReceipt({ state: 'unchanged', status_changed: false, plan_id: randomUUID(), plan_status: state, plan_steps_total: 2, plan_steps_completed: 2 });
    expect(result.availableAction).toBeUndefined();
  }
  const result = progressReceipt({ state: 'updated', status_changed: true, plan_id: randomUUID(), plan_status: 'completed', plan_steps_total: 2, plan_steps_completed: 1 });
  expect(result.guidance).toContain('finish_task');
});
it('degrades honestly if the old database has not returned detailed receipts', () => {
  expect(progressReceipt({ state: 'updated', backlog_revision: 1 })).toMatchObject({ state: 'updated', currentStateAvailable: false });
  expect(progressReceipt({ state: 'updated' }).guidance).toContain('do not infer');
});
it('drops credential-shaped values supplied in allowed fields', () => {
  const secret = randomBytes(24).toString('hex');
  const result = progressReceipt({ state: 'updated', status_changed: true, plan_id: secret, plan_status: secret,
    step_status: secret, item_status: secret, plan_steps_total: secret });
  expect(JSON.stringify(result)).not.toContain(secret);
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: randomBytes(16).toString('hex') })).toString('base64url'), randomBytes(32).toString('base64url')].join('.');
  for (const id of [`secret:${secret}`, token]) {
    const receipt = progressReceipt({ state: 'unchanged', status_changed: false, step_id: id, item_id: id, step_status: 'completed', item_status: 'done' });
    expect(receipt.step).toBeUndefined(); expect(receipt.item).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain(secret); expect(JSON.stringify(receipt)).not.toContain(token);
  }
});
it('message-only receipts do not claim that a status was requested', () => {
  const result = progressReceipt({ state: 'unchanged', status_changed: false, message_recorded: true });
  expect(result.guidance).toContain('No status target was changed');
  expect(result.guidance).not.toContain('already match');
});