import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SkillsService } from '@/lib/services/skills-service';
import { searchSkillsByKeywords } from '@/lib/services/skill-keyword-search';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { listSiteSkills } from '@/lib/services/site-skills-catalog';
import { deductSandboxToolCredits } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { resolveAssistantSkillSelection, requiredSkillsPrompt } from '../skill-selection';
import { MOTION_DESIGN_INSTRUCTION } from '../motion-design-instruction';

jest.mock('@/lib/services/embeddings-service', () => ({
  EmbeddingsService: { generateEmbeddings: jest.fn(), cosineSimilarity: jest.fn() },
}));
jest.mock('@/lib/services/site-skills-catalog', () => ({ listSiteSkills: jest.fn() }));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn(async () => ({ success: true })),
}));

const slug = 'motion-design-html';
const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  (listSiteSkills as jest.Mock).mockResolvedValue([]);
  (deductSandboxToolCredits as jest.Mock).mockResolvedValue({ success: true });
});

describe('bundled motion design procedure', () => {
  it('loads a complete, bounded skill without missing local references', () => {
    const skill = SkillsService.getSkillBySlugOrName(slug)!;
    expect(skill.name).toBe(slug);
    expect(skill.types).toEqual(['design', 'develop', 'content', 'marketing_campaign']);
    expect(skill.description.length).toBeLessThanOrEqual(1024);
    expect(skill.content.split('\n').length).toBeLessThan(500);
    expect(Buffer.byteLength(skill.content)).toBeLessThan(48_000);
    const sections = ['## Objective', '## Instructions', '## Tools', '## Artifacts'];
    const offsets = sections.map(section => skill.content.indexOf(section));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    const links = [...skill.content.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    expect(links.every(link => link.startsWith('https://'))).toBe(true);
    for (const requirement of ['storyboard', 'render(t)', 'seeking backwards', 'UI OUTPUT CONTRACT',
      '262144', 'binary delivery', 'prefers-reduced-motion', 'ffprobe', 'Apache-2.0']) {
      expect(skill.content).toContain(requirement);
    }
  });

  it.each([
    'animaciones explicativos 2d 3d html',
    'DISEÑOS ANIMACIÓN VÍDEOS GRÁFICOS',
    'animacio\u0301n explicativo',
    '2D', '3D', '2D/3D',
    'motion graphics explainer video html',
  ])('finds the skill first for %s', query => {
    expect(SkillsService.searchSkills(query)[0]?.slug).toBe(slug);
  });

  it('preserves requirement filters and unrelated discovery', () => {
    expect(SkillsService.searchSkills('3D', 'content').some(skill => skill.slug === slug)).toBe(true);
    expect(SkillsService.searchSkills('3D', 'automation').some(skill => skill.slug === slug)).toBe(false);
    expect(SkillsService.searchSkills('procurement')[0]?.slug).toBe('makinari-procurement');
    expect(SkillsService.searchSkills('')).toEqual(SkillsService.matchSkillsForRequirement());
  });

  it('uses the same keyword fallback when embedding generation fails', async () => {
    (EmbeddingsService.generateEmbeddings as jest.Mock).mockRejectedValueOnce(new Error('Offline test'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const matches = await SkillsService.searchSkillsVector('animación 2D/3D', 'design');
      expect(matches[0]?.slug).toBe(slug);
      expect(EmbeddingsService.generateEmbeddings).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('deduplicates query terms, rejects noise, and never broadens the supplied pool', () => {
    const pool = [
      { slug: 'first', name: 'First', description: 'svg html' },
      { slug: 'second', name: 'Second', description: 'animation' },
    ];
    expect(searchSkillsByKeywords(pool, 'animation animation animation svg html')).toEqual(pool);
    for (const query of ['!!!', 'de la el', '2', '3', '']) {
      expect(searchSkillsByKeywords(pool, query)).toEqual([]);
    }
    expect(searchSkillsByKeywords([], '3D')).toEqual([]);
  });

  it.each(['UI', 'UX', 'QA', 'AI', 'JS', 'TS', 'DB'])('preserves short technical query %s', query => {
    const skill = { slug: 'technical', name: 'Technical', description: `${query} guidance` };
    expect(searchSkillsByKeywords([skill], query)).toEqual([skill]);
  });

  it.each(['ui', 'qa', 'ai'])('still discovers bundled specialists for %s', query => {
    expect(SkillsService.searchSkills(query).length).toBeGreaterThan(0);
  });

  it('can be explicitly selected with the art-direction skill within the prompt budget', async () => {
    const selection = await resolveAssistantSkillSelection('site-a', {
      skill_mode: 'required', skill_slugs: [slug, 'ui-ux-design'],
    });
    expect(selection.skills.map(skill => skill.slug)).toEqual([slug, 'ui-ux-design']);
    expect(requiredSkillsPrompt(selection)).toContain('HTML motion design and visual explainers');
  });
});

describe('assistant tenant lookup', () => {
  it('searches and gets real bundled instructions without embeddings or another tenant', async () => {
    const tool = skillLookupTool({ siteId: 'site-a', requirement_type: 'design' });
    const result = await tool.execute({ action: 'search', query: 'animación 2D/3D HTML', limit: 1 });
    expect(result).toMatchObject({ ok: true, skills: [{ slug }] });
    const loaded = await tool.execute({ action: 'get', skill_name: slug });
    expect(loaded).toMatchObject({ ok: true, slug, content: SkillsService.getSkillBySlugOrName(slug)!.content });
    expect(listSiteSkills).toHaveBeenCalledWith('site-a');
    expect((listSiteSkills as jest.Mock).mock.calls.every(([siteId]) => siteId === 'site-a')).toBe(true);
    expect(EmbeddingsService.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('does not let a custom skill shadow the bundled procedure or expose disabled entries', async () => {
    (listSiteSkills as jest.Mock).mockResolvedValue([
      { slug, name: slug, description: '3D', content: 'Shadow', enabled: true },
      { slug: 'hidden', name: 'Hidden', description: '3D', content: 'Disabled', enabled: false },
    ]);
    const tool = skillLookupTool({ siteId: 'site-a' });
    expect(await tool.execute({ action: 'get', skill_name: slug }))
      .toMatchObject({ content: SkillsService.getSkillBySlugOrName(slug)!.content });
    expect(await tool.execute({ action: 'get', skill_name: 'hidden' })).toMatchObject({ ok: false });
  });

  it('keeps tool credit checks before catalog access and type filters on search', async () => {
    const tool = skillLookupTool({ siteId: 'site-a', requirement_type: 'automation' });
    expect(await tool.execute({ action: 'search', query: slug })).toMatchObject({ ok: true, count: 0 });
    jest.clearAllMocks();
    (deductSandboxToolCredits as jest.Mock).mockResolvedValue({ success: false, error: 'Insufficient credits' });
    expect(await tool.execute({ action: 'get', skill_name: slug })).toMatchObject({ ok: false });
    expect(listSiteSkills).not.toHaveBeenCalled();
  });
});

describe('prompt and neighboring skill contracts', () => {
  it('routes both assistant prompt branches without retaining the blanket video rule', () => {
    const context = source('src/app/api/robots/instance/assistant/assistant-context.ts');
    expect(MOTION_DESIGN_INSTRUCTION).toContain('skill_name="motion-design-html"');
    expect(context.match(/^\s+MOTION_DESIGN_INSTRUCTION,$/gm)).toHaveLength(2);
    expect(context).toContain('generate_video is not an HTML renderer');
    expect(context).toContain('A host UI OUTPUT CONTRACT remains binding');
    expect(context).not.toContain('When generating VIDEO, you MUST use');
    const workflow = source('src/app/api/robots/instance/assistant/utils.ts');
    expect(workflow).toContain('not an explicitly code-authored HTML/SVG/Canvas/Three.js animation or explainer');
    expect(workflow).toContain('For code-authored animations, follow motion-design-html');
  });

  it('keeps the server media enforcement and references the new skill from existing specialists', () => {
    const contract = source('src/app/api/robots/instance/assistant/ui-media-contract.ts');
    expect(contract).toContain('You MUST call ${requiredTool}');
    expect(contract).toContain('This is a text node. Do not call any media generation tool.');
    for (const specialist of ['animations-framer-gsap', 'webgl-threejs-pixi']) {
      expect(source(`src/skills/${specialist}/SKILL.md`)).toContain('load `motion-design-html`');
    }
  });
});