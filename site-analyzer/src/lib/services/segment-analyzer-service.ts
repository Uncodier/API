import { createSegmentInDatabase, updateSegment, findSimilarSegments } from '@/lib/database/segment-db'
import { generateSegmentId } from '../utils/id-generator'
import { analyzeWithConversationApi } from './conversation-client'

interface SegmentAnalysisOptions {
  url: string;
  segmentCount: number;
  mode: 'analyze' | 'create' | 'update';
  timeout: number;
  profitabilityMetrics?: string[];
  minConfidenceScore: number;
  includeRationale?: boolean;
  segmentAttributes?: string[];
  industryContext?: string;
  additionalInstructions?: string;
  aiProvider: 'openai' | 'anthropic' | 'gemini';
  aiModel: string;
  userId: string;
  includeScreenshot?: boolean;
}

interface SegmentAnalysisResult {
  segments: Array<{
    id: string;
    name: string;
    description: string;
    summary: string;
    estimatedSize: string;
    profitabilityScore: number;
    confidenceScore: number;
    targetAudience: string | string[];
    audienceProfile?: Record<string, any>;
    language: string;
    attributes?: Record<string, any>;
    monetizationOpportunities?: Array<Record<string, any>>;
    recommendedActions?: Array<Record<string, any>>;
    createdInDatabase: boolean;
    databaseId?: string;
    rationale?: string;
    error?: boolean;
    errorDetails?: Record<string, any>;
  }>;
  segmentsCreated?: number;
  segmentsUpdated?: number;
  siteContext?: Record<string, any>;
  confidenceOverall?: number;
  nextSteps?: Array<Record<string, any>>;
  errors?: Array<Record<string, any>>;
}

/**
 * Implementación temporal del servicio de análisis de segmentos
 * 
 * Esta es una versión simplificada que devuelve datos de ejemplo para poder
 * probar la API sin dependencias externas.
 */

/**
 * Analiza un sitio web para identificar segmentos rentables (versión de ejemplo)
 * 
 * Esta implementación devuelve datos de ejemplo para poder probar la API
 * sin dependencias externas.
 */
export async function analyzeSiteSegments(options: SegmentAnalysisOptions): Promise<SegmentAnalysisResult> {
  console.log('[SegmentAnalyzer] Starting segment analysis for URL:', options.url);
  console.log('[SegmentAnalyzer] Analysis options:', JSON.stringify({
    segmentCount: options.segmentCount,
    mode: options.mode,
    aiProvider: options.aiProvider,
    aiModel: options.aiModel,
    timeout: options.timeout
  }));
  
  try {
    console.log('[SegmentAnalyzer] Preparing to call AI analysis');
    
    // Preparar el prompt para el análisis
    console.log('[SegmentAnalyzer] Preparing analysis prompt');
    const prompt = prepareSegmentAnalysisPrompt(options);
    console.log('[SegmentAnalyzer] Prompt prepared, length:', prompt.length);
    
    // Llamar a la API de conversación
    console.log('[SegmentAnalyzer] Calling conversation API with model:', options.aiModel);
    
    let aiResponse;
    try {
      aiResponse = await analyzeWithConversationApi(
        prompt,
        options.aiProvider,
        options.aiModel,
        options.url,
        options.includeScreenshot,
        options.timeout,
        false,  // debugMode
        true    // toJSON - asegurar que siempre se solicita JSON
      );
      console.log('[SegmentAnalyzer] Received response from conversation API');
      
      // Verificar que la respuesta sea un objeto válido
      if (!aiResponse || typeof aiResponse !== 'object') {
        console.error('[SegmentAnalyzer] Invalid AI response format:', aiResponse);
        aiResponse = {
          segments: [{
            id: `error-format-${Date.now()}`,
            name: "Error de formato",
            description: "La respuesta de la IA no tiene el formato esperado.",
            summary: "Error de formato en la respuesta",
            estimatedSize: "N/A",
            profitabilityScore: 0,
            confidenceScore: 0,
            targetAudience: "N/A",
            language: "N/A"
          }]
        };
      } else {
        // Registrar la estructura de la respuesta para depuración
        console.log('[SegmentAnalyzer] AI response structure:', Object.keys(aiResponse));
        
        // Si la respuesta tiene una propiedad 'content', intentar extraer JSON
        if (aiResponse.content && typeof aiResponse.content === 'string') {
          console.log('[SegmentAnalyzer] Response has content property, attempting to parse as JSON');
          try {
            const parsedContent = JSON.parse(aiResponse.content);
            if (parsedContent && typeof parsedContent === 'object') {
              console.log('[SegmentAnalyzer] Successfully parsed content as JSON');
              aiResponse = parsedContent;
            }
          } catch (parseError) {
            console.log('[SegmentAnalyzer] Content is not valid JSON, continuing with original response');
          }
        }
        
        // Si la respuesta tiene una propiedad 'choices', extraer el contenido del mensaje
        if (aiResponse.choices && Array.isArray(aiResponse.choices) && aiResponse.choices.length > 0) {
          console.log('[SegmentAnalyzer] Response has choices property');
          const messageContent = aiResponse.choices[0].message?.content;
          
          if (messageContent) {
            console.log('[SegmentAnalyzer] Found message content in choices');
            
            // Si el contenido es un string, intentar parsearlo como JSON
            if (typeof messageContent === 'string') {
              try {
                const parsedContent = JSON.parse(messageContent);
                if (parsedContent && typeof parsedContent === 'object') {
                  console.log('[SegmentAnalyzer] Successfully parsed message content as JSON');
                  aiResponse = parsedContent;
                }
              } catch (parseError) {
                console.log('[SegmentAnalyzer] Message content is not valid JSON, continuing with original response');
              }
            } else if (typeof messageContent === 'object') {
              console.log('[SegmentAnalyzer] Message content is already an object');
              aiResponse = messageContent;
            }
          }
        }
      }
    } catch (conversationError: any) {
      console.error('[SegmentAnalyzer] Error in conversation API:', conversationError);
      
      // Crear una respuesta de error estructurada
      return {
        segments: [{
          id: `api-error-${Date.now()}`,
          name: "Error en la API",
          description: `Error en la API de conversación: ${conversationError.message || 'Error desconocido'}`,
          summary: "Error al comunicarse con la IA",
          estimatedSize: "N/A",
          profitabilityScore: 0,
          confidenceScore: 0,
          targetAudience: "N/A",
          language: "N/A",
          createdInDatabase: false,
          error: true
        }],
        segmentsCreated: 0,
        segmentsUpdated: 0,
        siteContext: {},
        confidenceOverall: 0,
        nextSteps: [],
        errors: [{
          code: "CONVERSATION_API_ERROR",
          message: `Error en la API de conversación: ${conversationError.message || 'Error desconocido'}`,
          affectedSegments: [],
          severity: "alta"
        }]
      };
    }
    
    // Procesar la respuesta
    console.log('[SegmentAnalyzer] Processing AI response');
    const segments = processAIResponse(aiResponse, options);
    console.log('[SegmentAnalyzer] Processed segments count:', segments.length);
    
    // Normalizar los segmentos
    console.log('[SegmentAnalyzer] Normalizing segments');
    const normalizedSegments = segments.map(segment => normalizeSegment(segment, options));
    console.log('[SegmentAnalyzer] Segments normalized');
    
    // Filtrar segmentos según la puntuación de confianza mínima
    console.log('[SegmentAnalyzer] Filtering segments by confidence score');
    const filteredSegments = normalizedSegments.filter(segment => 
      segment.confidenceScore >= options.minConfidenceScore
    );
    console.log('[SegmentAnalyzer] Filtered segments count:', filteredSegments.length);
    
    // Determinar el número de segmentos a limitar
    const segmentCountToUse = options.segmentCount;
    
    // Limitar el número de segmentos según el parámetro determinado
    console.log('[SegmentAnalyzer] Limiting segments to count:', segmentCountToUse);
    const limitedSegments = filteredSegments.slice(0, segmentCountToUse);
    
    // Crear o actualizar segmentos en la base de datos si es necesario
    let segmentsCreated = 0;
    let segmentsUpdated = 0;
    
    if (options.mode === 'create' || options.mode === 'update') {
      console.log('[SegmentAnalyzer] Mode requires database operations:', options.mode);
      
      for (const segment of limitedSegments) {
        try {
          if (options.mode === 'create') {
            console.log('[SegmentAnalyzer] Creating segment in database:', segment.id);
            try {
              // Preparar los datos del segmento para la base de datos
              const segmentData = {
                id: segment.id,
                name: segment.name,
                description: segment.description,
                audience: Array.isArray(segment.targetAudience) ? segment.targetAudience.join(', ') : segment.targetAudience,
                size: parseFloat(segment.estimatedSize) || 0,
                is_active: true,
                keywords: [],
                hot_topics: [],
                site_id: generateSegmentId(options.url),
                user_id: options.userId,
                language: segment.language,
                url: options.url
              };
              
              const result = await createSegmentInDatabase(segmentData);
              if (result && typeof result === 'object' && 'id' in result) {
                segment.createdInDatabase = true;
                segment.databaseId = result.id;
                segmentsCreated++;
                console.log('[SegmentAnalyzer] Segment created successfully:', segment.id);
              }
            } catch (dbError) {
              console.error('[SegmentAnalyzer] Error creating segment in database:', dbError);
            }
          } else if (options.mode === 'update') {
            console.log('[SegmentAnalyzer] Finding similar segments for update');
            try {
              const similarSegments = await findSimilarSegments(
                options.userId,
                segment.name,
                options.url
              );
              
              if (similarSegments && Array.isArray(similarSegments) && similarSegments.length > 0) {
                console.log('[SegmentAnalyzer] Found similar segments:', similarSegments.length);
                const targetSegment = similarSegments[0];
                if (targetSegment && typeof targetSegment === 'object' && 'id' in targetSegment) {
                  console.log('[SegmentAnalyzer] Updating segment:', targetSegment.id);
                  
                  // Preparar los datos de actualización
                  const updates = {
                    name: segment.name,
                    description: segment.description,
                    audience: Array.isArray(segment.targetAudience) ? segment.targetAudience.join(', ') : segment.targetAudience,
                    size: parseFloat(segment.estimatedSize) || 0,
                    language: segment.language,
                    url: options.url
                  };
                  
                  const result = await updateSegment(targetSegment.id, updates);
                  if (result) {
                    segment.createdInDatabase = true;
                    segment.databaseId = targetSegment.id;
                    segmentsUpdated++;
                    console.log('[SegmentAnalyzer] Segment updated successfully:', targetSegment.id);
                  }
                }
              } else {
                console.log('[SegmentAnalyzer] No similar segments found, creating new');
                // Preparar los datos del segmento para la base de datos
                const segmentData = {
                  id: segment.id,
                  name: segment.name,
                  description: segment.description,
                  audience: Array.isArray(segment.targetAudience) ? segment.targetAudience.join(', ') : segment.targetAudience,
                  size: parseFloat(segment.estimatedSize) || 0,
                  is_active: true,
                  keywords: [],
                  hot_topics: [],
                  site_id: generateSegmentId(options.url),
                  user_id: options.userId,
                  language: segment.language,
                  url: options.url
                };
                
                const result = await createSegmentInDatabase(segmentData);
                if (result && typeof result === 'object' && 'id' in result) {
                  segment.createdInDatabase = true;
                  segment.databaseId = result.id;
                  segmentsCreated++;
                  console.log('[SegmentAnalyzer] New segment created:', segment.id);
                }
              }
            } catch (dbError) {
              console.error('[SegmentAnalyzer] Error in database operation:', dbError);
            }
          }
        } catch (error) {
          console.error('[SegmentAnalyzer] Error in database operation:', error);
        }
      }
    }
    
    // Calcular la puntuación de confianza general
    console.log('[SegmentAnalyzer] Calculating overall confidence score');
    const confidenceOverall = limitedSegments.reduce((sum, segment) => sum + segment.confidenceScore, 0) / limitedSegments.length;
    
    console.log('[SegmentAnalyzer] Analysis completed successfully');
    return {
      segments: limitedSegments,
      segmentsCreated,
      segmentsUpdated,
      siteContext: aiResponse.siteContext,
      confidenceOverall,
      nextSteps: aiResponse.nextSteps,
      errors: aiResponse.errors
    };
  } catch (error: any) {
    console.error('Error al analizar segmentos:', error);
    return {
      segments: [{
        id: `internal-error-${Date.now()}`,
        name: "Error interno",
        description: "Error al analizar segmentos",
        summary: "Error al analizar segmentos",
        estimatedSize: "N/A",
        profitabilityScore: 0,
        confidenceScore: 0,
        targetAudience: "N/A",
        language: "N/A",
        createdInDatabase: false,
        error: true
      }],
      segmentsCreated: 0,
      segmentsUpdated: 0,
      siteContext: {},
      confidenceOverall: 0,
      nextSteps: [],
      errors: [{
        code: "INTERNAL_ERROR",
        message: "Error al analizar segmentos",
        affectedSegments: [],
        severity: "alta"
      }]
    };
  }
}

/**
 * Prepara el prompt para el análisis de segmentos
 * 
 * @param options Opciones de análisis de segmentos
 * @returns Prompt para el análisis de segmentos
 */
function prepareSegmentAnalysisPrompt(options: SegmentAnalysisOptions): string {
  // Determine the number of segments to generate
  const segmentCountToUse = options.segmentCount;
  
  // Build the base prompt
  let prompt = `Analyze the website ${options.url} and identify the ${segmentCountToUse} most profitable audience segments.

For each segment, provide:
- A descriptive name
- A detailed description
- A concise summary
- Estimated size (percentage)
- Profitability score (0-1)
- Confidence score (0-1)
- Target audience
- Audience profile
- Language
- Attributes (demographic, behavioral, etc.)
- Monetization opportunities
- Recommended actions

IMPORTANT: Your response MUST be a valid JSON object with the following structure:

{
  "url": "${options.url}",
  "segmentsAnalyzed": ${segmentCountToUse},
  "segments": [
    {
      "name": "Digital Content Creators",
      "description": "Professionals and enthusiasts aged 20-40 dedicated to creating digital content for social media and online platforms",
      "summary": "Highly profitable segment of digital creators with specific needs for professional tools and willingness to invest in solutions that improve their creative workflow.",
      "estimatedSize": "15%",
      "profitabilityScore": 0.88,
      "confidenceScore": 0.93,
      "targetAudience": "media_entertainment",
      "audienceProfile": {
        "adPlatforms": {
          "googleAds": {
            "demographics": {
              "ageRanges": ["25-34", "35-44"],
              "gender": ["male", "female"],
              "parentalStatus": ["parent"],
              "householdIncome": ["top 10%", "top 20%"]
            },
            "interests": [
              "Digital Content Creation",
              "Video Production",
              "Photography",
              "Graphic Design",
              "Technology Early Adopters"
            ],
            "inMarketSegments": [
              "Software",
              "Creative Software",
              "Video Editing Software",
              "Photography Equipment",
              "Computer Hardware"
            ]
          },
          "facebookAds": {
            "demographics": {
              "age": [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
              "education": ["College grad", "In grad school", "Master's degree"],
              "generation": ["Millennials", "Gen Z"]
            },
            "interests": [
              "Adobe Creative Cloud",
              "Content creation",
              "Digital marketing",
              "Video production",
              "Photography"
            ]
          },
          "linkedInAds": {
            "demographics": {
              "age": ["25-34", "35-54"],
              "education": ["Bachelor's Degree", "Master's Degree"],
              "jobExperience": ["Mid-Senior level", "Director"]
            },
            "jobTitles": [
              "Creative Director",
              "Content Producer",
              "Digital Marketing Manager",
              "Graphic Designer",
              "Video Editor"
            ],
            "industries": [
              "Marketing and Advertising",
              "Media Production",
              "Design",
              "Information Technology"
            ],
            "companySize": ["11-50", "51-200", "201-500"]
          },
          "tiktokAds": {
            "demographics": {
              "age": ["18-24", "25-34"],
              "gender": ["male", "female"],
              "location": ["Urban areas", "Creative hubs"]
            },
            "interests": [
              "Content Creation",
              "Video Editing",
              "Creative Tools",
              "Digital Art",
              "Tech Gadgets"
            ],
            "behaviors": [
              "App installs: Creative tools",
              "Engagement: Tutorial videos",
              "Shopping: Tech accessories",
              "Creator economy participants"
            ],
            "creatorCategories": [
              "Tech Reviewers",
              "Digital Artists",
              "Tutorial Creators",
              "Productivity Influencers"
            ]
          }
        }
      },
      "language": "en",
}

Make sure your response is a valid JSON and follows this structure exactly. Do not include additional explanations outside the JSON. Replace the example data with real information based on your analysis of the website.`;

  // Add audience list options
  prompt += `\n\nFor the targetAudience field, please select from the following options:
- Enterprise
- Small & Medium Business
- Startups
- B2B SaaS
- E-commerce
- Technology
- Financial Services
- Healthcare
- Education
- Manufacturing
- Retail
- Real Estate
- Hospitality & Tourism
- Automotive
- Media & Entertainment
- Telecommunications
- Energy & Utilities
- Agriculture
- Construction
- Logistics & Transportation
- Professional Services
- Government
- Non-Profit
- Legal Services
- Pharmaceutical
- Insurance
- Consulting
- Research & Development
- Aerospace & Defense
- Gaming & Entertainment`;

  // Add profitability metrics if specified
  if (options.profitabilityMetrics && options.profitabilityMetrics.length > 0) {
    prompt += `\n\nEvaluate profitability based on these specific metrics: ${options.profitabilityMetrics.join(', ')}.`;
  }

  // Add segment attributes if specified
  if (options.segmentAttributes && options.segmentAttributes.length > 0) {
    prompt += `\n\nInclude these specific attributes for each segment: ${options.segmentAttributes.join(', ')}.`;
  }

  // Add industry context if specified
  if (options.industryContext) {
    prompt += `\n\nPlease note that this site belongs to the industry: ${options.industryContext}.`;
  }

  // Add additional instructions if specified
  if (options.additionalInstructions) {
    prompt += `\n\n${options.additionalInstructions}`;
  }

  // Add instructions for the mode
  if (options.mode === 'create') {
    prompt += `\n\nThese segments will be created in the database, so make sure they are accurate and useful.`;
  } else if (options.mode === 'update') {
    prompt += `\n\nThese segments will be used to update existing segments in the database.`;
  }

  return prompt;
}

/**
 * Procesa la respuesta de la IA para extraer los segmentos
 * 
 * @param aiResponse Respuesta de la IA
 * @param options Opciones de análisis de segmentos
 * @returns Array de segmentos procesados
 */
function processAIResponse(aiResponse: any, options: SegmentAnalysisOptions): any[] {
  console.log('[SegmentAnalyzer] Processing AI response');
  
  // Verificar si la respuesta es un string (posiblemente JSON)
  if (typeof aiResponse === 'string') {
    console.log('[SegmentAnalyzer] AI response is a string, attempting to parse as JSON');
    try {
      aiResponse = JSON.parse(aiResponse);
    } catch (error) {
      console.error('[SegmentAnalyzer] Failed to parse AI response as JSON:', error);
      return [{
        id: `parse-error-${Date.now()}`,
        name: "Error de formato",
        description: "La respuesta de la IA no es un JSON válido.",
        summary: "Error al procesar la respuesta de la IA",
        estimatedSize: "N/A",
        profitabilityScore: 0,
        confidenceScore: 0,
        targetAudience: "N/A",
        language: "N/A",
        createdInDatabase: false,
        error: true,
        errorDetails: {
          message: "La respuesta de la IA no es un JSON válido",
          rawResponse: aiResponse.substring(0, 500) + (aiResponse.length > 500 ? '...' : '')
        }
      }];
    }
  }
  
  // Verificar si la respuesta está dentro de un objeto "Assistant" o similar
  if (aiResponse && typeof aiResponse === 'object') {
    console.log('[SegmentAnalyzer] Checking for nested response structure');
    
    // Verificar si hay una propiedad que contiene un objeto con segments
    for (const key in aiResponse) {
      if (aiResponse[key] && 
          typeof aiResponse[key] === 'object' && 
          aiResponse[key].segments && 
          Array.isArray(aiResponse[key].segments)) {
        console.log(`[SegmentAnalyzer] Found segments in nested property: ${key}`);
        aiResponse = aiResponse[key];
        break;
      }
    }
    
    // Verificar si hay una propiedad "content" que podría contener JSON
    if (aiResponse.content && typeof aiResponse.content === 'string') {
      console.log('[SegmentAnalyzer] Found content property, attempting to parse as JSON');
      try {
        const parsedContent = JSON.parse(aiResponse.content);
        if (parsedContent && typeof parsedContent === 'object' && parsedContent.segments) {
          console.log('[SegmentAnalyzer] Successfully parsed content as JSON with segments');
          aiResponse = parsedContent;
        }
      } catch (error) {
        console.log('[SegmentAnalyzer] Content is not valid JSON, continuing with original response');
      }
    }
  }
  
  // Verificar si la respuesta contiene segmentos
  if (!aiResponse || !aiResponse.segments || !Array.isArray(aiResponse.segments)) {
    console.error('[SegmentAnalyzer] AI response does not contain segments', aiResponse);
    
    // Crear un segmento de error para asegurar que siempre devolvemos algo válido
    return [{
      id: `error-segment-${Date.now()}`,
      name: "Error en el análisis",
      description: "No se pudieron identificar segmentos válidos en la respuesta de la IA.",
      summary: "Error en el análisis de segmentos",
      estimatedSize: "N/A",
      profitabilityScore: 0,
      confidenceScore: 0,
      targetAudience: "N/A",
      language: "N/A",
      createdInDatabase: false,
      error: true,
      errorDetails: {
        message: "La respuesta de la IA no contiene segmentos válidos",
        rawResponse: typeof aiResponse === 'object' ? JSON.stringify(aiResponse).substring(0, 500) : String(aiResponse).substring(0, 500)
      }
    }];
  }
  
  // Extraer los segmentos de la respuesta
  const segments = aiResponse.segments;
  console.log(`[SegmentAnalyzer] Found ${segments.length} segments in AI response`);
  
  // Verificar que cada segmento tenga los campos requeridos
  const validSegments = segments.filter((segment: any) => {
    const hasRequiredFields = 
      segment.name && 
      segment.description && 
      segment.profitabilityScore !== undefined &&
      segment.confidenceScore !== undefined;
    
    if (!hasRequiredFields) {
      console.warn('[SegmentAnalyzer] Segment missing required fields:', segment);
    }
    
    return hasRequiredFields;
  });
  
  console.log(`[SegmentAnalyzer] Found ${validSegments.length} valid segments out of ${segments.length}`);
  
  // Si no hay segmentos válidos, devolver un segmento de error
  if (validSegments.length === 0 && segments.length > 0) {
    return [{
      id: `incomplete-segment-${Date.now()}`,
      name: "Segmentos incompletos",
      description: "Los segmentos identificados no contienen todos los campos requeridos.",
      summary: "Segmentos con datos incompletos",
      estimatedSize: "N/A",
      profitabilityScore: 0,
      confidenceScore: 0,
      targetAudience: "N/A",
      language: "N/A",
      createdInDatabase: false,
      error: true,
      errorDetails: {
        message: "Ninguno de los segmentos contiene todos los campos requeridos",
        segmentsCount: segments.length,
        firstSegmentSample: segments[0] ? JSON.stringify(segments[0]) : "N/A"
      }
    }];
  }
  
  return validSegments;
}

/**
 * Normaliza un segmento para asegurar que tenga todos los campos requeridos
 * 
 * @param segment Segmento a normalizar
 * @param options Opciones de análisis de segmentos
 * @returns Segmento normalizado
 */
function normalizeSegment(segment: any, options: SegmentAnalysisOptions): any {
  // Si es un segmento de error, preservar sus propiedades de error
  if (segment.error) {
    return {
      ...segment,
      createdInDatabase: false
    };
  }
  
  // Asegurarse de que el segmento tenga un ID
  if (!segment.id) {
    segment.id = generateSegmentId(segment.name);
  }
  
  // Asegurarse de que el segmento tenga una puntuación de rentabilidad
  if (segment.profitabilityScore === undefined) {
    segment.profitabilityScore = 0.5; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga una puntuación de confianza
  if (segment.confidenceScore === undefined) {
    segment.confidenceScore = 0.5; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga un tamaño estimado
  if (!segment.estimatedSize) {
    segment.estimatedSize = "10%"; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga un idioma
  if (!segment.language) {
    segment.language = "en"; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga una audiencia objetivo
  if (!segment.targetAudience) {
    segment.targetAudience = "general"; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga un resumen
  if (!segment.summary) {
    segment.summary = segment.description.substring(0, 100) + "..."; // Generar un resumen a partir de la descripción
  }
  
  // Inicializar el estado de creación en la base de datos
  segment.createdInDatabase = false;
  
  // Incluir justificación si se solicita
  if (!segment.rationale && options.includeRationale) {
    segment.rationale = `This segment was identified as profitable based on the analysis of the site ${options.url}.`;
  }
  
  return segment;
} 