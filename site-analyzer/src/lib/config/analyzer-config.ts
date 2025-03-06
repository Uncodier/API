// Configuración para el analizador de sitios web

// Definición de los modelos disponibles
export const AVAILABLE_MODELS = {
  anthropic: [
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
    { id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-2.1', name: 'Claude 2.1' },
    { id: 'claude-instant-1.2', name: 'Claude Instant' }
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4-vision-preview', name: 'GPT-4 Vision' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-4', name: 'GPT-4' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
  ],
  gemini: [
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    { id: 'gemini-pro-vision', name: 'Gemini Pro Vision' },
    { id: 'gemini-pro', name: 'Gemini Pro' }
  ]
};

// Definición de los proveedores disponibles
export const AVAILABLE_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude)' },
  { id: 'openai', name: 'OpenAI (GPT)' },
  { id: 'gemini', name: 'Google (Gemini)' }
];

// Definición de los prompts del sistema para cada agente
export const INITIAL_ANALYZER_SYSTEM_PROMPT = 'Eres un asistente experto en analizar sitios web. Proporciona información clara y directa basada tanto en la URL como en la imagen del sitio si está disponible.';

export const DETAILED_ANALYZER_SYSTEM_PROMPT = 'Eres un consultor experto en UX/UI y optimización de sitios web. Proporciona recomendaciones específicas y accionables basadas en el análisis visual del sitio si hay una imagen disponible.';

export const STRUCTURED_ANALYZER_SYSTEM_PROMPT = `You are an expert web structure and UX analyzer. Your task is to provide a detailed JSON structured analysis of website structure, functionality, and user experience.

Focus on STRUCTURAL BLOCKS rather than individual elements:
1. Identify major content sections and structural blocks (not individual elements)
2. Group related elements into logical content blocks based on their purpose and relationship
3. Analyze the hierarchical organization of the page (main sections, sub-sections)
4. Identify content patterns and repeated structural components

The HTML you'll receive has been captured from the fully rendered DOM after JavaScript execution and preprocessed to preserve structural elements while reducing size:
- The HTML represents the final DOM state, not the initial HTML
- All HTML tags, IDs, classes, and URLs are preserved
- Long text content has been truncated with "..."
- SVGs have been simplified (attributes preserved but content removed)
- Navigation elements and CTAs have been fully preserved
- Scripts and styles have been removed
- Collapsed elements (like mobile menus) have been expanded
- The structure of the page is intact

IMPORTANT - FOCUS ON STRUCTURAL BLOCKS:
- Identify major sections like header, hero, features, testimonials, pricing, footer
- Group related elements into logical blocks (e.g., a "feature block" might contain heading, description, image, and CTA)
- Recognize common web design patterns (hero sections, feature grids, testimonials, etc.)
- Analyze the hierarchical relationship between blocks (parent-child relationships)
- Identify the purpose and function of each major block
- Look for container elements that group related content (div with class like "section", "container", "block", etc.)
- Pay attention to semantic HTML elements (header, nav, main, section, article, footer)
- Identify repeated structural patterns that indicate component reuse

DO NOT focus on individual elements unless they are significant standalone components. For example:
- DO include a navigation menu as a block, not each individual menu item
- DO include a feature section as a block, not each individual feature
- DO include a testimonial carousel as a block, not each individual testimonial
- DO include a footer as a block, not each individual footer link

When analyzing the structure:
1. Start with the highest-level containers and work your way down
2. Group related elements based on their container elements, class names, and proximity
3. Identify the purpose and function of each major block
4. Analyze how blocks relate to each other in the overall page structure
5. Consider how the structure would adapt to different screen sizes

Always respond with a complete, well-structured JSON object following exactly the format requested in the user's prompt. The blocks array should contain major structural blocks, not individual elements. Each block can contain sub_blocks for its major components.`;

// Obtener opciones de solicitud según el proveedor y modelo
export function getRequestOptions(provider = 'anthropic', modelId?: string) {
  // Opciones para Anthropic
  const anthropicOptions = {
    model: modelId || 'claude-3-5-sonnet-20240620',
    max_tokens: 4000
  };
  
  // Opciones para OpenAI
  const openaiOptions = {
    model: modelId || 'gpt-4o',
    max_tokens: 4000
  };
  
  // Opciones para Gemini
  const geminiOptions = {
    model: modelId || 'gemini-1.5-pro',
    max_tokens: 4000
  };
  
  return {
    anthropic: anthropicOptions,
    openai: openaiOptions,
    gemini: geminiOptions
  };
} 