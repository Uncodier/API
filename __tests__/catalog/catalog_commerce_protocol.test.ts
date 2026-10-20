import { randomUUID } from 'node:crypto';
import { catalogCommerceTool } from '@/app/api/agents/tools/catalog_commerce/assistantProtocol';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

jest.mock('@/app/api/agents/tools/utils/fetch-helper', () => ({ fetchApiTool: jest.fn() }));

beforeEach(() => jest.resetAllMocks());

it('binds search to current site without changing user intent or exact codes', async () => {
  const siteId = randomUUID();
  const searchId = randomUUID();
  await catalogCommerceTool(siteId).execute({ action: 'list', search: 'Need a quiet fan ACME-42',
    search_id: searchId, limit: 10, offset: 10 });
  expect(fetchApiTool).toHaveBeenCalledWith('/api/agents/tools/catalog_commerce', {
    action: 'list', resource: 'item', site_id: siteId, search: 'Need a quiet fan ACME-42',
    search_id: searchId, limit: 10, offset: 10,
  }, expect.any(String));
});

it.each(['item', 'tax', 'modifier_group', 'item_spec'] as const)(
  'rejects site overrides for %s before fetching', async resource => {
    await expect(catalogCommerceTool(randomUUID()).execute({ action: 'list', resource, site_id: randomUUID() }))
      .rejects.toThrow('current site context');
    expect(fetchApiTool).not.toHaveBeenCalled();
  },
);

it('requires item list context but permits a matching explicit site', async () => {
  await expect(catalogCommerceTool().execute({ action: 'list', search: 'Corte' })).rejects.toThrow('site_id');
  const siteId = randomUUID();
  await catalogCommerceTool(siteId).execute({ action: 'list', site_id: siteId });
  expect(fetchApiTool).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ site_id: siteId }), expect.any(String));
});

it('documents meaningful intent, exact codes, candidate windows and pagination continuity', () => {
  const properties = catalogCommerceTool().parameters.properties;
  expect(properties.search.description).toContain('Preserve meaningful intent and exact codes');
  expect(properties.search.description).toContain('candidate-window');
  expect(properties.search_id.description).toContain('has_more');
  expect(properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
});