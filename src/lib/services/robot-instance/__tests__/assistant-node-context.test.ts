import { randomUUID } from 'node:crypto';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { buildNodeResult } from '../node-result-collector';

function setup(result: unknown, type = 'response') {
  const siteId = randomUUID();
  const instanceId = randomUUID();
  const target = { id: randomUUID(), site_id: siteId, instance_id: instanceId };
  const linked = { id: randomUUID(), site_id: siteId, instance_id: instanceId, type,
    created_at: '2026-10-06T00:11:57Z', status: 'completed', result,
    prompt: { text: 'PROMPT_ONLY', attachments: ['https://example.invalid/prompt.png'] } };
  const query: any = {};
  for (const method of ['select', 'eq']) query[method] = () => query;
  query.single = async () => ({ data: target, error: null });
  const fetchNodeContexts = jest.fn().mockResolvedValue([{ context_node_id: linked.id, type, node: linked }]);
  const module = loadRuntimeModule<typeof import('../assistant-node-context')>(
    'src/lib/services/robot-instance/assistant-node-context.ts', {
      '@/lib/database/supabase-client': { supabaseAdmin: { from: () => query } },
      './assistant-logging': { fetchNodeContexts },
    },
  );
  return { module, linked, target, fetchNodeContexts,
    options: { instance_node_id: target.id, instance_id: instanceId, site_id: siteId } };
}

it.each([false, true])('preserves text plus structured entity identities in linked results (serialized=%s)', async serialized => {
  const entities = ['content', 'lead', 'catalog_item'].map(entity => ({ entity, id: randomUUID(),
    site_id: randomUUID(), name: `QA ${entity}` }));
  const result = { text: 'Estos son los tres elementos de QA', status: 'done',
    outputs: entities.map(data => ({ type: 'data', tool_name: 'lookup', data })) };
  const h = setup(serialized ? JSON.stringify(result) : result);
  const prepared = await h.module.prepareNodeExecutionContext([{ role: 'user', content: 'Cambia ese producto' }], '', h.options);
  const text = JSON.stringify(prepared.messages);
  for (const entity of entities) expect(text).toContain(entity.id);
  expect(text).toContain(h.linked.id);
  expect(text).toContain(h.linked.created_at);
  expect(text).toContain('Estos son los tres elementos');
  expect(text).not.toContain('PROMPT_ONLY');
  expect(text).not.toContain('prompt.png');
  expect(prepared.messages.at(-1).content).toBe('Cambia ese producto');
});

it('does not mix the result image into a prompt-only linked reference', async () => {
  const h = setup({ text: 'RESULT_ONLY', outputs: [{ type: 'image', data: { url: 'https://example.invalid/result.png' } }] }, 'prompt');
  const prepared = await h.module.prepareNodeExecutionContext([{ role: 'user', content: 'Usa ese prompt' }], '', h.options);
  const text = JSON.stringify(prepared.messages);
  expect(text).toContain('PROMPT_ONLY');
  expect(text).toContain('prompt.png');
  expect(text).not.toContain('RESULT_ONLY');
  expect(text).not.toContain('result.png');
});

it('keeps a plain conversation unchanged and does not query any linked node', async () => {
  const h = setup({ text: 'NODE_RESULT' });
  const messages = [{ role: 'user', content: '¿Cuál es el último producto?' }];
  const prepared = await h.module.prepareNodeExecutionContext(messages, 'Conversation history', {
    instance_id: h.options.instance_id, site_id: h.options.site_id,
  });
  expect(prepared.messages).toBe(messages);
  expect(prepared.systemPrompt).toBe('Conversation history');
  expect(h.fetchNodeContexts).not.toHaveBeenCalled();
});

it('round-trips routed content, lead and catalog results through storage into the next node context', async () => {
  const siteId = randomUUID();
  const rows = [
    { entity: 'content', tool: 'content', key: 'content', row: { id: randomUUID(), site_id: siteId, title: 'QA Content' } },
    { entity: 'lead', tool: 'leads', key: 'lead', row: { id: randomUUID(), site_id: siteId, name: 'QA Lead' } },
    { entity: 'catalog_item', tool: 'catalog_commerce', key: 'item', row: { id: randomUUID(), site_id: siteId, name: 'QA Product' } },
  ];
  const result = buildNodeResult('Usaremos QA Product, no QA Lead', 'done', [{ toolResults: rows.map(item => ({
    toolName: 'tools', result: { success: true, name: item.tool, result: { success: true, [item.key]: item.row } },
  })) }]);
  const h = setup(JSON.stringify(result));
  const prepared = await h.module.prepareNodeExecutionContext([{ role: 'user', content: 'Actualiza ese producto' }], '', h.options);
  const references = prepared.messages[0].content;
  for (const item of rows) {
    expect(references).toContain(item.row.id);
    expect(references).toContain(`"entity":"${item.entity}"`);
  }
  expect(references).toContain('Usaremos QA Product, no QA Lead');
  expect(prepared.messages.at(-1).content).toBe('Actualiza ese producto');
});