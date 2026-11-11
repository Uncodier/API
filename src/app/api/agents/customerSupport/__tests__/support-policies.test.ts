import { getCustomerSupportPolicies, getTaskDeduplicationPolicy, TASK_DEDUPLICATION_KEY_DESCRIPTION } from '../support-policies';
import { tasksTool } from '../../tools/tasks/assistantProtocol';
import { getTaskCore } from '../../tools/tasks/get/core';
import { fetchApiTool } from '../../tools/utils/fetch-helper';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

jest.mock('../../tools/tasks/get/core', () => ({ getTaskCore: jest.fn() }));
jest.mock('../../tools/utils/fetch-helper', () => ({ fetchApiTool: jest.fn() }));

describe('getCustomerSupportPolicies', () => {
  const policies = getCustomerSupportPolicies();

  it('requires looking up the lead record before booking', () => {
    expect(policies).toContain('LEAD RECORD VERIFICATION');
    expect(policies).toContain('orders, appointments, reservations, and meeting tasks');
    expect(policies).toContain('do NOT create another');
  });

  it('requires a successful unfiltered paginated lookup of both open statuses before creating', () => {
    expect(policies).toContain(getTaskDeduplicationPolicy());
    for (const rule of ['BEFORE every CREATE_TASK', 'Omit title/search and type filters',
      'pending and in_progress', 'pagination.has_more=false', 'offset by the returned count',
      'any page cannot be verified, do NOT CREATE_TASK', 'never treat a failed lookup as an empty result']) {
      expect(policies).toContain(rule);
    }
    expect(policies).not.toContain('GET_TASKS type=meeting');
  });

  it('updates the same underlying need across paraphrases and retains existing information', () => {
    for (const rule of ['underlying need', 'order/study ID', 'use UPDATE_TASK with its task_id',
      'title is paraphrased', 'existing task has no deduplication_key',
      'Preserve existing description, notes, commitments, dates, assignee', 'merge new facts without erasing history']) {
      expect(policies).toContain(rule);
    }
  });

  it('keeps stable issue identity separate from mutable titles and distinct issues', () => {
    expect(policies).toContain(TASK_DEDUPLICATION_KEY_DESCRIPTION);
    for (const rule of ['reused across turns, retries and paraphrased titles', 'Include the order/study ID',
      'different keys for legitimately distinct issues', 'without overwriting', 'only conservative content identity',
      'never retry CREATE_TASK with a new key to bypass reuse']) {
      expect(policies).toContain(rule);
    }
  });

  it('treats later confirmation as not a new booking', () => {
    expect(policies).toContain('NEVER call scheduling.schedule or reservations.create again');
    expect(policies).toContain('scheduling action="update"');
    expect(policies).toContain('reservations.update');
  });

  it('requires looking up promotions before answering about discounts', () => {
    expect(policies).toContain('PROMOTIONS');
    expect(policies).toContain('promotions.list');
    expect(policies).toContain('Do not invent a promotion');
    expect(policies).toContain('automatically apply the best compatible');
    expect(policies).toContain('Tell the customer the discounted total only when the tool result');
  });

  it('requires catalog lookup for price questions and retry when list is empty', () => {
    expect(policies).toContain('price/cost');
    expect(policies).toContain('catalog_commerce action="list"');
    expect(policies).toContain('Do not use limit=1');
    expect(policies).toContain('retry immediately with a shorter term');
    expect(policies).toContain('never invent a price');
  });

  it('preserves product intent, constraints and exact identifiers for hybrid search', () => {
    expect(policies).toContain('meaningful attributes and negations');
    expect(policies).toContain('exact SKU/code');
    expect(policies).toContain('sin azúcar');
    expect(policies).toContain('candidate_window');
    expect(policies).toContain('degraded=true');
    expect(policies).toContain('result_kind="related"');
    expect(policies).toContain('not confirmed matches');
  });

  it('books catalog capacity via reservations.create then payment link, not a second create_order', () => {
    expect(policies).toContain('THEN reservations.create (creates the pending sale_order)');
    expect(policies).toContain('never invent a function named reservations.create');
    expect(policies).toContain('never send catalog_item_id="unknown"');
    expect(policies).toContain('Do not assume a day has free slots');
    expect(policies).toContain('Do not also call checkout.create_order for that same slot');
    expect(policies).toContain('checkout.create_payment_link');
  });

  it('treats parent availability as the source of truth for variants', () => {
    expect(policies).toContain('Variants (child items) inherit their parent\'s availability');
    expect(policies).toContain('MUST NOT offer or book its variants');
  });
});

describe('tasks wrapper deduplication contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exposes optional issue identity, pagination and completion/archive flags', () => {
    const tool = tasksTool('site-1', 'user-1');
    expect(tool.description).toContain(getTaskDeduplicationPolicy());
    expect(tool.parameters.properties.deduplication_key).toEqual({
      type: 'string', description: TASK_DEDUPLICATION_KEY_DESCRIPTION,
    });
    expect(tool.parameters.required).not.toContain('deduplication_key');
    expect(tool.parameters.properties.include_completed.type).toBe('boolean');
    expect(tool.parameters.properties.include_archived.type).toBe('boolean');
    expect(tool.parameters.properties.offset.type).toBe('number');
  });

  it('forwards the stable key on create and returns reuse results without silently updating', async () => {
    const result = { success: true, reused: true, task: { id: 'task-1', notes: 'Original notes' } };
    (fetchApiTool as jest.Mock).mockResolvedValue(result);
    const tool = tasksTool('site-1', 'user-1');
    const args = { action: 'create' as const, lead_id: 'lead-1', title: 'Review results', type: 'support',
      deduplication_key: 'study-42-results' };
    expect(await tool.execute(args)).toBe(result);
    expect(fetchApiTool).toHaveBeenCalledTimes(1);
    expect(fetchApiTool).toHaveBeenCalledWith('/api/agents/tools/tasks/create',
      expect.objectContaining({ deduplication_key: args.deduplication_key, site_id: 'site-1' }), 'Create task failed');
  });

  it('does not auto-filter a lead list by the agent user and forwards pagination flags', async () => {
    await tasksTool('site-1', 'agent-user').execute({ action: 'list', lead_id: 'lead-1',
      include_completed: false, include_archived: false, limit: 100, offset: 100 });
    expect(getTaskCore).toHaveBeenCalledWith(expect.objectContaining({
      site_id: 'site-1', lead_id: 'lead-1', user_id: undefined,
      include_completed: false, include_archived: false, limit: 100, offset: 100,
    }));
  });

  it('preserves explicit user filters and personal-list defaults', async () => {
    const tool = tasksTool('site-1', 'agent-user');
    await tool.execute({ action: 'list', lead_id: 'lead-1', user_id: 'explicit-user' });
    expect(getTaskCore).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 'explicit-user' }));
    await tool.execute({ action: 'list' });
    expect(getTaskCore).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 'agent-user' }));
  });

  it('propagates lookup failures rather than returning an empty success or creating a task', async () => {
    (getTaskCore as jest.Mock).mockRejectedValueOnce(new Error('Lookup failed'));
    await expect(tasksTool('site-1').execute({ action: 'list', lead_id: 'lead-1' })).rejects.toThrow('Lookup failed');
    expect(fetchApiTool).not.toHaveBeenCalled();
  });
});

describe('agent task schema contracts', () => {
  // Inspect the actual inline schemas without booting Sales processors or native
  // commerce tools. These declarations must survive strict argument validation.
  it.each([
    'src/lib/services/customer-support-tool-catalog.ts',
    'src/app/api/agents/sales/message/route.ts',
  ])('requires stable identity and exposes usable pagination in %s', relativePath => {
    const source = readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
    const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
    const tools = new Map<string, ts.ObjectLiteralExpression>();
    const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression => {
      const member = object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === name);
      if (!member || !ts.isPropertyAssignment(member)) throw new Error(`Missing ${name}`);
      return member.initializer;
    };
    const walk = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const name = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'name');
        if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer)) {
          tools.set(name.initializer.text, node);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
    const createSchema = property(tools.get('CREATE_TASK')!, 'parameters') as ts.ObjectLiteralExpression;
    const createProperties = property(createSchema, 'properties') as ts.ObjectLiteralExpression;
    const key = property(createProperties, 'deduplication_key') as ts.ObjectLiteralExpression;
    expect((property(key, 'type') as ts.StringLiteral).text).toBe('string');
    expect(property(key, 'description').getText(ast)).toBe('TASK_DEDUPLICATION_KEY_DESCRIPTION');
    const required = property(createSchema, 'required') as ts.ArrayLiteralExpression;
    expect(required.elements.map(p => (p as ts.StringLiteral).text)).toContain('deduplication_key');
    const listSchema = property(tools.get('GET_TASKS')!, 'parameters') as ts.ObjectLiteralExpression;
    const listProperties = property(listSchema, 'properties') as ts.ObjectLiteralExpression;
    for (const [name, type] of [['offset', 'integer'], ['include_completed', 'boolean'], ['include_archived', 'boolean']]) {
      const field = property(listProperties, name) as ts.ObjectLiteralExpression;
      expect((property(field, 'type') as ts.StringLiteral).text).toBe(type);
    }
    if (relativePath.includes('/sales/')) {
      expect(source).toContain('contextMessage += getTaskDeduplicationPolicy()');
    }
  });
});
