import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helpers = { exports: {}, URL };
vm.runInNewContext(compile(readFileSync(`${root}_utils/details.ts`, 'utf8')), helpers);
const { notificationMessage, emailAction, emailMarkdownLinks } = helpers.exports;
const routes = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('_')).map(entry => entry.name).sort();
const emitters = ['dailyStandUp', 'leadAssignment', 'newCampaigns', 'newContent', 'newInboundMessage', 'newLeadsAlert', 'projectAnalysis', 'taskCommentReminder', 'taskStatus'];
const long = 'Full detail line\n'.repeat(100) + 'END OF FULL DETAILS';
const entity = { id: 'entity-id', name: 'Lead Name', title: 'Title', description: long, email: 'lead@example.invalid', phone: '+123', company: { name: 'Company', description: long }, status: 'pending', origin: 'website', segments: [{ name: 'Segment' }], type: 'finding', impact: 'high', affected_area: 'targeting', priority: 'high', created_at: '2026-01-01', due_date: '2026-02-01', budget: 0, revenue: 2, word_count: 123, estimated_reading_time: 4 };
const facts = {
  notificationMessage, emailAction, site_id: 'site-id', siteId: 'site-id', lead_id: 'lead-id', task_id: 'task-id', conversation_id: 'conversation-id',
  siteInfo: { name: 'Site Name' }, leadInfo: { ...entity, site_id: 'site-id' }, leadName: 'Lead Name', leadContact: entity.email,
  assignee_id: 'assignee-id', assigneeInfo: { name: 'Assignee', email: 'assignee@example.invalid' }, taskInfo: entity,
  message: long, brief: long, next_steps: ['Call lead', long], priority: 'high', status: 'pending', due_date: '2026-02-01',
  leadCompanyName: 'Company', additional_context: long, additional_data: { detail: long }, businessAssessment: long,
  analysisData: { analysisSummary: long, siteName: 'Site Name', analysisType: 'profile', impactLevel: 'high' }, insights: [entity],
  newCampaigns: [entity], newContent: [entity], unassignedLeads: [entity], campaign_status: 'pending', content_status: 'draft', days_since_created: 7,
  include_campaign_details: true, include_content_details: true, include_lead_details: true, hours_until_auto_prospect: 24,
  primaryCta: { title: 'Act', url: 'https://example.invalid/action' }, reminderContext: long,
  subject: 'Daily Summary', notificationType: 'info', notification_type: 'task_status', formatLeadOrigin: value => value,
  NotificationType: { INFO: 'info', WARNING: 'warning' }, NotificationCategory: { TASKS_REMINDERS: 'tasks', ANALYSIS_INSIGHTS: 'analysis', HUMAN_INTERVENTION: 'human', LEAD_MANAGEMENT: 'leads' }
};

function emitterArguments(name) {
  const source = readFileSync(`${root}${name}/route.ts`, 'utf8');
  const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  const args = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'TeamNotificationService.notifyTeam') args.push(node.arguments[0].getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return args;
}

test('audit inventory covers all 16 routes and only the 9 existing in-app emitters', () => {
  assert.equal(routes.length, 16);
  assert.deepEqual(routes.filter(name => emitterArguments(name).length), emitters);
  for (const name of emitters) assert.equal(emitterArguments(name).length, 1, name);
});

for (const name of emitters) {
  test(`${name}: evaluate actual emitter arguments offline, complete message and entity pair`, () => {
    const payload = vm.runInNewContext(compile(`const payload = ${emitterArguments(name)[0]}; payload;`), { ...facts });
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.includes('END OF FULL DETAILS'), name);
    assert.ok(!payload.message.includes('[object Object]'));
    const expectedType = name === 'newInboundMessage' ? 'conversation' : name.startsWith('task') ? 'task' : name === 'leadAssignment' ? 'lead' : 'site';
    assert.equal(payload.relatedEntityType, expectedType);
    assert.equal(payload.relatedEntityId, expectedType === 'conversation' ? facts.conversation_id : expectedType === 'task' ? facts.task_id : expectedType === 'lead' ? facts.lead_id : facts.site_id);
    assert.equal(typeof payload.buildEmail, 'function');
    const listActions = { dailyStandUp: '/dashboard', projectAnalysis: '/dashboard', newCampaigns: '/campaigns', newContent: '/content', newLeadsAlert: '/leads' };
    assert.equal(payload.actionUrl, listActions[name]);
    assert.ok(!('details' in payload));
    assert.ok(!('body' in payload));
  });
}

test('taskStatus without task targets lead instead of masquerading as a task', () => {
  const payload = vm.runInNewContext(compile(`const payload = ${emitterArguments('taskStatus')[0]}; payload;`), { ...facts, task_id: undefined, taskInfo: null });
  assert.equal(payload.relatedEntityType, 'lead');
  assert.equal(payload.relatedEntityId, facts.lead_id);
});

test('batch include-details flags are respected without inventing recipients', () => {
  for (const name of ['newCampaigns', 'newContent', 'newLeadsAlert']) {
    const payload = vm.runInNewContext(compile(`const payload = ${emitterArguments(name)[0]}; payload;`), { ...facts, include_campaign_details: false, include_content_details: false, include_lead_details: false });
    assert.ok(!payload.message.includes('END OF FULL DETAILS'));
    assert.ok(payload.message.includes('Site Name'));
  }
});

test('plaintext details preserve long strings, multiline, structured facts and zero', () => {
  const message = notificationMessage('Summary', [['Text', long], ['Zero', 0], ['Nested', { next: ['a', 'b'] }], ['Empty', null]]);
  assert.ok(message.includes(long));
  assert.ok(message.includes('Zero: 0'));
  assert.ok(message.includes('"next"'));
  assert.ok(!message.includes('Empty'));
});

test('email primary CTA preserves valid actions and safely falls back for missing/invalid URLs', () => {
  const fallback = 'https://example.invalid/control-center/task';
  for (const value of [undefined, '', 'javascript:alert(1)', 'not-a-url']) {
    assert.equal(emailAction({ url: value }, fallback).url, fallback);
  }
  assert.equal(emailAction({ title: 'Respond', url: 'https://example.invalid/action' }, fallback).url, 'https://example.invalid/action');
  assert.equal(emailAction({ url: '', link: 'mailto:lead@example.invalid' }, fallback).url, 'mailto:lead@example.invalid');
});

test('fixed email CTA destinations match existing frontend routes', () => {
  const source = name => readFileSync(`${root}${name}/route.ts`, 'utf8');
  assert.match(source('newInboundMessage'), /chat\?conversationId=/);
  for (const name of ['agentmailQuotaError', 'emailSyncFailure', 'channelsSetupRequired']) {
    assert.match(source(name), /settings\?tab=channels/);
    assert.ok(!source(name).includes('/settings/channels'));
  }
  for (const name of ['agentmailQuotaError', 'emailSyncFailure']) {
    assert.match(source(name), /const supportUrl = `mailto:/);
    assert.ok(!source(name).includes('`${baseUrl}/support`'));
  }
});

for (const [name, renderer] of [['taskReminder', 'generateTaskReminderHtml'], ['reservationReminder', 'generateReservationHtml'], ['subscriptionRenewal', 'generateSubscriptionHtml']]) {
  test(`${name}: execute email-only renderer, preserve caller CTA and reject unsafe links`, () => {
    const source = readFileSync(`${root}${name}/route.ts`, 'utf8');
    const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && [renderer, 'getCompanyName', 'getBrandingText'].includes(node.name.text)).map(node => node.getText(ast)).join('\n');
    const html = vm.runInNewContext(compile(`${functions}\n${renderer}(data);`), {
      emailMarkdownLinks, process: { env: {} }, data: { siteName: 'Site', subject: 'Reminder', locale: 'en', message: `${long}\n[Act](https://example.invalid/action)\n[Unsafe](javascript:bad)` }
    });
    assert.ok(html.includes('END OF FULL DETAILS'));
    assert.ok(html.includes('href="https://example.invalid/action"'));
    assert.ok(!html.includes('href="javascript:'));
    assert.match(source, /emailMarkdownLinks\(formattedMessage\)/);
    assert.equal(emitterArguments(name).length, 0);
  });
}

test('caller markdown links escape attribute values without changing valid destinations', () => {
  const html = emailMarkdownLinks('[Act](https://example.invalid/action?one=1&two=2)');
  assert.ok(html.includes('href="https://example.invalid/action?one=1&amp;two=2"'));
  assert.ok(!emailMarkdownLinks('[Act](invalid)').includes('<a '));
});