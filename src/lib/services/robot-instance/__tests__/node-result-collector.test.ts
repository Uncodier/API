import { randomUUID } from 'node:crypto';
import { buildNodeResult } from '../node-result-collector';

it.each([
  ['content', 'content', 'content'], ['leads', 'lead', 'lead'], ['catalog_commerce', 'item', 'catalog_item'],
])('persists a typed identity from routed %s results for the next node', (tool, key, entity) => {
  const row = { id: randomUUID(), site_id: randomUUID(), name: 'QA Fixture', title: 'QA Content',
    created_at: '2026-10-06T00:11:57Z', metadata: { qa_fixture: 'offline-only' } };
  const result = buildNodeResult('Elemento seleccionado', 'done', [{ toolResults: [{ toolName: 'tools',
    result: { success: true, name: tool, result: { success: true, [key]: row } } }] }]);
  expect(result.outputs).toEqual([{ tool_name: tool, type: 'data', data: {
    entity, id: row.id, site_id: row.site_id, name: entity === 'content' ? row.title : row.name,
    created_at: row.created_at,
  } }]);
  expect(JSON.stringify(result)).not.toContain('offline-only');
});

it('keeps all list candidates as references, without declaring the first or newest one selected', () => {
  const rows = Array.from({ length: 2 }, (_, index) => ({ id: randomUUID(), name: `Lead ${index}`, site_id: randomUUID() }));
  const result = buildNodeResult('Dos candidatos', 'done', [{ toolResults: [{ toolName: 'leads',
    result: { success: true, data: { leads: rows, pagination: { count: 2 } } } }] }]);
  expect(result.outputs?.map(output => output.data.id)).toEqual(rows.map(row => row.id));
  expect(result.outputs?.every(output => output.data.entity === 'lead')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('selected');
});

it('never collects failed results or non-item catalog resources as entity references', () => {
  const row = { id: randomUUID(), name: 'Not a catalog item' };
  const result = buildNodeResult('Failed', 'done', [{ toolResults: [
    { toolName: 'content', result: { success: false, content: row } },
    { toolName: 'leads', isError: true, result: { success: true, lead: row } },
    { toolName: 'tools', result: { success: false, name: 'catalog_commerce', result: { success: true, item: row } } },
    { toolName: 'catalog_commerce', result: { success: true, modifier_group: row } },
  ] }]);
  expect(result.outputs).toBeUndefined();
});