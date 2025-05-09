/**
 * Generador de prompts para el servicio de personalización HTML
 */

import { PersonalizationOptions } from './types';

/**
 * Genera el prompt para la API de conversación
 */
export function generatePersonalizationPrompt(
  url: string,
  segment: any,
  options: PersonalizationOptions
): string {
  // Determinar qué elementos personalizar
  const targetElements = options.target_elements?.includes('all') 
    ? 'all relevant elements'
    : options.target_elements?.join(', ');
  
  // Determinar nivel de personalización
  let levelDescription = '';
  switch (options.personalization_level) {
    case 'minimal':
      levelDescription = 'minimal, with subtle and conservative changes';
      break;
    case 'extensive':
      levelDescription = 'extensive, with significant changes to maximize conversion';
      break;
    case 'moderate':
    default:
      levelDescription = 'moderate, with a balance between subtlety and effectiveness';
  }
  
  // Determinar método de implementación
  let implementationDescription = '';
  switch (options.implementation_method) {
    case 'static_html':
      implementationDescription = 'Generate static personalized HTML';
      break;
    case 'hybrid':
      implementationDescription = 'Generate a combination of static HTML and JavaScript';
      break;
    case 'js_injection':
    default:
      implementationDescription = 'Generate a JavaScript script to inject personalizations';
  }
  
  return `
Analyze the website at ${url} and generate specific HTML personalizations for the following audience segment:

SEGMENT INFORMATION:
- Name: ${segment.name}
- Description: ${segment.description || 'Not available'}
- Audience: ${segment.audience || 'Not specified'}
- Interests/Topics: ${segment.topics?.join(', ') || 'Not specified'}

SEGMENT ANALYSIS:
${segment.analysis ? `- Analysis Data: ${JSON.stringify(segment.analysis)}` : 'No analysis data available for this segment.'}

PERSONALIZATION INSTRUCTIONS:
1. Personalization Level: ${levelDescription}
2. Elements to Personalize: ${targetElements}
3. Device Type: ${options.device_type}
4. Implementation Method: ${implementationDescription}

PRIORITY - TEXT-ONLY MODIFICATIONS:
- ALWAYS prioritize targeting only text content where possible to save tokens and improve performance
- Always improve CTAs to be more specific to the segment
- If a change only requires modifying text (headlines, paragraphs, buttons, links), use precise selectors that target ONLY the text node or smallest wrapping element
- For text modifications, prefer using append/replace operations on the most specific element (span, h1-h6, p) rather than their containing blocks
- Only modify the structure when absolutely necessary for the personalization goal
- Return selectors that are as specific as possible to the text being modified
- Use text-specific selectors when available (e.g., h1 > span.title-text instead of the entire h1)
- When a text change is sufficient, avoid modifying other attributes or parent elements
- specially important to just change the text in CTAs to avoid changin the app behavior

COPY IMPROVEMENT FOCUS:
- Prioritize enhancing copy (text content) to better resonate with this specific audience segment
- Rewrite headlines, CTAs, product descriptions, and value propositions to align with segment interests
- Adjust tone, vocabulary, and complexity level based on segment preferences
- Use language patterns and terminology familiar to this audience
- For technical audiences: be precise, detailed, and factual
- For non-technical audiences: simplify complex concepts without being condescending
- Maintain brand voice while adapting to segment-specific communication styles
- Emphasize benefits most relevant to this particular segment

CRITICAL - HERO & H1,H2,H3,H4,H5,H6 and call to action PERSONALIZATION:
- ALWAYS personalize the main hero section and title elements to match the segment's interests and needs
- Ensure the hero message and h1 maintain a clear, coherent narrative that aligns with the segment's goals
- The hero section should immediately communicate value proposition for this specific audience
- H1 elements must reflect the segment's primary concerns or interests
- Maintain visual hierarchy while personalizing these elements
- Keep the hero section's call-to-action aligned with the segment's needs
- Ensure the messaging flows naturally from hero to supporting content

COMPLEX HTML STRUCTURE HANDLING:
- target only simple texts, not complex html structures are supported

ELEMENT SAFETY & VALIDITY:
- ONLY reference elements that already exist on the page or are fully self-contained in your modifications
- NEVER add links, buttons, or references to non-existent pages, images, or resources
- When adding new elements, include all necessary attributes and content within your modification
- For image additions, use placeholder references or descriptive text like "[IMAGE: description]" instead of broken links
- Ensure any new interactive elements (buttons, forms) have clear, self-explanatory purposes
- Avoid dependencies on external scripts or styles not present in the original page
- For navigation changes, only reference actual pages that exist on the site
- When in doubt about a resource's existence, prefer to modify existing elements instead of introducing new ones

CRITICAL - OPERATION TYPES:
For each personalization, specify a clear operation_type:
- "replace": Complete replacement of the element's content (default)
- "append": Add content at the end of the element's inner content
- "remove": Remove the element entirely (no after_html needed)
- "rewrite": Modify only the text content of an element, preserving all HTML structure and attributes

CRITICAL GUIDELINES:
- When possible, use "append" for additions to avoid rewriting the entire element
- For removals, simply use "remove" and provide the selector (no HTML needed)
- For text-only changes, use "rewrite" to modify just the text content without affecting HTML structure
- Use "replace" only when necessary for comprehensive changes
- For "append" operations, ensure the HTML is compatible with the target element's structure
- Always provide a specific CSS selector that targets exactly where the operation should apply

CRITICAL - TOKEN EFFICIENCY & CLASS PRESERVATION:
- ALWAYS use EXACTLY the same class/ID attributes from the original elements
- NEVER modify, reformat, or reorder existing classes and IDs
- Copy all HTML attributes as-is (id, class, data-*, aria-*, etc.)
- Preserve the exact ordering of classes in the class attribute
- For modifications, change ONLY content while preserving the structure
- Do not introduce unnecessary attributes or elements
- Minimize token usage by avoiding descriptive comments in the HTML
- AVOID replicating inline styles unless they're critical for user experience
- Simplify HTML structures whenever possible while maintaining functionality

CRITICAL - VISUAL CONSISTENCY:
- Maintain the original element's CSS classes exactly as they appear
- DO NOT copy inline styles unless they're essential for the element's appearance
- Keep the same selectors and structure exactly as in the original
- Never remove or rename any class, ID, or data attribute
- Ensure after_html maintains the same attribute order as the original
- Preserve existing JavaScript events and behaviors
- Simplify nested structures when they can be made more efficient without impacting appearance

RESPONSE FORMAT:
Return a JSON object with the following fields:
- personalizations: Array of specific modifications (selector, modification, before/after)

IMPORTANT: For each personalization, provide complete details:
- Precise CSS selector (keep the original exactly)
- Operation type (rewrite, replace, append, or remove)
- HTML after changes (after_html) - maintaining essential structure while simplifying when possible
- RESPECT WORD METRICS, WHILE BUILDING COPYS AND REPLACING TEXT, EITHER:
  a) Keep simirar word count and structure, just change the words to be more specific to the segment
  b) replace the complete section block with a new design so the new copy fits the new section

EXAMPLE OF EXPECTED JSON FORMAT (make sure to follow this structure exactly):
{
  "personalizations": [
    {
      "id": "mod_12345",
      "selector": "#hero-title",
      "operation_type": "rewrite",
      "after_html": "new hero title specialied for the segment"
    },
    {
      "id": "mod_12345",
      "selector": "#testimonial-copys-section",
      "operation_type": "replace",
      "after_html": "<h1 class=\\"testimonials\\">simplified html structure for testimonial title</h1>"
    },    
    {
      "id": "mod_123435",
      "selector": "#princpal-cta",
      "operation_type": "rewrite",
      "after_html": "New CTA copy"
    },       
    {
      "id": "mod_23456",
      "selector": ".product-description",
      "operation_type": "append",
      "after_html": "<div class=\\"tech-specs\\">Additional technical specifications here...</div>"
    },
    {
      "id": "mod_23433",
      "selector": "#hero-cta-section",
      "operation_type": "append",
      "after_html": "<a class=\\"secundary-btn\\" href=\\"#existing-resource-or-page-in-the-website\\">new cta...</a>"
    },    
    {
      "id": "mod_34567",
      "selector": ".promotional-banner",
      "operation_type": "remove"
    }
  ]
}

This is a REAL analysis for a client. DO NOT generate generic examples or templates. Personalizations must be specific and detailed for the provided website and segment, always maintaining visual and style consistency with the original design while preserving essential structure and omitting unnecessary inline styles.
`;
} 