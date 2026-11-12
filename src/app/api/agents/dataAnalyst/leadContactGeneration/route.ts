export const maxDuration = 300;
import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { waitForSubmittedCommand } from '@/lib/agentbase/services/command/waitForSubmittedCommand';
import { isValidUUID, isValidDomain, extractDomainFromUrl, findDataAnalystAgent, detectLanguageAndRegion } from './command-helpers-1';
import { generateEmailPatterns, validateEmailsNotUsingSiteDomain, filterSupportHelpAssistanceEmails, commandService } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { name, domain, context = '', site_id } = body;
        if (!name || !domain || !site_id) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'name, domain, and site_id are required'
                }
            }, { status: 400 });
        }
        if (!isValidUUID(site_id)) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'site_id must be a valid UUID'
                }
            }, { status: 400 });
        }
        if (!isValidDomain(domain)) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'domain must be a valid domain format (e.g., company.com)'
                }
            }, { status: 400 });
        }
        let siteUrl: string | null = null;
        let siteDomainNote: string | null = null;
        try {
            const { data: siteData } = await supabaseAdmin
                .from('sites')
                .select('url')
                .eq('id', site_id)
                .single();
            siteUrl = siteData?.url || null;
            siteDomainNote = extractDomainFromUrl(siteUrl);
        }
        catch {
            siteUrl = null;
            siteDomainNote = null;
        }
        const dataAnalystAgent = await findDataAnalystAgent(site_id);
        if (!dataAnalystAgent) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'DATA_ANALYST_NOT_FOUND',
                    message: 'No se encontró un agente con role "Data Analyst" para este sitio'
                }
            }, { status: 404 });
        }
        console.log(`📧 Iniciando generación de emails de contacto para: ${name} en dominio: ${domain}`);
        const culturalInfo = detectLanguageAndRegion(name, context);
        const basicEmailPatterns = generateEmailPatterns(name, domain, context);
        const emailGenerationContext = `Lead Contact Email Generation Request:

CONTACT INFORMATION:
- Name: ${name}
- Domain: ${domain}
- Additional Context: ${context}
\nSITE INFORMATION (for disambiguation only):
- Site URL: ${siteUrl || 'N/A'}
- Site Domain: ${siteDomainNote || 'N/A'}

CULTURAL ANALYSIS:
- Detected Language: ${culturalInfo.language}
- Detected Region: ${culturalInfo.region}
- Cultural Patterns: ${culturalInfo.cultural_patterns.join(', ') || 'None detected'}

BASIC EMAIL PATTERNS GENERATED (${basicEmailPatterns.length} patterns):
${basicEmailPatterns.map((email, index) => `${index + 1}. ${email}`).join('\n')}

TASK REQUIREMENTS:
Please analyze the provided name, domain, and context to generate a comprehensive list of email addresses for this contact:

**EXECUTIVE POSITIONS** (CEO, Director, President, Founder, VP, etc.): Generate EXACTLY 20 emails
**NON-EXECUTIVE POSITIONS**: Generate EXACTLY 15 emails

EMAIL STRUCTURE:
- FIRST 10 EMAILS: Personal email patterns (ordered from most probable to least probable)
- NEXT 5 EMAILS: Department/role-specific email patterns OR generic contact emails
- LAST 5 EMAILS (EXECUTIVES ONLY): Additional generic executive contact emails

MANDATORY EMAIL STRUCTURE:
1. **Personal Patterns (10 emails)**: Use name variations with cultural considerations
2. **Departmental/Generic Patterns (5 emails)**: 
   - IF role/department detected in context: Use department-specific patterns (e.g., sales.firstname@domain.com, firstname@marketing.domain.com)
   - IF NO clear role/department: Use generic contact patterns (e.g., info@domain.com, contact@domain.com, admin@domain.com, hello@domain.com, sales@domain.com)
3. **Executive Generic Patterns (5 emails - ONLY for executive positions)**:
   - Spanish/Hispanic: direccion@domain.com, gerencia@domain.com, presidencia@domain.com, ejecutivos@domain.com, administracion@domain.com
   - English/Other: management@domain.com, executive@domain.com, leadership@domain.com, board@domain.com, corporate@domain.com

Consider:

1. **Cultural Context**: Use the detected language (${culturalInfo.language}) and region (${culturalInfo.region}) information
2. **Naming Conventions**: Consider cultural naming patterns (${culturalInfo.cultural_patterns.join(', ') || 'standard international'})
3. **Regional Preferences**: 
   - Hispanic names: Often use compound first names and both paternal/maternal surnames
   - German names: Prefer lastname.firstname order in business contexts
   - Dutch names: Handle tussenvoegsel (van, de, der) appropriately
   - French names: Consider hyphenated names and formal address patterns
4. Common email naming conventions (firstname.lastname is most common ~90% globally)
5. Industry-specific email formats considering regional business culture
6. **Department-specific email patterns**: 
   - With subdomain: firstname@sales.domain.com, firstname@marketing.domain.com
   - With prefix: sales.firstname@domain.com, marketing.firstname@domain.com
   - Role-based: manager.firstname@domain.com, director.firstname@domain.com
7. **Generic contact emails** (when no department detected):
   - info@domain.com, contact@domain.com, admin@domain.com
   - hello@domain.com, ventas@domain.com, sales@domain.com (for Spanish)
   - hola@domain.com, contacto@domain.com (for Hispanic regions)
8. Cultural variations in separators and ordering
9. Use of initials vs full names (varies by culture and hierarchy)
10. Regional business communication preferences
11. Company size influence adapted to regional business practices
12. Language-specific character handling (accents, special characters)

CRITICAL REQUIREMENTS: 
- EXECUTIVE POSITIONS: Generate EXACTLY 20 emails (15 standard + 5 executive generic)
- NON-EXECUTIVE POSITIONS: Generate EXACTLY 15 emails
- If role/department detected: Include department-specific patterns in emails 11-15
- If NO role/department detected: Include generic contact emails in emails 11-15
- For EXECUTIVES: Include executive generic emails in emails 16-20
- Apply cultural naming conventions based on detected language/region
- Consider regional business email etiquette and formality levels

PROHIBITED EMAIL PATTERNS (CRITICAL - DO NOT GENERATE):
- NEVER generate emails with support, help, assistance, soporte, ayuda, or asistencia prefixes
- These include: support@, help@, assistance@, soporte@, ayuda@, asistencia@, support-team@, helpdesk@, etc.
- REASON: These email addresses typically lead to automated responses and robot loops, creating poor contact points for lead generation
- They are often managed by automated systems rather than actual decision-makers
- Instead, use alternatives like: info@, contact@, sales@, hello@, or department-specific patterns
\nABSOLUTE DOMAIN POLICY (Do NOT violate):
- Use ONLY the lead's domain provided: ${domain}
- The site's/company's domain is ${siteDomainNote || 'N/A'} (from ${siteUrl || 'N/A'}).
- NEVER use or propose any email address on the site's/company's domain or any of its subdomains.
- Do NOT confuse the site's domain with the lead's domain. All generated emails MUST be on ${domain}.
- NEVER generate emails with generic providers (e.g. @gmail.com, @hotmail.com, @yahoo.com) UNLESS the lead's domain is exactly that.
- NEVER generate emails using other companies' domains (e.g. @facebook.com, @microsoft.com) if the lead's domain is different.

EXECUTIVE POSITION DETECTION:
Consider these roles as executive positions requiring 20 emails: CEO, CTO, CFO, CMO, COO, Director, President, VP, Vice President, Founder, Co-founder, Owner, Partner, General Manager, Country Manager, Regional Manager, Executive, Senior Manager, Managing Director, Executive Director.

IMPORTANT: Return the emails in strict order of probability considering both universal patterns and cultural context. Provide confidence scores (0-1) for each email and reasoning for the pattern selection including cultural considerations.`;
        const commandData = CommandFactory.createCommand({
            task: 'generate contact email addresses for lead',
            userId: dataAnalystAgent.userId,
            description: `Lead Contact Email Generation for ${name} at ${domain}`,
            agentId: dataAnalystAgent.agentId,
            agentRole: 'Data Analyst',
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
                        domain: 'string',
                        contact_name: 'string'
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
            model: 'gpt-4o',
            modelType: 'openai'
        });
        console.log(`🔧 Creando comando de generación de emails de contacto`);
        const internalCommandId = await commandService.submitCommand(commandData);
        console.log(`📝 Comando de generación de emails creado: ${internalCommandId}`);
        const { commandId: commandIdToSearch, command: completedCommand } = await waitForSubmittedCommand(commandService, internalCommandId);
        if (completedCommand && completedCommand.status !== 'completed') {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'Lead contact email generation command failed to execute',
                    commandId: commandIdToSearch,
                },
            }, { status: 500 });
        }
        if (!completedCommand) {
            console.log('⚠️ Comando no completado después del tiempo máximo de espera');
        }
        const responseData: any = {
            commandId: commandIdToSearch,
            status: completedCommand ? 'completed' : 'timeout',
            message: completedCommand ? 'Lead contact email generation completed' : 'Lead contact email generation timed out - command may still be processing',
            agent_id: dataAnalystAgent.agentId,
            contact_name: name,
            domain: domain,
            context: context,
            site_id: site_id,
            basic_patterns_generated: basicEmailPatterns,
            site_url: siteUrl,
            site_domain_note: siteDomainNote,
            timestamp: new Date().toISOString()
        };
        let emailGenerationResult = null;
        if (completedCommand && completedCommand.results) {
            try {
                const results = Array.isArray(completedCommand.results) ? completedCommand.results : [completedCommand.results];
                const resultWithEmailGeneration = results.find((result: any) => result.email_generation_analysis);
                if (resultWithEmailGeneration) {
                    emailGenerationResult = resultWithEmailGeneration.email_generation_analysis;
                    responseData.email_generation_analysis = emailGenerationResult;
                }
                if (emailGenerationResult?.generated_emails && Array.isArray(emailGenerationResult.generated_emails)) {
                    const { validEmails, filteredCount, needsFallback } = validateEmailsNotUsingSiteDomain(emailGenerationResult.generated_emails, siteDomainNote, domain);
                    const filteredSupportEmails = filterSupportHelpAssistanceEmails(validEmails);
                    const supportFilteredCount = validEmails.length - filteredSupportEmails.length;
                    if (filteredCount > 0 || supportFilteredCount > 0) {
                        console.log(`⚠️ Filtered ${filteredCount} emails that violated domain policy and ${supportFilteredCount} support/help/assistance emails`);
                        emailGenerationResult.generated_emails = filteredSupportEmails;
                        responseData.email_generation_analysis = emailGenerationResult;
                        responseData.domain_validation = {
                            filtered_count: filteredCount + supportFilteredCount,
                            reason: 'Emails using site domain or support/help/assistance patterns were removed'
                        };
                    }
                    else {
                        emailGenerationResult.generated_emails = filteredSupportEmails;
                    }
                    if (needsFallback) {
                        console.log(`🔄 Generating fallback emails for lead domain: ${domain}`);
                        const fallbackEmails = generateEmailPatterns(name, domain, context);
                        responseData.fallback_emails = fallbackEmails;
                        responseData.message += ' - All AI emails filtered, using fallback generation';
                    }
                }
            }
            catch (error) {
                console.error('Error extracting email_generation_analysis from completed command:', error);
            }
        }
        if (!emailGenerationResult && basicEmailPatterns.length > 0) {
            responseData.fallback_emails = basicEmailPatterns;
            responseData.message += ' - Using basic pattern generation as fallback';
        }
        if (responseData.fallback_emails) {
            const { validEmails, filteredCount, needsFallback } = validateEmailsNotUsingSiteDomain(responseData.fallback_emails, siteDomainNote, domain);
            const filteredSupportEmails = filterSupportHelpAssistanceEmails(validEmails);
            const supportFilteredCount = validEmails.length - filteredSupportEmails.length;
            if (filteredCount > 0 || supportFilteredCount > 0) {
                console.log(`⚠️ Filtered ${filteredCount} fallback emails that violated domain policy and ${supportFilteredCount} support/help/assistance emails`);
                responseData.fallback_emails = filteredSupportEmails;
                responseData.domain_validation = {
                    filtered_count: filteredCount + supportFilteredCount,
                    reason: 'Fallback emails using site domain or support/help/assistance patterns were removed'
                };
            }
            else {
                responseData.fallback_emails = filteredSupportEmails;
            }
            if (needsFallback) {
                console.log(`🔄 All fallback emails filtered, generating basic safe emails for lead domain: ${domain}`);
                const basicSafeEmails = [
                    `info@${domain}`,
                    `contact@${domain}`,
                    `admin@${domain}`,
                    `hello@${domain}`,
                    `sales@${domain}`
                ];
                responseData.fallback_emails = basicSafeEmails;
                responseData.message += ' - All emails filtered, using basic safe emails';
                responseData.domain_validation = {
                    filtered_count: filteredCount,
                    reason: 'All emails filtered, using basic safe email patterns'
                };
            }
        }
        return NextResponse.json({
            success: true,
            data: responseData
        });
    }
    catch (error) {
        console.error('❌ Error en ruta leadContactGeneration:', error);
        return NextResponse.json({
            success: false,
            error: {
                code: 'SYSTEM_ERROR',
                message: 'An internal system error occurred'
            }
        }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
