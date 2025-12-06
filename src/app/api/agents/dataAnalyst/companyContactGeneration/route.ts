import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Configure maximum timeout to 5 minutes (300 seconds)
// Maximum for Vercel Pro plan
export const maxDuration = 300;

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Function to validate domain
function isValidDomain(domain: string): boolean {
  // Allow subdomains: sub.example.com, example.com, example-test.co.uk
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

// Function to find agent with role "Data Analyst"
async function findDataAnalystAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Data Analyst')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error searching for Data Analyst agent:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No active Data Analyst agent found for site: ${siteId}`);
      return null;
    }
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error searching for Data Analyst agent:', error);
    return null;
  }
}

// Function to detect language and region from domain
function detectLanguageAndRegionFromDomain(domain: string): {language: string, region: string, cultural_patterns: string[]} {
  const domainLower = domain.toLowerCase();
  
  // Extract TLD
  const tldMatch = domainLower.match(/\.([a-z]{2,})$/);
  const tld = tldMatch ? tldMatch[1] : '';
  
  // TLD to language/region mapping
  const tldMapping: { [key: string]: { language: string, region: string, cultural_patterns: string[] } } = {
    'es': { language: 'spanish', region: 'spain', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'mx': { language: 'spanish', region: 'mexico', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'ar': { language: 'spanish', region: 'argentina', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'co': { language: 'spanish', region: 'colombia', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'cl': { language: 'spanish', region: 'chile', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'fr': { language: 'french', region: 'france', cultural_patterns: ['hyphenated_names', 'formal_address'] },
    'de': { language: 'german', region: 'germany', cultural_patterns: ['compound_names', 'professional_titles'] },
    'it': { language: 'italian', region: 'italy', cultural_patterns: ['multiple_surnames', 'regional_variations'] },
    'nl': { language: 'dutch', region: 'netherlands', cultural_patterns: ['tussenvoegsel', 'compound_surnames'] },
    'br': { language: 'portuguese', region: 'brazil', cultural_patterns: ['compound_names', 'informal_address'] },
    'pt': { language: 'portuguese', region: 'portugal', cultural_patterns: ['multiple_surnames', 'formal_address'] },
    'uk': { language: 'british', region: 'united_kingdom', cultural_patterns: ['standard_international'] },
    'au': { language: 'australian', region: 'australia', cultural_patterns: ['standard_international'] },
    'ie': { language: 'irish', region: 'ireland', cultural_patterns: ['standard_international'] },
    'ca': { language: 'bilingual', region: 'canada', cultural_patterns: ['standard_international'] }
  };
  
  // Check TLD first
  if (tld && tldMapping[tld]) {
    return tldMapping[tld];
  }
  
  // Check domain name for regional keywords
  const domainKeywords = {
    'spain': { language: 'spanish', region: 'spain', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'mexico': { language: 'spanish', region: 'mexico', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'argentina': { language: 'spanish', region: 'argentina', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'colombia': { language: 'spanish', region: 'colombia', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'chile': { language: 'spanish', region: 'chile', cultural_patterns: ['compound_first_names', 'maternal_surnames', 'formal_titles'] },
    'france': { language: 'french', region: 'france', cultural_patterns: ['hyphenated_names', 'formal_address'] },
    'germany': { language: 'german', region: 'germany', cultural_patterns: ['compound_names', 'professional_titles'] },
    'italy': { language: 'italian', region: 'italy', cultural_patterns: ['multiple_surnames', 'regional_variations'] },
    'netherlands': { language: 'dutch', region: 'netherlands', cultural_patterns: ['tussenvoegsel', 'compound_surnames'] },
    'brazil': { language: 'portuguese', region: 'brazil', cultural_patterns: ['compound_names', 'informal_address'] },
    'portugal': { language: 'portuguese', region: 'portugal', cultural_patterns: ['multiple_surnames', 'formal_address'] }
  };
  
  for (const [keyword, info] of Object.entries(domainKeywords)) {
    if (domainLower.includes(keyword)) {
      return info;
    }
  }
  
  // Default to English/International
  return {
    language: 'english',
    region: 'international',
    cultural_patterns: ['standard_international']
  };
}

// Function to generate basic generic company contact emails as fallback
function generateGenericCompanyContacts(domain: string, language: string, region: string): string[] {
  const contacts: string[] = [];
  
  // General contacts (language-aware)
  if (language === 'spanish' || region.includes('hispanic') || region.includes('spain') || region.includes('mexico') || region.includes('argentina') || region.includes('colombia') || region.includes('chile')) {
    contacts.push(`info@${domain}`);
    contacts.push(`contacto@${domain}`);
    contacts.push(`admin@${domain}`);
    contacts.push(`hola@${domain}`);
    contacts.push(`ventas@${domain}`);
    contacts.push(`marketing@${domain}`);
    contacts.push(`rrhh@${domain}`);
    contacts.push(`finanzas@${domain}`);
    contacts.push(`operaciones@${domain}`);
    contacts.push(`gerencia@${domain}`);
    contacts.push(`direccion@${domain}`);
    contacts.push(`ejecutivos@${domain}`);
    contacts.push(`oficina@${domain}`);
    contacts.push(`equipo@${domain}`);
    contacts.push(`general@${domain}`);
  } else {
    contacts.push(`info@${domain}`);
    contacts.push(`contact@${domain}`);
    contacts.push(`admin@${domain}`);
    contacts.push(`hello@${domain}`);
    contacts.push(`sales@${domain}`);
    contacts.push(`marketing@${domain}`);
    contacts.push(`hr@${domain}`);
    contacts.push(`finance@${domain}`);
    contacts.push(`operations@${domain}`);
    contacts.push(`management@${domain}`);
    contacts.push(`executive@${domain}`);
    contacts.push(`leadership@${domain}`);
    contacts.push(`business@${domain}`);
    contacts.push(`office@${domain}`);
    contacts.push(`team@${domain}`);
    contacts.push(`general@${domain}`);
  }
  
  return contacts;
}

// Initialize command system
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { domain, site_id } = body;
    
    // Validate required parameters
    if (!domain || !site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'domain and site_id are required' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidDomain(domain)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'domain must be a valid domain format (e.g., company.com)' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Find Data Analyst agent
    const dataAnalystAgent = await findDataAnalystAgent(site_id);
    if (!dataAnalystAgent) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATA_ANALYST_NOT_FOUND', 
            message: 'No active Data Analyst agent found for this site' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log(`📧 Starting generic company contact generation for domain: ${domain}`);
    
    // Detect language and region from domain
    const culturalInfo = detectLanguageAndRegionFromDomain(domain);
    
    // Generate basic fallback contacts
    const basicContacts = generateGenericCompanyContacts(domain, culturalInfo.language, culturalInfo.region);
    
    // Create context for AI analysis
    const emailGenerationContext = `Company Generic Contact Email Generation Request:

COMPANY INFORMATION:
- Domain: ${domain}

CULTURAL ANALYSIS FROM DOMAIN:
- Detected Language: ${culturalInfo.language}
- Detected Region: ${culturalInfo.region}
- Cultural Patterns: ${culturalInfo.cultural_patterns.join(', ') || 'None detected'}

BASIC GENERIC CONTACTS GENERATED (${basicContacts.length} contacts):
${basicContacts.map((email, index) => `${index + 1}. ${email}`).join('\n')}

TASK REQUIREMENTS:
Please analyze the provided domain and generate a comprehensive list of generic contact email addresses for this company. Consider the detected language (${culturalInfo.language}) and region (${culturalInfo.region}) to generate culturally appropriate generic contacts.

Generate EXACTLY 15-20 generic contact emails including:

1. **General Contact Emails (5-7 emails)**: 
   - For Spanish/Hispanic regions: info@, contacto@, admin@, hola@, ventas@
   - For English/Other regions: info@, contact@, admin@, hello@, sales@
   - Consider regional variations and formality levels

2. **Department Contact Emails (5-7 emails)**:
   - Sales: ventas@ (Spanish) or sales@ (English)
   - Marketing: marketing@ (universal)
   - HR: rrhh@ (Spanish) or hr@ (English)
   - Finance: finanzas@ (Spanish) or finance@ (English)
   - Operations: operaciones@ (Spanish) or operations@ (English)
   - Technology: tecnologia@ (Spanish) or tech@ (English)
   - Legal: legal@ (universal)

3. **Executive/Management Contact Emails (3-5 emails)**:
   - For Spanish/Hispanic: gerencia@, direccion@, ejecutivos@, presidencia@, administracion@
   - For English/Other: management@, executive@, leadership@, board@, corporate@

4. **Business Contact Emails (2-3 emails)**:
   - For Spanish: oficina@, equipo@, general@
   - For English: office@, team@, general@, business@

Consider:

1. **Cultural Context**: Use the detected language (${culturalInfo.language}) and region (${culturalInfo.region}) information
2. **Regional Preferences**: 
   - Hispanic regions: Use Spanish terms (contacto, ventas, gerencia, etc.)
   - European regions: Consider local language variations
   - English-speaking regions: Use standard English terms
3. **Business Email Conventions**: Consider regional business communication preferences
4. **Formality Levels**: Adjust formality based on regional business culture
5. **Industry Standards**: Consider common generic email patterns for the region

CRITICAL REQUIREMENTS: 
- Generate EXACTLY 15-20 generic contact emails
- Apply cultural naming conventions based on detected language/region
- Consider regional business email etiquette and formality levels
- Use appropriate language for the detected region
- Include a mix of general, departmental, executive, and business contacts

PROHIBITED EMAIL PATTERNS (CRITICAL - DO NOT GENERATE):
- NEVER generate emails with support, help, assistance, soporte, ayuda, or asistencia prefixes
- These include: support@, help@, assistance@, soporte@, ayuda@, asistencia@, support-team@, helpdesk@, etc.
- REASON: These email addresses typically lead to automated responses and robot loops, creating poor contact points
- Instead, use alternatives like: info@, contact@, sales@, hello@, or department-specific patterns

ABSOLUTE DOMAIN POLICY (Do NOT violate):
- Use ONLY the provided domain: ${domain}
- All generated emails MUST be on ${domain}
- Do NOT use any other domain or subdomain

IMPORTANT: Return the emails in strict order of probability considering both universal patterns and cultural context. Provide confidence scores (0-1) for each email and reasoning for the pattern selection including cultural considerations.`;
    
    const commandData = CommandFactory.createCommand({
      task: 'generate generic company contact email addresses',
      userId: dataAnalystAgent.userId,
      description: `Company Generic Contact Email Generation for ${domain}`,
      agentId: dataAnalystAgent.agentId,
      site_id: site_id,
      context: emailGenerationContext.trim(),
      targets: [
        {
          email_generation_analysis: {
            confidence_scores: 'array',
            recommendations: 'array',
            email_patterns_analysis: {
              industry_considerations: 'string',
              cultural_considerations: 'string',
              pattern_reasoning: 'string', 
              pattern_confidence: 'number',
              most_likely_pattern: 'string'
            },
            generated_emails: 'array',
            domain: 'string'
          }
        }
      ],
      tools: [],
      supervisor: [
        {
          agent_role: 'email_generation_manager',
          status: 'not_initialized'
        }
      ],
      // Set model to 4o
      model: 'gpt-4o',
      modelType: 'openai'
    });
    
    console.log(`🔧 Creating generic company contact email generation command`);
    
    // Submit command for execution
    const internalCommandId = await commandService.submitCommand(commandData);
    
    console.log(`📝 Generic contact email generation command created: ${internalCommandId}`);
    
    // Get the real UUID of the command by searching in the database
    let realCommandId = null;
    try {
      // Find the most recent command for this agent
      const { data: recentCommands, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('agent_id', dataAnalystAgent.agentId)
        .eq('description', `Company Generic Contact Email Generation for ${domain}`)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && recentCommands && recentCommands.length > 0) {
        realCommandId = recentCommands[0].id;
        console.log(`🔍 Real command UUID found: ${realCommandId}`);
      }
    } catch (error) {
      console.log('Could not get command UUID from database, using internal ID');
    }
    
    // If we don't have the real UUID, use the internal ID
    const commandIdToSearch = realCommandId || internalCommandId;
    
    // Wait for command to complete
    let completedCommand = null;
    // Detect if we're in test environment to reduce wait times
    const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
    const maxRetries = isTestEnvironment ? 5 : 580; // 5 attempts in test, 580 in production (~4.8 minutes)
    const retryDelay = isTestEnvironment ? 10 : 500; // 10ms in test, 500ms in production
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Search for command in database by ID
        const { data: commandData, error } = await supabaseAdmin
          .from('commands')
          .select('*')
          .eq('id', commandIdToSearch)
          .single();
        
        if (!error && commandData) {
          if (commandData.status === 'completed') {
            completedCommand = commandData;
            console.log(`✅ Command completed after ${attempt + 1} attempts`);
            break;
          } else if (commandData.status === 'failed') {
            console.error(`❌ Command failed after ${attempt + 1} attempts`);
            return NextResponse.json(
              { 
                success: false, 
                error: { 
                  code: 'COMMAND_EXECUTION_FAILED', 
                  message: 'Company generic contact email generation command failed to execute',
                  commandId: commandIdToSearch
                } 
              },
              { status: 500 }
            );
          }
        }
        
        // If not completed, wait before next attempt
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        console.log(`Attempt ${attempt + 1}/${maxRetries}: Command still processing...`);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    if (!completedCommand) {
      console.log('⚠️ Command not completed after maximum wait time');
    }
    
    // Prepare base response
    const responseData: any = {
      commandId: commandIdToSearch,
      status: completedCommand ? 'completed' : 'timeout',
      message: completedCommand ? 'Company generic contact email generation completed' : 'Company generic contact email generation timed out - command may still be processing',
      agent_id: dataAnalystAgent.agentId,
      domain: domain,
      site_id: site_id,
      basic_contacts_generated: basicContacts,
      cultural_info: culturalInfo,
      timestamp: new Date().toISOString()
    };

    // If command is completed, extract analysis results
    let emailGenerationResult = null;
    if (completedCommand && completedCommand.results) {
      try {
        const results = Array.isArray(completedCommand.results) ? completedCommand.results : [completedCommand.results];
        const resultWithEmailGeneration = results.find((result: any) => result.email_generation_analysis);
        
        if (resultWithEmailGeneration) {
          emailGenerationResult = resultWithEmailGeneration.email_generation_analysis;
          responseData.email_generation_analysis = emailGenerationResult;
        }
      } catch (error) {
        console.error('Error extracting email_generation_analysis from completed command:', error);
      }
    }
    
    // If no AI results, use basic generated contacts
    if (!emailGenerationResult && basicContacts.length > 0) {
      responseData.fallback_contacts = basicContacts;
      responseData.message += ' - Using basic contact generation as fallback';
    }
    
    return NextResponse.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Error in companyContactGeneration route:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
}

