import { BackgroundBuilder } from '../BackgroundBuilder';

function buildPrompt(branding: unknown): string {
  return BackgroundBuilder.buildAgentPrompt('agent-id', 'Test Agent', 'Help customers', [], undefined, undefined, undefined, {
    site: null,
    settings: { branding },
    copywriting: [{ status: 'approved', copy_type: 'email', title: 'Welcome', content: 'Welcome to our shop.' }],
  });
}

describe('agent branding context', () => {
  it('includes flat branding saved by Context alongside approved copywriting', () => {
    const prompt = buildPrompt({
      brand_essence: 'Care made simple', brand_personality: 'Practical', brand_benefits: 'Less waiting',
      brand_attributes: 'Clear estimates', brand_values: 'Honesty', brand_promise: 'No surprises', brand_archetype: 'caregiver',
      communication_style: 'friendly', personality_traits: ['Calm', 'Clear'],
      forbidden_words: ['guaranteed'], preferred_phrases: ['Happy to help'],
      do_list: ['Explain next steps'], dont_list: ['Guess'], emotions_to_evoke: ['Trust'],
      primary_color: '#112233', secondary_color: '#223344', accent_color: '#333333', success_color: '#123456',
      warning_color: '#234567', error_color: '#345678', background_color: '#ffffff', surface_color: '#f8fafc',
      primary_font: 'Inter', secondary_font: 'Georgia', font_size_scale: 'medium',
    });

    for (const line of [
      '## Copywriting Content', 'Content: Welcome to our shop.', '## Brand Identity', 'Brand Essence: Care made simple',
      'Brand Personality: Practical', 'Brand Benefits: Less waiting', 'Brand Attributes: Clear estimates', 'Brand Values: Honesty',
      'Brand Promise: No surprises', '### Brand Archetype\ncaregiver', 'Communication Style: friendly', 'Personality Traits: Calm, Clear',
      'Forbidden Words: guaranteed', 'Preferred Phrases: Happy to help', 'Do: Explain next steps', "Don't: Guess", 'Emotions to Evoke: Trust',
      'Primary Color: #112233', 'Secondary Color: #223344', 'Accent Color: #333333', 'Success Color: #123456', 'Warning Color: #234567',
      'Error Color: #345678', 'Background Color: #ffffff', 'Surface Color: #f8fafc', 'Primary Font: Inter', 'Secondary Font: Georgia',
      'Font Size Scale: medium',
    ]) expect(prompt).toContain(line);
  });

  it.each([false, true])('supports the legacy nested format (stored as JSON string: %s)', (serialized) => {
    const branding = {
      brand_pyramid: { brand_promise: 'Be transparent' },
      voice_and_tone: { communication_style: 'formal', preferred_phrases: ['Thank you'] },
      brand_guidelines: { dont_list: ['Overpromise'] },
      color_palette: { primary_color: '#112233' },
      typography: { primary_font: 'Inter' },
    };
    const prompt = buildPrompt(serialized ? JSON.stringify(branding) : branding);
    expect(prompt).toContain('Brand Promise: Be transparent');
    expect(prompt).toContain('Communication Style: formal');
    expect(prompt).toContain('Preferred Phrases: Thank you');
    expect(prompt).toContain("Don't: Overpromise");
    expect(prompt).toContain('Primary Color: #112233');
    expect(prompt).toContain('Primary Font: Inter');
  });

  it('prefers explicitly saved flat fields and only uses nested fields when the flat field is absent', () => {
    const prompt = buildPrompt({
      brand_promise: '', preferred_phrases: [], communication_style: 'professional',
      brand_pyramid: { brand_promise: 'Stale promise', brand_essence: 'Existing essence' },
      voice_and_tone: { preferred_phrases: ['Stale phrase'], communication_style: 'playful', forbidden_words: ['unlimited'] },
    });
    expect(prompt).toContain('Brand Essence: Existing essence');
    expect(prompt).toContain('Forbidden Words: unlimited');
    expect(prompt).toContain('Communication Style: professional');
    expect(prompt).not.toMatch(/Stale promise|Stale phrase|Communication Style: playful/);
    expect(prompt.match(/Communication Style:/g)).toHaveLength(1);
  });

  it('omits empty or malformed field values while keeping the rest of the prompt', () => {
    const prompt = buildPrompt({ brand_promise: '   ', communication_style: {}, preferred_phrases: ['', 123, ' Welcome '] });
    expect(prompt).toContain('Preferred Phrases: Welcome\n');
    expect(prompt).toContain('## Copywriting Content');
    expect(prompt).not.toMatch(/Brand Promise:|Communication Style:|\[object Object\]/);
  });

  it.each([{}, null, '{invalid-brand-json', 'null'])('leaves out branding when no valid fields are available (%p)', (branding) => {
    const prompt = buildPrompt(branding);
    expect(prompt).not.toMatch(/Brand Identity|invalid-brand-json/);
    expect(prompt).toContain('## Copywriting Content');
  });
});