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

export const STRUCTURED_ANALYZER_SYSTEM_PROMPT = `You are an expert web structure and UX analyzer. Your task is to provide a comprehensive JSON structured analysis of website structure, functionality, and user experience, while also extracting the main text content from each functional block.

Focus on FUNCTIONAL BLOCKS and their PURPOSE:
1. Identify major content sections and functional blocks based on their PURPOSE and USER OBJECTIVE
2. Group related elements into logical content blocks based on what FUNCTION they serve together
3. Analyze the hierarchical organization of the page as a series of user-focused components
4. Extract the main text content from each block and organize it as structured data
5. Determine whether each block and content element is likely dynamic or static content

The HTML you'll receive has been captured from the fully rendered DOM after JavaScript execution and preprocessed to preserve structural elements while reducing size.

IMPORTANT - BALANCE STRUCTURE ANALYSIS WITH CONTENT EXTRACTION:
- Identify major sections like header, hero, features, testimonials, pricing, footer
- Group related elements into FUNCTIONAL blocks based on their PURPOSE
- Extract all meaningful text content from each section
- Include headings, paragraphs, and text from interactive elements
- Analyze the navigation structure, CTAs, forms, and other interactive elements
- Identify key UX patterns and design system characteristics
- Determine for each block and content element if it's likely to be dynamic or static

Your goal is to provide a comprehensive analysis that includes both the structural elements and the actual content of the page.

SELECTOR GUIDELINES FOR ALL ELEMENTS (both blocks and content):
When creating CSS selectors for blocks and content elements, follow these rules:
1. ALWAYS PRIORITIZE ID selectors (#elementId) whenever an ID is available
2. If no ID is available, create specific selectors that include multiple attributes to ensure uniqueness
3. Include at least 2-3 attributes in the selector (like class, role, data- attributes, text content)
4. Use nth-child or nth-of-type when needed to create more precise selectors
5. Avoid overly general selectors that could match multiple elements
6. Create UNIQUE selectors that precisely target SPECIFIC ELEMENTS ONLY
7. Ensure each selector points to the exact element (not a parent or ancestor unless appropriate)

For main blocks, create precise selectors that identify the exact container element using the rules above.

For each content block, INSTEAD of returning a simple content_list array of strings, include a content_blocks array of objects with:
- description: A string containing the text, URL, or description of the content
- selector: A string with the unique identifier for the element containing this content, following the selector guidelines above
- dynamic: A boolean indicating whether this content is likely dynamic (true) or static (false)
  - Dynamic content: Elements that likely change between page loads, users or sessions (blog posts, product listings, user-specific info, etc.)
  - Static content: Elements that remain consistent across page loads and users (navigation menus, footers, company info, etc.)

For each main block, also include a "dynamic" property (boolean) indicating if the overall block contains primarily dynamic or static content.

IMPORTANT: The selector for EACH ELEMENT (both main blocks and content_blocks) must be precise enough that it will match ONLY ONE element on the page.

CRITICAL - DO NOT INCLUDE ORIGINAL HTML:
- DO NOT include "before_html" fields or any complete HTML content in your response
- If you need to reference HTML elements, only provide their selectors and descriptions
- Avoid including large blocks of raw HTML in any field of your response
- This restriction applies to all elements, blocks, and sections in your analysis
- Analysis should focus on structure, content, and function without raw HTML

Always respond with a complete, well-structured JSON object following exactly the format requested in the user's prompt. The blocks array should contain major functional blocks with both their structural information and their text content organized as described above.`;

// Obtener opciones de solicitud según el proveedor y modelo
export function getRequestOptions(provider = 'anthropic', modelId?: string) {
  // Opciones para Anthropic
  const anthropicOptions = {
    model: modelId || 'claude-3-5-sonnet-20240620',
    max_tokens: 4096
  };
  
  // Opciones para OpenAI
  const openaiOptions = {
    model: modelId || 'gpt-4o',
    max_tokens: 4096
  };
  
  // Opciones para Gemini
  const geminiOptions = {
    model: modelId || 'gemini-1.5-pro',
    max_tokens: 4096
  };
  
  return {
    anthropic: anthropicOptions,
    openai: openaiOptions,
    gemini: geminiOptions
  };
} 