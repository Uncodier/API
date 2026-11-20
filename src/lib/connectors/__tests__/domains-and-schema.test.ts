import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONNECTOR_DOMAINS, getDomainSkills, getToolkitDomains, expandDomainQuery } from '../domains';
import { searchSkillsByKeywords } from '@/lib/services/skill-keyword-search';
import { assertSupportedSchema, validateConnectorInput } from '../schema-validation';
import { SkillsService } from '@/lib/services/skills-service';

jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));

test('all bundled skill mappings resolve and unknown categories have an explicit gap', () => {
  expect(new Set(CONNECTOR_DOMAINS.map(domain => domain.id)).size).toBe(CONNECTOR_DOMAINS.length);
  for (const slug of getDomainSkills(CONNECTOR_DOMAINS.map(domain => domain.id))) {
    expect(existsSync(path.resolve('src/skills', slug, 'SKILL.md'))).toBe(true);
  }
  expect(getToolkitDomains('unknown', ['Never Reviewed'])).toEqual([]);
  expect(getToolkitDomains('gmail', ['Finance & Accounting'])).toEqual(['communication']);
  expect(getToolkitDomains('new-toolkit', ['HR & Recruiting'])).toEqual(['hr']);
  expect(getDomainSkills(['hr', 'support'])).toEqual([]);
  expect(expandDomainQuery('HR')).toBe('human resources recruiting');
});

test.each(['it-operations', 'IT Operations', 'security-&-identity-tools', 'Security & Identity Tools'])(
  'maps provider category %s to IT & Security', category => {
    expect(getToolkitDomains('unreviewed-toolkit', [category])).toEqual(['security']);
  },
);

test('maps reviewed procurement toolkits without losing their other domains', () => {
  expect(getToolkitDomains('coupa', ['accounting', 'proposal & invoice management'])).toEqual(['finance', 'procurement']);
  expect(getToolkitDomains('zip', ['accounting', 'productivity'])).toEqual(['finance', 'procurement', 'productivity']);
  expect(getToolkitDomains('unreviewed-toolkit', ['accounting', 'proposal & invoice management'])).toEqual(['finance']);
});

test('aliases improve ranking only inside the given authorized skill pool; types do not change', () => {
  const existing = { slug: 'makinari-outbound-campaign', name: 'Outbound', description: 'Campaign procedure', types: ['marketing_campaign'] };
  const custom = { slug: 'custom', name: 'Custom', description: 'Procedure', types: ['task'] };
  expect(searchSkillsByKeywords([existing, custom], 'hubspot CRM')).toEqual([existing]);
  expect(searchSkillsByKeywords([custom], 'hubspot CRM')).toEqual([]);
  expect(existing.types).toEqual(['marketing_campaign']);
  expect(searchSkillsByKeywords([existing, custom], 'HR')).toEqual([]);
});

test('actual bundled task catalogue resolves primary connector procedures and ranks them above outbound', () => {
  const crm = SkillsService.getSkillBySlugOrName('connector-crm-operations')!;
  const messaging = SkillsService.getSkillBySlugOrName('connector-messaging')!;
  const pool = SkillsService.matchSkillsForRequirement('task');
  expect(crm?.name).toBe('connector-crm-operations');
  expect(messaging?.name).toBe('connector-messaging');
  expect(pool).toEqual(expect.arrayContaining([crm, messaging]));
  expect(getDomainSkills(['crm'])[0]).toBe(crm.slug);
  expect(getDomainSkills(['communication'])[0]).toBe(messaging.slug);
  expect(searchSkillsByKeywords(pool, 'inspect external HubSpot CRM contacts')[0]).toEqual(crm);
  expect(searchSkillsByKeywords(pool, 'inspect Gmail inbox messages')[0]).toEqual(messaging);
  expect(SkillsService.searchSkills('CRM contacts', 'task')[0]).toEqual(crm);
  expect(SkillsService.searchSkills('Gmail inbox', 'task')[0]).toEqual(messaging);
  for (const skill of [crm, messaging]) {
    const content = readFileSync(path.resolve('src/skills', skill.slug, 'SKILL.md'), 'utf8');
    expect(skill.types).toEqual(['task', 'integration', 'automation']);
    const sections = ['## Objective', '## Instructions', '## Tools', '## Artifacts'];
    const positions = sections.map(section => content.indexOf(section));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(content).toContain('schema_hash');
    expect(content).toContain('read-only');
    expect(content.toLowerCase()).toContain('background');
  }
});

const schema = { type: 'object', properties: { query: { type: 'string', maxLength: 100 }, count: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] };
test('strict schema validates nested constraints and refuses unknown fields', () => {
  expect(() => validateConnectorInput(schema, { query: 'inbox', count: 3 })).not.toThrow();
  for (const input of [{}, { query: 'inbox', count: 1.5 }, { query: 'inbox', count: 11 }, { query: 'inbox', site_id: 'forged' },
    { query: 'file:///private/test' }, { query: 'https://untrusted.invalid' }, JSON.parse('{"query":"inbox","__proto__":{}}')]) {
    expect(() => validateConnectorInput(schema, input)).toThrow();
  }
});

test.each(['$ref', 'oneOf', 'format', 'pattern', 'if', 'not'])('unsupported constraint %s is never ignored', key => {
  expect(() => assertSupportedSchema({ ...schema, [key]: 'unsupported' })).toThrow('security review');
});

test.each(['connected_account_id', 'user_id', 'file_uri_path', 'callback_url', 'custom_auth_params'])('unsafe schema property %s blocks describe', key => {
  expect(() => assertSupportedSchema({ type: 'object', properties: { [key]: { type: 'string' } } })).toThrow('security review');
});