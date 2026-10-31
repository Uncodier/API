import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SkillsService } from '@/lib/services/skills-service';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { listSiteSkills } from '@/lib/services/site-skills-catalog';
import { procurementSchemas } from '../schemas';

jest.mock('@/lib/services/embeddings-service', () => ({
  EmbeddingsService: { generateEmbeddings: jest.fn().mockRejectedValue(new Error('offline')) },
}));
jest.mock('@/lib/services/site-skills-catalog', () => ({ listSiteSkills: jest.fn().mockResolvedValue([]) }));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn().mockResolvedValue({ success: true }),
}));

const siteId = randomUUID();
const slug = 'makinari-procurement';
const root = path.resolve(__dirname, '../../..');

it('loads the real bundled procurement skill and documents every registered tool', () => {
  const skill = SkillsService.getSkillBySlugOrName(slug);
  expect(skill).toMatchObject({ slug, name: slug, types: ['automation', 'task', 'integration'] });
  for (const name of Object.keys(procurementSchemas)) expect(skill!.content).toContain(`\`${name}\``);
  expect(skill!.content).toContain('skill_lookup');
  expect(skill!.content).toContain('screen');
});

it.each(['automation', 'task', 'integration'])('includes procurement in the %s skill catalog', type => {
  expect(SkillsService.matchSkillsForRequirement(type).map(skill => skill.slug)).toContain(slug);
});

it.each(['compras', 'solicitudes de compra', 'requisiciones', 'licitación', 'licitacion', 'licitaciones',
  'invitación a proveedores', 'invitaciones', 'adjudicación', 'adjudicacion', 'adjudicaciones',
  'órdenes de compra', 'ordenes de compra', 'recepción', 'procurement tenders awards'])
('discovers and loads the bundled playbook through actual site-scoped lookup: %s', async query => {
  const lookup = skillLookupTool({ siteId });
  const result = await lookup.execute({ action: 'search', query });
  expect(result.ok).toBe(true);
  expect(result.skills?.map(skill => skill.slug)).toContain(slug);
  expect(listSiteSkills).toHaveBeenCalledWith(siteId);
  const loaded = await lookup.execute({ action: 'get', skill_name: slug });
  expect(loaded).toMatchObject({ ok: true, slug });
  expect(loaded.content).toBe(SkillsService.getSkillBySlugOrName(slug)!.content);
});

it('links legacy purchase and commerce skills to the governed procurement playbook', () => {
  for (const name of ['makinari-purchases', 'makinari-commerce']) {
    expect(SkillsService.getSkillBySlugOrName(name)!.content).toContain('makinari-procurement');
  }
});

it('includes routing guidance in both workflow and ordinary assistant context', () => {
  const source = readFileSync(path.join(root, 'app/api/robots/instance/assistant/assistant-context.ts'), 'utf8');
  expect(source).toContain('skill_name="makinari-procurement"');
  const branches = source.slice(source.indexOf('const combinedSystemPrompt')).split(': [');
  expect(branches[0]).toContain('procurementSkillInstruction,');
  expect(branches[1]).toContain('procurementSkillInstruction,');
});