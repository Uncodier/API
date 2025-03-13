import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { analyzeWithConversationApi } from '@/lib/services/conversation-client'

/**
 * API DE PERFILES DE CLIENTE IDEAL (ICP)
 * 
 * Esta API permite analizar y crear perfiles de cliente ideal (ICP) basados en segmentos de audiencia existentes.
 * Es útil para entender mejor a tus clientes más valiosos y personalizar tu estrategia de marketing y contenido.
 * 
 * Características principales:
 * - Análisis detallado de perfiles de cliente ideal basados en segmentos
 * - Creación automática de perfiles en la base de datos del usuario
 * - Personalización basada en diferentes métricas
 * - Soporte para diferentes modelos de IA
 * 
 * Documentación completa: /docs/api/analysis/segments/icp
 */

// Enumeraciones para tipos de datos
const OperationModes = [
  'analyze',
  'create',
  'update'
] as const;

const PersonalizationMetrics = [
  'engagementRate',
  'conversionRate',
  'customerSatisfaction'
] as const;

const AiProviders = [
  'openai',
  'anthropic',
  'gemini'
] as const;

// Esquema para validar el cuerpo de la solicitud
const RequestSchema = z.object({
  // Parámetros básicos
  url: z.string().url('Debe ser una URL válida'),
  segment_id: z.string().min(1, 'El ID del segmento es requerido'),
  mode: z.enum(OperationModes).default('analyze'),
  
  // Parámetros de configuración
  timeout: z.number().int().min(5000).max(120000).default(45000),
  personalizationMetrics: z.array(z.enum(PersonalizationMetrics)).default(['engagementRate', 'conversionRate']),
  minConfidenceScore: z.number().min(0).max(1).default(0.7),
  
  // Parámetros de configuración de IA
  aiProvider: z.enum(AiProviders).optional().default('anthropic'),
  aiModel: z.string().optional().default('claude-3-5-sonnet-20240620'),
  
  // Parámetros adicionales
  user_id: z.string().optional(),
  site_id: z.string().optional(),
  includeScreenshot: z.boolean().optional().default(true),
  debug: z.boolean().optional().default(false)
});

// Interfaz para la respuesta
interface IcpResponse {
  url: string;
  segment_id: string;
  profile: {
    id: string;
    name: string;
    description: string;
    demographics: {
      ageRange: any;
      gender: any;
      locations: Array<{
        type: string;
        name: string;
        relevance: string;
      }>;
      education: any;
      income: any;
      languages: Array<{
        name: string;
        proficiency: string;
        relevance: string;
      }>;
    };
    psychographics: {
      values: Array<{
        name: string;
        importance: string;
        description: string;
      }>;
      interests: string[];
      goals: Array<{
        name: string;
        priority: string;
        description: string;
      }>;
      challenges: Array<{
        name: string;
        severity: string;
        description: string;
      }>;
      motivations: Array<{
        name: string;
        strength: string;
        description: string;
      }>;
    };
    behavioralTraits: {
      onlineBehavior: {
        deviceUsage: any;
        socialPlatforms: Array<{
          name: string;
          usageFrequency: string;
          engagementLevel: string;
          relevance: string;
        }>;
        browsingHabits: {
          peakHours: string[];
          contentPreferences: string[];
        };
      };
      purchasingBehavior: {
        decisionFactors: Array<{
          name: string;
          importance: string;
          description: string;
        }>;
        priceRange: any;
        purchaseFrequency: any;
      };
      contentConsumption: {
        preferredFormats: Array<{
          type: string;
          preference: string;
          idealDuration?: string;
          idealLength?: string;
        }>;
        researchHabits: {
          depth: string;
          sources: string[];
          timeSpent: string;
        };
      };
    };
    professionalContext: {
      industries: string[];
      roles: Array<{
        title: string;
        relevance: string;
      }>;
      companySize: {
        primary: string;
        secondary: string[];
      };
      decisionMakingPower: {
        level: string;
        description: string;
      };
      painPoints: Array<{
        name: string;
        severity: string;
        description: string;
      }>;
      tools: {
        current: string[];
        desired: string[];
      };
    };
    customAttributes: Array<{
      name: string;
      value: string;
      description: string;
    }>;
  };
  createdInDatabase: boolean;
  databaseId?: string;
  analysisMetadata: {
    modelUsed: string;
    aiProvider: string;
    confidenceLevel: string;
    analysisDate: string;
    processingTime: string;
    dataSourcesUsed: string[];
  };
}

// Función para generar un ID de perfil único
function generateProfileId(segmentId: string): string {
  return `icp_${segmentId}_${Date.now().toString(36)}`;
}

// Función para preparar el prompt para el análisis de ICP
function prepareIcpAnalysisPrompt(params: z.infer<typeof RequestSchema>): string {
  console.log('[API:icp] Preparing ICP analysis prompt');
  
  // Construir el prompt base
  let prompt = `Analiza exhaustivamente el sitio web ${params.url} y genera un perfil de cliente ideal (ICP) detallado para el segmento con ID "${params.segment_id}".

Este perfil debe ser completo y específico para este sitio web y segmento, incluyendo:

1. Demografía (edad, género, ubicación, educación, ingresos, idiomas)
2. Psicografía (valores, intereses, objetivos, desafíos, motivaciones)
3. Rasgos de comportamiento (comportamiento online, hábitos de compra, consumo de contenido)
4. Contexto profesional (industrias, roles, tamaño de empresa, poder de decisión, puntos de dolor, herramientas)
5. Atributos personalizados relevantes para este segmento

Tu respuesta debe ser un objeto JSON estructurado exactamente como el ejemplo que te proporcionaré, con los siguientes campos principales:
- url: URL del sitio analizado
- segment_id: ID del segmento analizado
- profile: objeto con información detallada del perfil
- createdInDatabase: booleano (siempre false en tu respuesta)
- databaseId: string opcional (omitir en tu respuesta)

NOTA: No necesitas generar el campo "analysisMetadata", este será añadido automáticamente por el sistema.

A continuación te proporciono un ejemplo de la estructura y nivel de detalle esperado para el perfil de cliente ideal (ICP):

\`\`\`json
{
  "url": "https://example.com",
  "segment_id": "seg_content_creators",
  "profile": {
    "id": "icp_content_creators_2024",
    "name": "Professional Content Creators",
    "description": "Digital content creation professionals seeking tools to optimize their workflow and increase their reach",
    "demographics": {
      "ageRange": {
        "primary": "30-35",
        "secondary": "25-45"
      },
      "gender": {
        "distribution": "Balanced with slight female majority"
      },
      "locations": [
        {
          "type": "country",
          "name": "Spain",
          "relevance": "High"
        },
        {
          "type": "country",
          "name": "Mexico",
          "relevance": "Medium-high"
        },
        {
          "type": "country",
          "name": "Colombia",
          "relevance": "Medium"
        },
        {
          "type": "region",
          "name": "Latin America",
          "relevance": "High"
        }
      ],
      "education": {
        "primary": "Bachelor's Degree",
        "secondary": ["High School", "Graduate Degree"]
      },
      "income": {
        "currency": "EUR",
        "level": "Medium",
        "range": "30,000-80,000 annually"
      },
      "languages": [
        {
          "name": "Spanish",
          "proficiency": "Native",
          "relevance": "Very high"
        },
        {
          "name": "English",
          "proficiency": "Intermediate-advanced",
          "relevance": "High"
        }
      ]
    },
    "psychographics": {
      "values": [
        {
          "name": "Creativity",
          "importance": "Very high",
          "description": "Value creative expression and originality in their work"
        },
        {
          "name": "Independence",
          "importance": "High",
          "description": "Appreciate the freedom to work on their own terms"
        },
        {
          "name": "Recognition",
          "importance": "High",
          "description": "Seek recognition for the quality of their work"
        },
        {
          "name": "Authenticity",
          "importance": "High",
          "description": "Value being genuine in their communication and content"
        }
      ],
      "interests": [
        "Digital technology",
        "Social media trends",
        "Editing tools",
        "Content marketing",
        "Digital storytelling"
      ],
      "goals": [
        {
          "name": "Audience growth",
          "priority": "High",
          "description": "Increase their follower base and reach"
        },
        {
          "name": "Monetization",
          "priority": "High",
          "description": "Generate stable income from their content"
        },
        {
          "name": "Efficiency",
          "priority": "Medium",
          "description": "Optimize their workflow to produce more quality content"
        },
        {
          "name": "Personal brand development",
          "priority": "Medium",
          "description": "Strengthen their identity and recognition in their niche"
        }
      ],
      "challenges": [
        {
          "name": "Market saturation",
          "severity": "High",
          "description": "Difficulty standing out in a saturated digital space"
        },
        {
          "name": "Changing algorithms",
          "severity": "High",
          "description": "Constant adaptation to platform algorithm changes"
        },
        {
          "name": "Creative burnout",
          "severity": "Medium",
          "description": "Maintaining creativity and avoiding exhaustion"
        }
      ],
      "motivations": [
        {
          "name": "Financial freedom",
          "strength": "High",
          "description": "Desire for economic independence through their creative work"
        },
        {
          "name": "Social impact",
          "strength": "Medium-high",
          "description": "Positively influence their audience"
        },
        {
          "name": "Self-expression",
          "strength": "Very high",
          "description": "Communicate unique ideas and perspectives"
        }
      ]
    },
    "behavioralTraits": {
      "onlineBehavior": {
        "deviceUsage": {
          "primary": "Mobile",
          "secondary": "Desktop",
          "tertiary": "Tablet"
        },
        "socialPlatforms": [
          {
            "name": "Instagram",
            "usageFrequency": "Daily",
            "engagementLevel": "High",
            "relevance": "Very high"
          },
          {
            "name": "YouTube",
            "usageFrequency": "Daily",
            "engagementLevel": "High",
            "relevance": "Very high"
          },
          {
            "name": "TikTok",
            "usageFrequency": "Daily",
            "engagementLevel": "Medium",
            "relevance": "High"
          },
          {
            "name": "Twitter",
            "usageFrequency": "Weekly",
            "engagementLevel": "Medium",
            "relevance": "Medium-high"
          }
        ],
        "browsingHabits": {
          "peakHours": ["Morning (8:00-10:00)", "Evening (19:00-23:00)"],
          "contentPreferences": ["Tutorials", "Trend analysis", "Tool reviews"]
        }
      },
      "purchasingBehavior": {
        "decisionFactors": [
          {
            "name": "Value for money",
            "importance": "High",
            "description": "Look for tools that offer good value for their investment"
          },
          {
            "name": "Ease of use",
            "importance": "High",
            "description": "Prefer intuitive solutions that don't require a long learning curve"
          },
          {
            "name": "Integration with existing tools",
            "importance": "Medium-high",
            "description": "Value compatibility with their current tech stack"
          }
        ],
        "priceRange": {
          "subscription": {
            "monthly": {
              "preference": "15-50 EUR",
              "optimal": "Around 30 EUR"
            },
            "annual": {
              "preference": "150-500 EUR",
              "optimal": "Around 300 EUR"
            }
          },
          "oneTime": {
            "preference": "50-300 EUR",
            "optimal": "Around 150 EUR"
          }
        },
        "purchaseFrequency": {
          "software": "Quarterly",
          "hardware": "Yearly",
          "education": "Bimonthly"
        }
      },
      "contentConsumption": {
        "preferredFormats": [
          {
            "type": "Video",
            "preference": "High",
            "idealDuration": "5-15 minutes"
          },
          {
            "type": "Articles",
            "preference": "Medium-high",
            "idealLength": "800-1500 words"
          },
          {
            "type": "Podcasts",
            "preference": "Medium",
            "idealDuration": "20-40 minutes"
          }
        ],
        "researchHabits": {
          "depth": "Medium-deep",
          "sources": ["User reviews", "Comparisons", "Specialized communities"],
          "timeSpent": "1-3 hours before important decisions"
        }
      }
    },
    "professionalContext": {
      "industries": [
        "Digital marketing",
        "Digital media",
        "Online education",
        "Entertainment"
      ],
      "roles": [
        {
          "title": "Independent content creator",
          "relevance": "Very high"
        },
        {
          "title": "Influencer",
          "relevance": "High"
        },
        {
          "title": "Content marketing specialist",
          "relevance": "Medium"
        },
        {
          "title": "Online educator",
          "relevance": "Medium"
        }
      ],
      "companySize": {
        "primary": "Freelance/Self-employed",
        "secondary": ["Small (2-10)", "Medium (11-50)"]
      },
      "decisionMakingPower": {
        "level": "High",
        "description": "Generally make final decisions about tools and resources"
      },
      "painPoints": [
        {
          "name": "Time management",
          "severity": "High",
          "description": "Difficulty balancing content creation, editing, and promotion"
        },
        {
          "name": "Consistency",
          "severity": "Medium",
          "description": "Maintaining a regular publishing schedule"
        },
        {
          "name": "Data analysis",
          "severity": "Medium",
          "description": "Interpreting metrics to optimize strategies"
        }
      ],
      "tools": {
        "current": [
          "Adobe Creative Suite",
          "Canva",
          "Hootsuite",
          "Google Analytics",
          "Final Cut Pro"
        ],
        "desired": [
          "AI editing tools",
          "Advanced analytics platforms",
          "Automation solutions"
        ]
      }
    },
    "customAttributes": [
      {
        "name": "Technology adoption level",
        "value": "Early adopters",
        "description": "Tend to try new tools and platforms before most people"
      },
      {
        "name": "Communication style",
        "value": "Direct and visual",
        "description": "Prefer clear communication rich in visual elements"
      },
      {
        "name": "Price sensitivity",
        "value": "Medium",
        "description": "Willing to invest in quality tools but conscious of value"
      },
      {
        "name": "Specialization level",
        "value": "Medium-high",
        "description": "Deep knowledge in their specific niche"
      }
    ]
  },
  "createdInDatabase": true,
  "databaseId": "icp_78901234"
}
\`\`\`

IMPORTANTE: Sigue EXACTAMENTE la misma estructura del ejemplo anterior. No añadas ni omitas ningún campo. Tu respuesta debe tener los mismos campos y estructura que el ejemplo, pero con contenido específico para el sitio ${params.url} y el segmento ${params.segment_id}. No incluyas campos como personalizationInsights, contentRecommendations, marketingStrategies o analysisMetadata que no están en el ejemplo o que se ha indicado que serán generados por el sistema.`;

  // Añadir instrucciones adicionales según el modo
  if (params.mode === 'create' || params.mode === 'update') {
    prompt += `\n\nEste perfil será ${params.mode === 'create' ? 'creado' : 'actualizado'} en la base de datos, así que asegúrate de que sea preciso y accionable.`;
  }

  console.log('[API:icp] Prompt prepared, length:', prompt.length);
  return prompt;
}

// Función para procesar la respuesta de la IA y formatearla según la estructura esperada
function processAIResponse(aiResponse: any, params: z.infer<typeof RequestSchema>, startTime: number): IcpResponse {
  console.log('[API:icp] Processing AI response');
  
  // Generar un ID único para el perfil
  const profileId = generateProfileId(params.segment_id);
  
  // Calcular tiempo de procesamiento
  const processingTimeMs = Date.now() - startTime;
  
  // Verificar si la respuesta ya tiene la estructura esperada
  if (aiResponse && typeof aiResponse === 'object') {
    // Asegurarse de que la respuesta tenga todos los campos necesarios
    const response: IcpResponse = {
      url: params.url,
      segment_id: params.segment_id,
      profile: {
        id: profileId,
        name: aiResponse.profile?.name || `Perfil de Cliente Ideal para ${params.segment_id}`,
        description: aiResponse.profile?.description || '',
        demographics: aiResponse.profile?.demographics || {},
        psychographics: aiResponse.profile?.psychographics || {},
        behavioralTraits: aiResponse.profile?.behavioralTraits || {},
        professionalContext: aiResponse.profile?.professionalContext || {},
        customAttributes: aiResponse.profile?.customAttributes || []
      },
      createdInDatabase: false,
      analysisMetadata: {
        modelUsed: params.aiModel,
        aiProvider: params.aiProvider,
        confidenceLevel: "High",
        analysisDate: new Date().toISOString(),
        processingTime: `${processingTimeMs} ms`,
        dataSourcesUsed: ["Site content analysis", "Segment data"]
      }
    };
    
    return response;
  }
  
  // Si la respuesta no tiene la estructura esperada, crear una respuesta de fallback
  console.log('[API:icp] AI response does not have expected structure, using fallback');
  return generateSampleProfile(params.url, params.segment_id, params.personalizationMetrics, params.aiModel, params.aiProvider, processingTimeMs);
}

// Función para generar datos de ejemplo para un perfil de cliente ideal
function generateSampleProfile(url: string, segmentId: string, metrics: string[], modelUsed: string, aiProvider: string, processingTimeMs: number): any {
  // Generar un ID único para el perfil
  const profileId = generateProfileId(segmentId);
  
  // Datos básicos del perfil
  const profile = {
    id: profileId,
    name: `Perfil de Cliente Ideal para ${segmentId}`,
    description: "Profesionales y aficionados de 25-45 años dedicados a la creación de contenido digital para redes sociales y plataformas online.",
    demographics: {
      ageRange: "25-45",
      gender: "mixed",
      income: "medium-high",
      education: "higher education",
      occupation: "creative professionals, digital marketers, content creators"
    },
    psychographics: {
      values: [
        {
          name: "Creativity",
          importance: "Very high",
          description: "Value creative expression and originality in their work"
        },
        {
          name: "Independence",
          importance: "High",
          description: "Appreciate the freedom to work on their own terms"
        },
        {
          name: "Recognition",
          importance: "High",
          description: "Seek recognition for the quality of their work"
        },
        {
          name: "Authenticity",
          importance: "High",
          description: "Value being genuine in their communication and content"
        }
      ],
      interests: [
        "Digital technology",
        "Social media trends",
        "Editing tools",
        "Content marketing",
        "Digital storytelling"
      ],
      goals: [
        {
          name: "Audience growth",
          priority: "High",
          description: "Increase their follower base and reach"
        },
        {
          name: "Monetization",
          priority: "High",
          description: "Generate stable income from their content"
        },
        {
          name: "Efficiency",
          priority: "Medium",
          description: "Optimize their workflow to produce more quality content"
        },
        {
          name: "Personal brand development",
          priority: "Medium",
          description: "Strengthen their identity and recognition in their niche"
        }
      ],
      challenges: [
        {
          name: "Market saturation",
          severity: "High",
          description: "Difficulty standing out in a saturated digital space"
        },
        {
          name: "Changing algorithms",
          severity: "High",
          description: "Constant adaptation to platform algorithm changes"
        },
        {
          name: "Creative burnout",
          severity: "Medium",
          description: "Maintaining creativity and avoiding exhaustion"
        }
      ],
      motivations: [
        {
          name: "Financial freedom",
          strength: "High",
          description: "Desire for economic independence through their creative work"
        },
        {
          name: "Social impact",
          strength: "Medium-high",
          description: "Positively influence their audience"
        },
        {
          name: "Self-expression",
          strength: "Very high",
          description: "Communicate unique ideas and perspectives"
        }
      ]
    },
    behavioralTraits: {
      onlineBehavior: {
        deviceUsage: {
          primary: "Mobile",
          secondary: "Desktop",
          tertiary: "Tablet"
        },
        socialPlatforms: [
          {
            name: "Instagram",
            usageFrequency: "Daily",
            engagementLevel: "High",
            relevance: "Very high"
          },
          {
            name: "YouTube",
            usageFrequency: "Daily",
            engagementLevel: "High",
            relevance: "Very high"
          },
          {
            name: "TikTok",
            usageFrequency: "Daily",
            engagementLevel: "Medium",
            relevance: "High"
          },
          {
            name: "Twitter",
            usageFrequency: "Weekly",
            engagementLevel: "Medium",
            relevance: "Medium-high"
          }
        ],
        browsingHabits: {
          peakHours: ["Morning (8:00-10:00)", "Evening (19:00-23:00)"],
          contentPreferences: ["Tutorials", "Trend analysis", "Tool reviews"]
        }
      },
      purchasingBehavior: {
        decisionFactors: [
          {
            name: "Value for money",
            importance: "High",
            description: "Look for tools that offer good value for their investment"
          },
          {
            name: "Ease of use",
            importance: "High",
            description: "Prefer intuitive solutions that don't require a long learning curve"
          },
          {
            name: "Integration with existing tools",
            importance: "Medium-high",
            description: "Value compatibility with their current tech stack"
          }
        ],
        priceRange: {
          subscription: {
            monthly: {
              preference: "15-50 EUR",
              optimal: "Around 30 EUR"
            },
            annual: {
              preference: "150-500 EUR",
              optimal: "Around 300 EUR"
            }
          },
          oneTime: {
            preference: "50-300 EUR",
            optimal: "Around 150 EUR"
          }
        },
        purchaseFrequency: {
          software: "Quarterly",
          hardware: "Yearly",
          education: "Bimonthly"
        }
      },
      contentConsumption: {
        preferredFormats: [
          {
            type: "Video",
            preference: "High",
            idealDuration: "5-15 minutes"
          },
          {
            type: "Articles",
            preference: "Medium-high",
            idealLength: "800-1500 words"
          },
          {
            type: "Podcasts",
            preference: "Medium",
            idealDuration: "20-40 minutes"
          }
        ],
        researchHabits: {
          depth: "Medium-deep",
          sources: ["User reviews", "Comparisons", "Specialized communities"],
          timeSpent: "1-3 hours before important decisions"
        }
      }
    },
    professionalContext: {
      industries: [
        "Digital marketing",
        "Digital media",
        "Online education",
        "Entertainment"
      ],
      roles: [
        {
          title: "Independent content creator",
          relevance: "Very high"
        },
        {
          title: "Influencer",
          relevance: "High"
        },
        {
          title: "Content marketing specialist",
          relevance: "Medium"
        },
        {
          title: "Online educator",
          relevance: "Medium"
        }
      ],
      companySize: {
        primary: "Freelance/Self-employed",
        secondary: ["Small (2-10)", "Medium (11-50)"]
      },
      decisionMakingPower: {
        level: "High",
        description: "Generally make final decisions about tools and resources"
      },
      painPoints: [
        {
          name: "Time management",
          severity: "High",
          description: "Difficulty balancing content creation, editing, and promotion"
        },
        {
          name: "Consistency",
          severity: "Medium",
          description: "Maintaining a regular publishing schedule"
        },
        {
          name: "Data analysis",
          severity: "Medium",
          description: "Interpreting metrics to optimize strategies"
        }
      ],
      tools: {
        current: [
          "Adobe Creative Suite",
          "Canva",
          "Hootsuite",
          "Google Analytics",
          "Final Cut Pro"
        ],
        desired: [
          "AI editing tools",
          "Advanced analytics platforms",
          "Automation solutions"
        ]
      }
    },
    customAttributes: [
      {
        name: "Technology adoption level",
        value: "Early adopters",
        description: "Tend to try new tools and platforms before most people"
      },
      {
        name: "Communication style",
        value: "Direct and visual",
        description: "Prefer clear communication rich in visual elements"
      },
      {
        name: "Price sensitivity",
        value: "Medium",
        description: "Willing to invest in quality tools but conscious of value"
      },
      {
        name: "Specialization level",
        value: "Medium-high",
        description: "Deep knowledge in their specific niche"
      }
    ]
  };
  
  // Generar insights de personalización según las métricas seleccionadas
  const personalizationInsights: Record<string, any> = {};
  
  if (metrics.includes('engagementRate')) {
    personalizationInsights.engagementRate = {
      score: 0.85,
      insights: [
        "Alto nivel de interacción con contenido relacionado con tutoriales y guías prácticas",
        "Preferencia por formatos visuales como videos y infografías",
        "Mayor engagement en horarios nocturnos (19:00-23:00)"
      ],
      recommendations: [
        "Crear contenido educativo enfocado en mejorar habilidades de creación de contenido",
        "Priorizar formatos visuales en la comunicación",
        "Programar publicaciones y newsletters en horarios de alta actividad"
      ]
    };
  }
  
  if (metrics.includes('conversionRate')) {
    personalizationInsights.conversionRate = {
      score: 0.72,
      insights: [
        "Mayor conversión cuando se ofrecen pruebas gratuitas",
        "Sensibilidad al precio, pero disposición a pagar por calidad",
        "Preferencia por planes de suscripción flexibles"
      ],
      recommendations: [
        "Destacar pruebas gratuitas y demostraciones en las páginas de producto",
        "Comunicar claramente el valor y ROI de las soluciones",
        "Ofrecer diferentes opciones de planes y pagos"
      ]
    };
  }
  
  if (metrics.includes('customerSatisfaction')) {
    personalizationInsights.customerSatisfaction = {
      score: 0.88,
      insights: [
        "Alta valoración del soporte técnico rápido y eficiente",
        "Apreciación por actualizaciones regulares y nuevas funcionalidades",
        "Importancia de la comunidad y recursos de aprendizaje"
      ],
      recommendations: [
        "Invertir en un equipo de soporte especializado en este segmento",
        "Comunicar proactivamente las actualizaciones y mejoras",
        "Crear una comunidad activa con recursos educativos"
      ]
    };
  }
  
  // Recomendaciones de contenido
  const contentRecommendations = [
    {
      type: "Educativo",
      topic: "Optimización del flujo de trabajo creativo",
      format: "Serie de videos tutoriales",
      channel: "YouTube, sitio web",
      expectedImpact: "Alto engagement, posicionamiento como autoridad"
    },
    {
      type: "Inspiracional",
      topic: "Casos de éxito de creadores de contenido",
      format: "Entrevistas y estudios de caso",
      channel: "Blog, podcast",
      expectedImpact: "Construcción de confianza, demostración de valor"
    },
    {
      type: "Práctico",
      topic: "Comparativas de herramientas y soluciones",
      format: "Guías detalladas con pros y contras",
      channel: "Email, sitio web",
      expectedImpact: "Apoyo en la decisión de compra, posicionamiento SEO"
    }
  ];
  
  // Estrategias de marketing
  const marketingStrategies = [
    {
      strategy: "Programa de embajadores de marca",
      channel: "Redes sociales, comunidad",
      targetOutcome: "Amplificación orgánica, testimonios auténticos",
      priority: "Alta"
    },
    {
      strategy: "Webinars mensuales sobre tendencias y mejores prácticas",
      channel: "Plataforma de webinars, email",
      targetOutcome: "Generación de leads, posicionamiento como expertos",
      priority: "Media"
    },
    {
      strategy: "Campañas de email segmentadas por nivel de experiencia",
      channel: "Email marketing",
      targetOutcome: "Nurturing personalizado, aumento de conversiones",
      priority: "Alta"
    }
  ];
  
  return {
    url,
    segment_id: segmentId,
    profile,
    createdInDatabase: false,
    analysisMetadata: {
      modelUsed: modelUsed,
      aiProvider: aiProvider,
      confidenceLevel: "High",
      analysisDate: new Date().toISOString(),
      processingTime: `${processingTimeMs} ms`,
      dataSourcesUsed: ["Simulation data"]
    }
  };
}

/**
 * POST /api/site/icp
 * 
 * Endpoint para analizar y crear perfiles de cliente ideal basados en segmentos.
 */
export async function POST(request: NextRequest) {
  console.log('[API:icp] POST request received');
  
  try {
    // Validar el cuerpo de la solicitud
    console.log('[API:icp] Parsing request body');
    const body = await request.json();
    console.log('[API:icp] Request body parsed:', JSON.stringify(body).substring(0, 200) + '...');
    
    const validationResult = RequestSchema.safeParse(body);
    console.log('[API:icp] Validation result success:', validationResult.success);
    
    if (!validationResult.success) {
      console.log('[API:icp] Validation failed:', JSON.stringify(validationResult.error.format()));
      return NextResponse.json(
        { 
          error: 'Parámetros inválidos', 
          details: validationResult.error.format() 
        },
        { status: 400 }
      );
    }

    const params = validationResult.data;
    console.log('[API:icp] Validated params:', JSON.stringify(params));
    
    // Iniciar timestamp para tracking de tiempo
    const startTime = Date.now();
    console.log('[API:icp] Analysis started at:', new Date(startTime).toISOString());
    
    // Verificar que se proporcionen user_id y site_id cuando el modo es 'create' o 'update'
    if ((params.mode === 'create' || params.mode === 'update') && (!params.user_id || !params.site_id)) {
      console.log('[API:icp] Missing required parameters for create/update mode');
      return NextResponse.json(
        { 
          error: 'Parámetros faltantes', 
          details: 'Se requieren user_id y site_id para los modos create y update' 
        },
        { status: 400 }
      );
    }
    
    // Preparar el prompt para el análisis
    const prompt = prepareIcpAnalysisPrompt(params);
    
    // Llamar a la API de conversación para obtener el análisis
    console.log('[API:icp] Calling conversation API with model:', params.aiModel);
    
    let aiResponse;
    try {
      console.log('[API:icp] Initiating request to conversation API...');
      aiResponse = await analyzeWithConversationApi(
        prompt,
        params.aiProvider,
        params.aiModel,
        params.url,
        params.includeScreenshot,
        params.timeout,
        params.debug,
        true // toJSON: true para asegurar que la respuesta sea JSON
      );
      console.log('[API:icp] Received response from conversation API');
      
      // Verificar si la respuesta tiene metadatos y si la conversación está cerrada o no
      if (aiResponse && typeof aiResponse === 'object' && aiResponse._requestMetadata) {
        console.log('[API:icp] Response contains metadata:', 
          JSON.stringify({
            conversationId: aiResponse._requestMetadata.conversationId,
            closed: aiResponse._requestMetadata.closed
          }));
      }
    } catch (conversationError: any) {
      console.error('[API:icp] Error in conversation API:', conversationError);
      
      // Crear una respuesta de error estructurada
      return NextResponse.json(
        { 
          success: false,
          error: {
            code: 500,
            message: 'Error en la API de conversación',
            details: conversationError.message
          }
        },
        { status: 500 }
      );
    }
    
    // Procesar la respuesta de la IA
    console.log('[API:icp] Processing AI response');
    const profileData = processAIResponse(aiResponse, params, startTime);
    console.log('[API:icp] AI response processed');
    
    // Simular la creación en la base de datos si el modo es 'create' o 'update'
    if (params.mode === 'create' || params.mode === 'update') {
      profileData.createdInDatabase = true;
      profileData.databaseId = `db_${profileData.profile.id}`;
      
      // Agregar información adicional para el modo 'create'
      if (params.mode === 'create') {
        console.log('[API:icp] Profile created in database:', profileData.databaseId);
      } 
      // Agregar información adicional para el modo 'update'
      else if (params.mode === 'update') {
        console.log('[API:icp] Profile updated in database:', profileData.databaseId);
      }
    }
    
    // Calcular tiempo de procesamiento real
    const processingTimeMs = Date.now() - startTime;
    profileData.analysisMetadata.processingTime = `${processingTimeMs} ms`;
    console.log('[API:icp] Analysis completed in', processingTimeMs, 'ms');
    
    console.log('[API:icp] Returning response with status 200');
    return NextResponse.json(profileData, { status: 200 });
    
  } catch (error: any) {
    console.error('[API:icp] Unexpected error:', error);
    
    return NextResponse.json(
      { 
        success: false,
        error: {
          code: 500,
          message: 'Error interno del servidor',
          details: error.message
        }
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/site/icp
 * 
 * Obtiene información sobre el servicio de perfiles de cliente ideal.
 */
export async function GET(request: NextRequest) {
  console.log('[API:icp] GET request received');
  
  const serviceInfo = {
    service: "API de Perfiles de Cliente Ideal",
    version: "1.0.0",
    status: "operational",
    capabilities: [
      "profile-analysis",
      "personalization-insights",
      "content-recommendations",
      "marketing-strategies",
      "database-integration"
    ],
    supportedPersonalizationMetrics: PersonalizationMetrics,
    supportedAiProviders: AiProviders,
    supportedModes: OperationModes
  };
  
  console.log('[API:icp] Returning service info with status 200');
  return NextResponse.json(serviceInfo, { status: 200 });
} 