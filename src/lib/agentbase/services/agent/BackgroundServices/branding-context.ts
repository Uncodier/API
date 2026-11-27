const BRAND_SECTIONS = [
  ['Brand Pyramid', 'brand_pyramid', [
    ['brand_essence', 'Brand Essence'], ['brand_personality', 'Brand Personality'],
    ['brand_benefits', 'Brand Benefits'], ['brand_attributes', 'Brand Attributes'],
    ['brand_values', 'Brand Values'], ['brand_promise', 'Brand Promise'],
  ]],
  ['Brand Archetype', null, [['brand_archetype', '']]],
  ['Voice and Tone', 'voice_and_tone', [
    ['communication_style', 'Communication Style'], ['personality_traits', 'Personality Traits', 'list'],
    ['forbidden_words', 'Forbidden Words', 'list'], ['preferred_phrases', 'Preferred Phrases', 'list'],
  ]],
  ['Brand Guidelines', 'brand_guidelines', [
    ['do_list', 'Do', 'list'], ['dont_list', "Don't", 'list'], ['emotions_to_evoke', 'Emotions to Evoke', 'list'],
  ]],
  ['Color Palette', 'color_palette', [
    ['primary_color', 'Primary Color'], ['secondary_color', 'Secondary Color'], ['accent_color', 'Accent Color'],
    ['success_color', 'Success Color'], ['warning_color', 'Warning Color'], ['error_color', 'Error Color'],
    ['background_color', 'Background Color'], ['surface_color', 'Surface Color'],
  ]],
  ['Typography', 'typography', [
    ['primary_font', 'Primary Font'], ['secondary_font', 'Secondary Font'], ['font_size_scale', 'Font Size Scale'],
  ]],
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function formatBrandIdentity(value: unknown): string {
  let branding: Record<string, unknown> | undefined;
  try {
    branding = asRecord(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    return '';
  }
  if (!branding) return '';

  const sections: string[] = [];
  for (const [heading, group, fields] of BRAND_SECTIONS) {
    const legacy = group ? asRecord(branding[group]) : undefined;
    const lines: string[] = [];
    for (const [key, label, kind] of fields) {
      // Current settings are flat. An explicit empty value also overrides legacy data.
      const field = Object.hasOwn(branding, key) ? branding[key] : legacy?.[key];
      const text = kind === 'list'
        ? (Array.isArray(field) ? field.map(asText).filter(Boolean).join(', ') : '')
        : asText(field);
      if (text) lines.push(label ? `${label}: ${text}` : text);
    }
    if (lines.length) sections.push(`### ${heading}\n${lines.join('\n')}`);
  }

  return sections.length ? `\n## Brand Identity\n${sections.join('\n\n')}\n\n` : '';
}