import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ownedWhatsAppSenders, planEchoSubscription, reconcileEchoSubscriptions } from '../zavu-reconcile-app-echo.mjs';

const settings = [{ site_id: 'site', channels: { connections: [
  { id: 'connection', zavu_sender_id: 'sender', type: 'whatsapp', status: 'connected' },
] } }];
const makeSender = (active = false) => ({ id: 'sender', webhook: {
  url: 'https://api.example.test/api/integrations/zavu/webhook', active,
  events: ['message.inbound', 'custom.existing'], secret: randomBytes(32).toString('hex'), signatureVersion: 'v1+v2',
} });

test('inventory ignores disconnected channels and blocks cross-tenant ownership', () => {
  assert.deepEqual(ownedWhatsAppSenders(settings), [{ senderId: 'sender', owned: true }]);
  assert.equal(ownedWhatsAppSenders([...settings, { site_id: 'other', channels: { connections: [
    { id: 'other', zavu_sender_id: 'sender', type: 'sms' },
  ] } }])[0].owned, false);
  assert.deepEqual(ownedWhatsAppSenders([{ site_id: 'site', channels: { connections: [
    { ...settings[0].channels.connections[0], status: 'disconnected' },
  ] } }]), []);
});

test('only adds message.sent, preserving event list and active false by omitting every other field', () => {
  const sender = makeSender();
  const plan = planEchoSubscription(sender, { isCoexistence: true });
  assert.deepEqual(plan.patch, { webhookEvents: ['message.inbound', 'custom.existing', 'message.sent'] });
  assert.equal(plan.status, 'add_message_sent_webhook_stays_inactive');
  sender.webhook.events.push('message.sent');
  assert.equal(planEchoSubscription(sender, {}).patch, null);
  assert.equal(planEchoSubscription(makeSender(), { isCoexistence: false }).patch, null);
  assert.equal(planEchoSubscription({ id: 'sender' }, { isCoexistence: true }).patch, null);
});

test('default dry-run reads provider and sync but never writes or logs secrets', async () => {
  const sender = makeSender();
  const username = randomBytes(12).toString('hex');
  const password = randomBytes(32).toString('hex');
  const querySecret = randomBytes(32).toString('hex');
  const url = new URL('https://hooks.example.test/webhook');
  url.username = username; url.password = password; url.searchParams.set('token', querySecret);
  sender.webhook.url = url.href;
  const calls = [], logs = [];
  await reconcileEchoSubscriptions({ settings, request: async (path, init) => {
    calls.push({ path, init }); return path.endsWith('whatsapp-sync') ? { isCoexistence: true } : { sender };
  }, report: result => logs.push(result) });
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.init === undefined));
  for (const sensitive of [sender.webhook.secret, username, password, querySecret, url.href]) {
    assert.equal(JSON.stringify(logs).includes(sensitive), false);
  }
});

test('apply only patches events, verifies configuration and does not reactivate', async () => {
  const sender = makeSender();
  const original = structuredClone(sender);
  const writes = [];
  const results = await reconcileEchoSubscriptions({ settings, apply: true, request: async (path, init) => {
    if (path.endsWith('whatsapp-sync')) return { sync: { isCoexistence: true, status: 'active' } };
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(init.body); writes.push(patch); sender.webhook.events = patch.webhookEvents;
    }
    return { sender: structuredClone(sender) };
  } });
  assert.equal(results[0].status, 'applied');
  assert.deepEqual(writes, [{ webhookEvents: [...original.webhook.events, 'message.sent'] }]);
  assert.deepEqual({ ...sender.webhook, events: original.webhook.events }, original.webhook);
});

test('apply refuses concurrent provider changes', async () => {
  const sender = makeSender(true);
  let reads = 0, writes = 0;
  const results = await reconcileEchoSubscriptions({ settings, apply: true, request: async (path, init) => {
    if (init) writes++;
    if (path.endsWith('whatsapp-sync')) return { isCoexistence: true };
    if (++reads > 1) sender.webhook.events.push('concurrent.event');
    return { sender: structuredClone(sender) };
  } });
  assert.equal(results[0].status, 'blocked_config_changed');
  assert.equal(writes, 0);
});

test('errors never log credential-bearing response bodies', async () => {
  const secret = randomBytes(32).toString('hex');
  const logs = [];
  const results = await reconcileEchoSubscriptions({ settings, apply: true,
    request: async () => { throw new Error(secret); }, report: row => logs.push(row) });
  assert.equal(results[0].status, 'request_failed_operator_review');
  assert.equal(JSON.stringify(logs).includes(secret), false);
});