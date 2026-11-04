import { randomUUID } from 'node:crypto';
import { SkillsService } from '@/lib/services/skills-service';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';

jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
jest.mock('@/lib/services/site-skills-catalog', () => ({ listSiteSkills: jest.fn(async () => []) }));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn(async () => ({ success: true })),
}));

it.each(['develop', 'automation', 'content', 'design', 'task', 'integration', 'planning', 'research',
  'marketing_campaign', 'optimization', 'strategy'])('makes file delivery discoverable in %s', type => {
  expect(SkillsService.matchSkillsForRequirement(type).map(skill => skill.slug)).toContain('file-delivery');
});

it.each(['presentaciones', 'documentos', 'hojas de calculo', 'push file', 'spreadsheet', 'slides', 'HTML'])
('discovers the real skill by %s and loads its on-demand tool instructions', async query => {
  const lookup = skillLookupTool({ siteId: randomUUID() });
  const found = await lookup.execute({ action: 'search', query });
  expect(found.skills?.map(skill => skill.slug)).toContain('file-delivery');
  const loaded = await lookup.execute({ action: 'get', skill_name: 'file-delivery' });
  expect(loaded).toMatchObject({ ok: true, slug: 'file-delivery' });
  expect(loaded.content).toContain('`deliver_file`');
  expect(loaded.content).toContain('Native PPTX, DOCX, XLSX, PDF');
  expect(loaded.content).toContain('git_status="committed"');
});