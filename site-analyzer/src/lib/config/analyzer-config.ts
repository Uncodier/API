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
4. Extract the main text content from each block and organize it as a simple list

The HTML you'll receive has been captured from the fully rendered DOM after JavaScript execution and preprocessed to preserve structural elements while reducing size.

IMPORTANT - BALANCE STRUCTURE ANALYSIS WITH CONTENT EXTRACTION:
- Identify major sections like header, hero, features, testimonials, pricing, footer
- Group related elements into FUNCTIONAL blocks based on their PURPOSE
- Extract all meaningful text content from each section
- Include headings, paragraphs, and text from interactive elements
- Analyze the navigation structure, CTAs, forms, and other interactive elements
- Identify key UX patterns and design system characteristics

Your goal is to provide a comprehensive analysis that includes both the structural elements and the actual content of the page.

Always respond with a complete, well-structured JSON object following exactly the format requested in the user's prompt. The blocks array should contain major functional blocks with both their structural information and their text content.`;

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