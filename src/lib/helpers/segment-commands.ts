import { CommandFactory } from '@/lib/agentbase';
import { commandService, waitForCommandCompletion } from './command-utils';

// Function to execute Growth Marketer segment analysis
export async function executeGrowthMarketerSegmentAnalysis(
  siteId: string,
  agentId: string,
  userId: string,
  context: string,
  segmentCount: number = 5
): Promise<{segmentAnalysisResults: any[] | null, analysisCommandUuid: string | null}> {
  try {
    console.log(`📊 Ejecutando comando de análisis de segmentos con Growth Marketer: ${agentId}`);
    
    // Build context for growth marketer segment analysis
    const growthMarketerPrompt = `Analyze and identify the most profitable audience segments for the website.

ROLE: Growth Marketer - Focus on audience segmentation, targeting precision, and monetization opportunities
OBJECTIVE: Identify high-value audience segments that can drive measurable business growth and ROI

SEGMENT ANALYSIS REQUIREMENTS:
- Identify ${segmentCount} distinct and profitable audience segments
- Focus on segments with high commercial value and clear targeting potential
- Provide comprehensive segment profiles for advertising platforms
- Include detailed demographic, behavioral, and psychographic data
- Estimate segment size and value potential
- Score segments based on profitability and confidence
- Consider monetization opportunities and recommended actions
- Ensure segments are actionable for marketing campaigns

SEGMENT PROFILE ELEMENTS TO DEFINE:
1. Segment identification and naming
2. Detailed demographic characteristics
3. Behavioral patterns and preferences
4. Psychographic profiles and motivations
5. Technology adoption and digital behavior
6. Pain points and challenges
7. Goals and aspirations
8. Preferred communication channels
9. Buying behavior and decision factors
10. Platform-specific targeting criteria

CRITICAL: AUDIENCE PROFILE STRUCTURE REQUIREMENTS:
Each segment MUST include a complete audienceProfile with adPlatforms containing:

1. googleAds:
   - interests: Array of relevant interests/topics
   - locations: Array of countries/regions
   - demographics: {gender, ageRanges, parentalStatus, householdIncome}
   - geoTargeting: {cities, regions, countries}
   - inMarketSegments: Array of relevant market segments

2. facebookAds:
   - interests: Array of interests/topics
   - languages: Array of languages
   - locations: {zips, cities, regions, countries}
   - demographics: {age: [numerical ages], education, generation}

3. linkedInAds:
   - jobTitles: Array of relevant job titles
   - locations: {regions, countries, metropolitanAreas}
   - industries: Array of relevant industries
   - companySize: Array of company size ranges
   - demographics: {age, education, jobExperience}

OUTPUT FORMAT:
Provide comprehensive segment profiles with the following structure:
- Unique segment identifier and descriptive name
- Detailed description and summary
- Estimated audience size and value potential
- Target audience category classification
- Language preference
- Profitability and confidence scores (0-1 scale)
- COMPLETE audienceProfile with ALL three ad platforms (googleAds, facebookAds, linkedInAds)
- Demographic, behavioral, and psychographic attributes
- Monetization opportunities with revenue potential
- Recommended marketing actions and strategies

${context}`;

    // Create command for growth marketer segment analysis
    const analysisCommand = CommandFactory.createCommand({
      task: 'analyze audience segments',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Analyze website and identify the most profitable audience segments',
      targets: [
        {
          deep_thinking: "Analyze the website context and create strategic reasoning for the segment identification approach",
        },
        {
          segments: [{
            name: "Name of the segment",
            description: "Description of the segment",
            summary: "Brief summary of the segment",
            estimatedSize: "number of people",
            estimatedValue: "number of dollars (without currency sign)",
            targetAudience: "Primary audience category from: b2b_saas, e_commerce, media_entertainment, healthcare, finance, education, real_estate, travel, fitness, food_beverage, fashion, automotive, technology, consulting, non_profit, etc.",
            language: "Primary language code for the segment (e.g., en, es, fr, de, it, pt, etc.)",
            audienceProfile: {
              adPlatforms: {
                googleAds: {
                  interests: "Array of relevant interests and topics for Google Ads targeting",
                  locations: "Array of target countries/regions for geographic targeting",
                  demographics: {
                    gender: "Array of gender targets: ['male', 'female', 'all']",
                    ageRanges: "Array of age ranges for Google Ads (e.g., ['18-24', '25-34', '35-44'])",
                    parentalStatus: "Array of parental status options: ['parent', 'not_parent']",
                    householdIncome: "Array of income levels: ['top_10%', 'top_20%', 'top_30%', 'top_50%']"
                  },
                  geoTargeting: {
                    cities: "Array of specific target cities for precise local targeting",
                    regions: "Array of states/provinces/regions for broader geographic reach",
                    countries: "Array of country codes for international targeting (e.g., ['US', 'CA', 'UK'])"
                  },
                  inMarketSegments: "Array of Google's in-market segments relevant to this audience"
                },
                facebookAds: {
                  interests: "Array of Facebook interests and behaviors for targeting",
                  languages: "Array of language preferences for Facebook targeting",
                  locations: {
                    zips: "Array of specific ZIP codes for hyper-local targeting",
                    cities: "Array of city names for urban targeting",
                    regions: "Array of state/region names for broader geographic coverage",
                    countries: "Array of full country names for international campaigns"
                  },
                  demographics: {
                    age: "Array of individual age numbers or age ranges for precise targeting",
                    education: "Array of education levels: ['High school', 'College grad', 'Master's degree', 'Doctorate']",
                    generation: "Array of generational cohorts: ['Gen Z', 'Millennials', 'Gen X', 'Baby Boomers']"
                  }
                },
                linkedInAds: {
                  jobTitles: "Array of specific job titles for professional targeting",
                  locations: {
                    regions: "Array of geographic regions for LinkedIn targeting",
                    countries: "Array of countries for international B2B reach",
                    metropolitanAreas: "Array of metro areas for urban professional targeting"
                  },
                  industries: "Array of LinkedIn industry categories for vertical targeting",
                  companySize: "Array of company size ranges: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']",
                  demographics: {
                    age: "Array of age ranges suitable for professional context",
                    education: "Array of education levels for professional targeting",
                    jobExperience: "Array of seniority levels: ['Entry level', 'Mid-Senior level', 'Director', 'Executive']"
                  }
                }
              }
            },
            attributes: {
              demographic: {
                ageRange: "Primary age range for this segment (e.g., '25-35', '30-45')",
                gender: "Primary gender composition: 'male', 'female', 'mixed', or 'non_binary'",
                income: "Income level descriptor: 'low', 'medium-low', 'medium', 'medium-high', 'high'"
              },
              behavioral: {
                deviceUsage: "Array describing device usage patterns with percentages (e.g., ['mobile (60%)', 'desktop (35%)', 'tablet (5%)'])"
              }
            }
          }]
        }
      ],
      context: growthMarketerPrompt
    });

    // Execute analysis command
    const analysisCommandId = await commandService.submitCommand(analysisCommand);
    console.log(`📈 Growth Marketer segment analysis command created: ${analysisCommandId}`);

    // Wait for analysis completion
    const { command: analysisResult, completed: analysisCompleted, dbUuid } = await waitForCommandCompletion(analysisCommandId);

    if (!analysisCompleted || !analysisResult) {
      console.error('❌ Growth Marketer segment analysis command failed or timed out');
      return { segmentAnalysisResults: null, analysisCommandUuid: dbUuid };
    }

    // Extract analysis results
    let segmentsData = [];
    if (analysisResult.results && Array.isArray(analysisResult.results)) {
      for (const result of analysisResult.results) {
        if (result.segments && Array.isArray(result.segments)) {
          segmentsData = result.segments;
          break;
        }
      }
    }

    console.log(`✅ Growth Marketer segment analysis completed with ${segmentsData.length} segments identified`);
    return { segmentAnalysisResults: segmentsData, analysisCommandUuid: dbUuid };

  } catch (error) {
    console.error('❌ Error executing Growth Marketer segment analysis:', error);
    return { segmentAnalysisResults: null, analysisCommandUuid: null };
  }
}

// Function to execute Growth Marketer ICP analysis
export async function executeGrowthMarketerIcpAnalysis(
  siteId: string,
  agentId: string,
  userId: string,
  context: string,
  existingSegments: any[]
): Promise<{icpAnalysisResults: any[] | null, icpCommandUuid: string | null}> {
  try {
    console.log(`📊 Ejecutando comando de análisis ICP con Growth Marketer: ${agentId}`);
    
    // Build context for growth marketer ICP analysis
    const growthMarketerPrompt = `Perform comprehensive ICP (Ideal Customer Profile) analysis for existing audience segments.

ROLE: Growth Marketer - Focus on deep customer insights, targeting optimization, and personalization strategies
OBJECTIVE: Enhance existing segments with detailed ICP profiles that drive precision targeting and higher conversion rates

ICP ANALYSIS REQUIREMENTS:
- Create comprehensive ICP profiles for each existing segment
- Provide actionable insights for marketing optimization
- Enhance targeting precision for advertising platforms
- Identify personalization opportunities and content strategies
- Define optimal outreach timing and messaging approaches
- Map customer journey and decision-making processes
- Analyze competitive landscape and positioning strategies

ICP PROFILE ELEMENTS TO ENHANCE:
1. Detailed demographic and firmographic data
2. Advanced psychographic and behavioral insights
3. Technology adoption patterns and digital behavior
4. Content consumption preferences and engagement patterns
5. Communication channel preferences and timing
6. Buying journey mapping and decision factors
7. Pain point analysis and solution mapping
8. Competitive analysis and differentiation opportunities
9. Personalization vectors and customization strategies
10. Cross-platform audience mapping and lookalike modeling

OUTPUT FORMAT:
Provide enhanced ICP analysis with the following structure:
- Segment ID reference and enhanced profile
- Detailed demographic and psychographic enhancements
- Advanced behavioral insights and patterns
- Technology and digital behavior analysis
- Enhanced audience profile for advertising platforms
- Personalization opportunities and content strategies
- Optimized messaging and communication approaches
- Cross-platform targeting improvements
- Customer journey optimization insights
- Competitive positioning and differentiation strategies

IMPORTANT:
- In categories like values, interests, provide at least 3 of each.

${context}`;

    // Create command for growth marketer ICP analysis
    const icpCommand = CommandFactory.createCommand({
      task: 'enhance segments with ICP analysis',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Perform detailed ICP analysis for existing audience segments',
      targets: [
        {
          deep_thinking: "Analyze the existing segments and create strategic reasoning for ICP enhancement approach, focusing on demographic precision, behavioral insights, and actionable targeting strategies",
        },
        {
          enhanced_segments: existingSegments.map(segment => ({
            segment_id: segment.id,
            segment_name: segment.name,
            profile: {
              id: `icp_${segment.id}_${Math.random().toString(36).substr(2, 9)}`,
              name: "ICP Profile for " + segment.name,
              description: "Comprehensive ICP analysis based on segment data and market insights for enhanced targeting precision",
              demographics: {
                ageRange: {
                  primary: "Primary age range with specific numbers (e.g., '26-36') and reasoning for why this age group is most valuable",
                  secondary: "Secondary age groups (e.g., '24-25', '37-40') with context about their relevance and market potential"
                },
                gender: {
                  distribution: "Detailed gender distribution with percentages and insights about diversity trends (e.g., 'Predominantly male (60%), female (40%) with increasing diversity trends')"
                },
                locations: [
                  {
                    type: "region",
                    name: "Specific geographic markets with country/region names and strategic importance",
                    relevance: "High/Medium/Low - Detailed explanation of why this location is strategically important for targeting"
                  }
                ],
                education: {
                  primary: "Primary education level with specific degree types and reasoning for relevance to segment",
                  secondary: ["Array of additional education levels", "Professional certifications or programs", "Alternative education paths relevant to segment"]
                },
                income: {
                  currency: "USD",
                  level: "Detailed income level analysis with context about purchasing power and budget allocation patterns",
                  range: "Specific income ranges in USD (e.g., '$60,000 - $200,000') with context about personal vs company budgets"
                },
                languages: [
                  {
                    name: "Primary language(s) spoken",
                    proficiency: "Native/Advanced/Intermediate - Specify proficiency level required for effective communication",
                    relevance: "Very high/High/Medium/Low - Explain why this language proficiency is critical for business success"
                  }
                ]
              },
              psychographics: {
                values: [
                  {
                    name: "Core value that drives decision-making",
                    importance: "High/Medium/Low - Specify impact level on purchasing decisions",
                    description: "Detailed explanation of how this value influences behavior and what it means for targeting strategy"
                  }
                ],
                interests: ["Specific interests and topics that resonate with this segment", "Professional interests", "Personal hobbies", "Industry trends they follow"],
                goals: [
                  {
                    name: "Primary business or personal goal",
                    priority: "High/Medium/Low - Urgency and importance level for this segment",
                    description: "Detailed explanation of what success looks like and how it drives purchasing behavior"
                  }
                ],
                challenges: [
                  {
                    name: "Main challenge or pain point",
                    severity: "High/Medium/Low - Impact level on daily operations or success",
                    description: "Detailed explanation of how this challenge affects the segment and creates opportunity for solutions"
                  }
                ],
                motivations: [
                  {
                    name: "Key motivating factor",
                    strength: "High/Medium/Low - How strongly this motivation drives behavior",
                    description: "Detailed explanation of what drives this motivation and how it influences decision-making"
                  }
                ]
              },
              behavioralTraits: {
                onlineBehavior: {
                  deviceUsage: {
                    primary: "Primary device with reasoning (e.g., 'Desktop - Preferred for complex tasks and analytics')",
                    secondary: "Secondary device usage patterns with context about when and why they use it",
                    tertiary: "Additional device usage if relevant"
                  },
                  socialPlatforms: [
                    {
                      name: "Specific platform name",
                      usageFrequency: "Daily/Weekly/Monthly with specific context about usage patterns",
                      engagementLevel: "High/Medium/Low - Description of how actively they engage vs passively consume",
                      relevance: "Very high/High/Medium/Low - Strategic importance for reaching this segment effectively"
                    }
                  ],
                  browsingHabits: {
                    peakHours: [
                      "Specific time periods with context (e.g., 'Weekdays 8am-12pm for research and decision-making')",
                      "Evening hours for personal browsing and learning"
                    ],
                    contentPreferences: [
                      "Specific types of content they actively seek",
                      "Formats that drive engagement",
                      "Topics that capture their attention"
                    ]
                  }
                },
                purchasingBehavior: {
                  decisionFactors: [
                    {
                      name: "Critical factor in purchase decisions",
                      importance: "High/Medium/Low - Weight this factor carries in final decision",
                      description: "Detailed explanation of why this factor matters and how it should influence marketing messaging"
                    }
                  ],
                  priceRange: {
                    subscription: {
                      monthly: {
                        preference: "Specific range with context (e.g., '$150 - $1,500 - Sweet spot for budget and feature needs')",
                        optimal: "Most effective price point for conversion with reasoning"
                      },
                      annual: {
                        preference: "Annual pricing range with explanation of why annual vs monthly matters",
                        optimal: "Best annual price point that balances value perception with budget constraints"
                      }
                    },
                    oneTime: {
                      preference: "One-time purchase range with context about what drives these purchasing decisions",
                      optimal: "Most effective one-time price point for this segment"
                    }
                  },
                  purchaseFrequency: {
                    software: "Frequency and timing patterns for software purchases with reasoning",
                    hardware: "Hardware purchasing patterns and budget cycles",
                    education: "Learning and development investment patterns"
                  }
                },
                contentConsumption: {
                  preferredFormats: [
                    {
                      type: "Specific content type",
                      preference: "High/Medium/Low - How much they prefer this format",
                      idealLength: "Optimal length for written content with reasoning about attention span",
                      idealDuration: "Optimal duration for video/audio content based on consumption patterns"
                    }
                  ],
                  researchHabits: {
                    depth: "Deep/Medium/Shallow - How thoroughly they research before making decisions",
                    sources: ["Specific sources they trust and regularly consult", "Industry publications", "Peer networks", "Expert opinions"],
                    timeSpent: "Specific timeframes for research phases (e.g., '1 week for tool evaluation, 2-4 weeks for major platform decisions')"
                  }
                }
              },
              professionalContext: {
                industries: ["Primary industries where this segment operates", "Secondary relevant industries", "Emerging sectors"],
                roles: [
                  {
                    title: "Specific job title or role",
                    relevance: "Very high/High/Medium/Low - How closely this role aligns with the ideal customer profile"
                  }
                ],
                companySize: {
                  primary: "Primary company size with specific employee ranges (e.g., '1-10 employees')",
                  secondary: ["Additional company sizes that are relevant", "Growth stage indicators"]
                },
                decisionMakingPower: {
                  level: "High/Medium/Low - Authority level for purchasing decisions",
                  description: "Detailed explanation of decision-making process, approval requirements, and purchasing authority"
                },
                painPoints: [
                  {
                    name: "Professional challenge or pain point",
                    severity: "High/Medium/Low - Impact on daily operations and success",
                    description: "Detailed explanation of how this pain point creates opportunity and urgency for solutions"
                  }
                ],
                tools: {
                  current: ["Specific tools and platforms currently in use", "Technology stack components", "Preferred vendors"],
                  desired: ["Tools and solutions they're actively seeking", "Technology gaps they want to fill", "Future state aspirations"]
                }
              },
              customAttributes: [
                {
                  name: "Unique attribute that defines this segment",
                  value: "Specific value or characteristic with context",
                  description: "Detailed explanation of why this attribute is important for targeting and messaging"
                }
              ]
            }
          }))
        }
      ],
      context: growthMarketerPrompt
    });

    // Execute ICP command
    const icpCommandId = await commandService.submitCommand(icpCommand);
    console.log(`📈 Growth Marketer ICP analysis command created: ${icpCommandId}`);

    // Wait for ICP completion
    const { command: icpResult, completed: icpCompleted, dbUuid } = await waitForCommandCompletion(icpCommandId);

    if (!icpCompleted || !icpResult) {
      console.error('❌ Growth Marketer ICP analysis command failed or timed out');
      return { icpAnalysisResults: null, icpCommandUuid: dbUuid };
    }

    // Extract ICP results
    let enhancedSegmentsData = [];
    console.log(`🔍 DEBUG: icpResult completo:`, JSON.stringify(icpResult, null, 2));
    console.log(`🔍 DEBUG: icpResult.results:`, JSON.stringify(icpResult.results, null, 2));
    
    // NUEVO DEBUG: Análisis detallado de la estructura
    console.log(`🔍 DEBUG ESTRUCTURA - icpResult keys:`, Object.keys(icpResult));
    console.log(`🔍 DEBUG ESTRUCTURA - icpResult.results type:`, typeof icpResult.results);
    console.log(`🔍 DEBUG ESTRUCTURA - icpResult.results is array:`, Array.isArray(icpResult.results));
    console.log(`🔍 DEBUG ESTRUCTURA - icpResult.results length:`, icpResult.results?.length);
    
    if (icpResult.results && Array.isArray(icpResult.results)) {
      console.log(`🔍 DEBUG: Procesando ${icpResult.results.length} resultados del comando`);
      
      // NUEVO DEBUG: Analizar cada resultado individualmente
      icpResult.results.forEach((result: any, index: number) => {
        console.log(`🔍 DEBUG RESULTADO[${index}] - type:`, typeof result);
        console.log(`🔍 DEBUG RESULTADO[${index}] - is null:`, result === null);
        console.log(`🔍 DEBUG RESULTADO[${index}] - keys:`, result ? Object.keys(result) : 'null');
        console.log(`🔍 DEBUG RESULTADO[${index}] - full content:`, JSON.stringify(result, null, 2));
      });
      
      for (let i = 0; i < icpResult.results.length; i++) {
        const result = icpResult.results[i];
        console.log(`🔍 DEBUG: [${i}] Resultado tipo:`, typeof result);
        console.log(`🔍 DEBUG: [${i}] Resultado keys:`, result ? Object.keys(result) : 'null');
        console.log(`🔍 DEBUG: [${i}] Resultado completo:`, JSON.stringify(result, null, 2));
        
        if (result && typeof result === 'object') {
          console.log(`🔍 DEBUG: [${i}] Procesando resultado`);
          
          // Skip if this is only deep_thinking
          if (result.deep_thinking && Object.keys(result).length === 1) {
            console.log(`🔍 DEBUG: [${i}] Saltando resultado que solo contiene deep_thinking`);
            continue;
          }
          
          // NUEVO DEBUG: Verificar propiedades específicas
          console.log(`🔍 DEBUG: [${i}] Verificando propiedades específicas:`);
          console.log(`  - result.enhanced_segments exists:`, !!result.enhanced_segments);
          console.log(`  - result.enhanced_segments is array:`, Array.isArray(result.enhanced_segments));
          console.log(`  - result.enhanced_segments length:`, result.enhanced_segments?.length);
          console.log(`  - result.segments exists:`, !!result.segments);
          console.log(`  - result.segments is array:`, Array.isArray(result.segments));
          console.log(`  - result.segments length:`, result.segments?.length);
          console.log(`  - result is array:`, Array.isArray(result));
          
          // Try different possible structures
          if (result.enhanced_segments && Array.isArray(result.enhanced_segments)) {
            enhancedSegmentsData = result.enhanced_segments;
            console.log(`✅ ENCONTRADO: enhanced_segments en resultado [${i}]`);
            console.log(`🔍 DEBUG: enhanced_segments content:`, JSON.stringify(result.enhanced_segments, null, 2));
            break;
          } else if (result.segments && Array.isArray(result.segments)) {
            enhancedSegmentsData = result.segments;
            console.log(`✅ ENCONTRADO: segments en resultado [${i}]`);
            console.log(`🔍 DEBUG: segments content:`, JSON.stringify(result.segments, null, 2));
            break;
          } else if (Array.isArray(result)) {
            enhancedSegmentsData = result;
            console.log(`✅ ENCONTRADO: resultado directo es array [${i}]`);
            console.log(`🔍 DEBUG: direct array content:`, JSON.stringify(result, null, 2));
            break;
          } else {
            // Search in all properties
            console.log(`🔍 DEBUG: [${i}] Buscando arrays en propiedades del resultado...`);
            for (const [key, value] of Object.entries(result)) {
              if (key === 'deep_thinking') continue; // Skip deep_thinking property
              console.log(`🔍 DEBUG: [${i}] Verificando key "${key}":`, Array.isArray(value) ? `array de ${value.length} elementos` : typeof value);
              if (Array.isArray(value) && value.length > 0) {
                console.log(`🔍 DEBUG: [${i}] Array encontrado en "${key}":`, JSON.stringify(value, null, 2));
                enhancedSegmentsData = value;
                console.log(`✅ ENCONTRADO: datos en key "${key}" del resultado [${i}]`);
                break;
              }
            }
            if (enhancedSegmentsData.length > 0) break;
          }
        } else {
          console.log(`❌ DEBUG: [${i}] Resultado no es objeto válido`);
        }
      }
    } else {
      console.log(`❌ DEBUG: icpResult.results no es un array válido:`, icpResult.results);
    }

    console.log(`📊 EXTRACCIÓN COMPLETADA: ${enhancedSegmentsData.length} segmentos encontrados`);
    
    if (enhancedSegmentsData.length === 0) {
      console.log(`❌ PROBLEMA: No se extrajeron datos del comando completado!`);
      console.log(`🔍 DEBUG: Revisando estructura completa del icpResult...`);
      console.log(`🔍 DEBUG: Object.keys(icpResult):`, Object.keys(icpResult));
      if (icpResult.results) {
        console.log(`🔍 DEBUG: icpResult.results.length:`, icpResult.results.length);
        console.log(`🔍 DEBUG: icpResult.results[0]:`, JSON.stringify(icpResult.results[0], null, 2));
        if (icpResult.results[1]) {
          console.log(`🔍 DEBUG: icpResult.results[1]:`, JSON.stringify(icpResult.results[1], null, 2));
        }
      }
    } else {
      console.log(`✅ DATOS EXTRAÍDOS EXITOSAMENTE:`);
      console.log(`🔍 Primer segmento:`, JSON.stringify(enhancedSegmentsData[0], null, 2));
      
      // Validar que los segmentos tengan los campos necesarios
      for (let i = 0; i < enhancedSegmentsData.length; i++) {
        const segment = enhancedSegmentsData[i];
        console.log(`🔍 VALIDACIÓN Segmento [${i}]:`, {
          tiene_segment_id: !!segment.segment_id,
          tiene_id: !!segment.id,
          tiene_profile: !!segment.profile,
          keys: Object.keys(segment)
        });
      }
    }
    
    return { icpAnalysisResults: enhancedSegmentsData, icpCommandUuid: dbUuid };

  } catch (error) {
    console.error('❌ Error executing Growth Marketer ICP analysis:', error);
    return { icpAnalysisResults: null, icpCommandUuid: null };
  }
} 