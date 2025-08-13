import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeRobotActivityPlanning } from '@/lib/helpers/campaign-commands';

// ------------------------------------------------------------------------------------
// Core Activity Context and Instructions Builder
// ------------------------------------------------------------------------------------

export interface ActivityContext {
  additionalContext: string;
  specificInstructions: string;
  requiredData: string[];
}

export interface PlanDecision {
  action: 'continue_plan' | 'modify_plan' | 'new_plan';
  reason: string;
  shouldRegeneratePlan: boolean;
}

/**
 * Core function to get activity-specific context with comprehensive instructions
 * This is the shared core that both growth plan and instance act routes use
 */
export async function getActivitySpecificContext(
  activityType: string, 
  siteId: string,
  userContext?: string,
  previousPlanContext?: string
): Promise<ActivityContext> {
  const activityTypeNormalized = activityType.toLowerCase().trim();
  
  // Base context with user input and previous plan context if provided
  const baseContext = [
    userContext ? `\n🎯 CONTEXTO DEL USUARIO:\n${userContext}\n` : '',
    previousPlanContext ? `\n📋 CONTEXTO DEL PLAN PREVIO:\n${previousPlanContext}\n` : ''
  ].filter(Boolean).join('');
  
  switch (activityTypeNormalized) {
    case 'free agent':
    case 'free-agent':
      // Obtener las últimas sesiones de autenticación disponibles
      const { data: recentSessions } = await supabaseAdmin
        .from('automation_auth_sessions')
        .select('id, name, domain, auth_type, last_used_at, usage_count, created_at')
        .eq('site_id', siteId)
        .eq('is_valid', true)
        .order('last_used_at', { ascending: false })
        .limit(10);

      // ✅ LÓGICA CORREGIDA: Free Agent mode puede funcionar con o sin sesiones
      // Si hay sesiones, las incluimos en el contexto. Si no hay, el agente trabajará sin ellas.
      const sessionsContext = (!recentSessions || recentSessions.length === 0) 
        ? `\n⚠️ NO SESSIONS AVAILABLE:\nNo hay sesiones de autenticación disponibles actualmente. El agente trabajará en modo limitado sin acceso a plataformas autenticadas.\n`
        : `\n🔑 AVAILABLE SESSIONS (${recentSessions.length} sessions):\n` +
          recentSessions.map((session, index) => 
            `${index + 1}. **${session.name}** (${session.domain})\n` +
            `   Session ID: ${session.id}\n` +
            `   Type: ${session.auth_type}\n` +
            `   Last used: ${session.last_used_at ? new Date(session.last_used_at).toLocaleString() : 'Never used'}\n` +
            `   Usage count: ${session.usage_count || 0}\n`
          ).join('\n');

      return {
        additionalContext: baseContext + sessionsContext,
        specificInstructions: `
🤖 FREE AGENT MODE - GOOGLE NAVIGATION ONLY:

⚠️ IMPORTANT CONTEXT: Este agente está configurado específicamente para navegar únicamente a Google y realizar tareas relacionadas.

Create a SIMPLE plan focused exclusively on Google navigation and tasks.

🎯 BASIC OBJECTIVES:
- Navigate ONLY to Google (google.com)
- Perform basic Google searches
- Use Google services (Search, News, etc.)
- Maximum 3-5 simple steps
- No other websites or platforms allowed

📋 SIMPLE PLAN STRUCTURE:
1. Open web browser and navigate to Google.com
2. Perform a basic search query related to the user's business/industry
3. Review search results on the first page
4. Optionally check Google News for relevant updates
5. Document findings and close browser

🔍 BASIC REQUIREMENTS:
- ONLY navigate to google.com and its subdomains (news.google.com, etc.)
- Create simple, direct navigation steps
- No authentication required for basic Google searches
- Maximum 30-minute execution time total
- Focus on information gathering through Google search

⚠️ STRICT RESTRICTIONS:
- Do NOT navigate to any website other than Google
- Do NOT access social media platforms
- Do NOT use any authentication sessions
- Do NOT create complex workflows
- Do NOT suggest visiting other websites
- ONLY use Google's public search functionality

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['search_terms']
      };

    case 'channel market fit':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🎯 CHANNEL MARKET FIT FOCUS:
- VALIDATE existing customer segments by checking actual user behavior data
- Test and validate channel effectiveness for current customer base
- Focus on ONE channel that shows highest engagement/conversion potential
- Use existing customer data to validate channel-market alignment
- Prioritize channels where customers are already active

🔍 VALIDATION REQUIREMENTS:
- Verify customer segment data exists and is current (not outdated)
- Check if engagement metrics are accurate and recent
- Validate channel performance data against actual platform analytics
- If data is missing or outdated, include steps to gather current information

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['segments', 'customer_behavior', 'channel_performance']
      };

    case 'engage in social networks':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🌐 SOCIAL NETWORKS ENGAGEMENT FOCUS:
- Select ONE primary social platform based on customer segments
- Focus on existing follower engagement over new acquisition
- Use approved content pieces for social interactions
- Prioritize platforms where previous sessions exist for authentication
- Create simple engagement actions: reply, share, post using existing content

🔍 VALIDATION REQUIREMENTS:
- VERIFY authentication sessions are still active and valid
- Check if social profiles/pages exist and are accessible
- Validate that approved content is actually published and visible
- Confirm follower counts and engagement metrics are current
- If posts appear published in system but aren't visible online, recreate them
- Verify social platform API access and permissions before executing actions

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['approved_content', 'social_sessions', 'segments']
      };

    case 'seo':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🔍 SEO OPTIMIZATION FOCUS:
- Focus on ONE specific keyword or content piece optimization
- Use existing approved content as foundation for SEO improvements
- Prioritize on-page optimization over technical SEO changes
- Target low-hanging fruit: meta descriptions, title tags, content updates
- Measure through simple ranking/traffic monitoring

🔍 VALIDATION REQUIREMENTS:
- VERIFY content is actually live and indexed by search engines
- Check current keyword rankings using real-time SEO tools
- Validate that meta tags and descriptions match what's actually on the website
- Confirm content updates are properly deployed and visible online
- If system shows content as optimized but SEO tools show otherwise, re-implement changes
- Test website accessibility and loading speed before claiming SEO completion

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['approved_content', 'current_rankings', 'target_keywords']
      };

    case 'publish content':
      const { data: approvedContent } = await supabaseAdmin
        .from('contents')
        .select('id, title, description, type, status, campaign_id')
        .eq('site_id', siteId)
        .in('status', ['approved', 'ready'])
        .order('created_at', { ascending: false })
        .limit(10);

      const contentContext = approvedContent && approvedContent.length > 0
        ? `\n📄 APPROVED CONTENT AVAILABLE (${approvedContent.length} items):\n` +
          approvedContent.map((content, index) => 
            `${index + 1}. **${content.title}** (${content.type})\n` +
            `   Description: ${content.description || 'No description'}\n` +
            `   Status: ${content.status}\n` +
            (content.campaign_id ? `   Campaign ID: ${content.campaign_id}\n` : '')
          ).join('\n')
        : '\n⚠️ No approved content found - focus on content preparation steps\n';

      return {
        additionalContext: baseContext + contentContext,
        specificInstructions: `
📝 CONTENT PUBLISHING FOCUS:
- Use ONLY approved content from the list above
- Select ONE content piece for publishing
- Choose ONE platform/channel for publishing
- Focus on proper formatting and scheduling for maximum impact
- Ensure content aligns with existing campaigns if campaign_id is present

🔍 VALIDATION REQUIREMENTS:
- VERIFY content piece actually exists and is accessible in the system
- Check if content is already published online - if system shows "published" but content isn't visible, republish it
- Validate publishing platform credentials and access permissions
- Confirm content formatting displays correctly on target platform
- If scheduled posts don't appear as expected, recreate the publishing process
- Test all links, images, and media in content before marking as published
- Verify content appears in correct campaign/section if associated with campaign_id

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['approved_content', 'publishing_channels', 'scheduling_preferences']
      };

    case 'publish ads':
      const { data: activeCampaigns } = await supabaseAdmin
        .from('campaigns')
        .select('id, title, description, status, budget, target_audience')
        .eq('site_id', siteId)
        .in('status', ['active', 'pending'])
        .order('created_at', { ascending: false })
        .limit(10);

      const campaignsContext = activeCampaigns && activeCampaigns.length > 0
        ? `\n🎯 ACTIVE CAMPAIGNS AVAILABLE (${activeCampaigns.length} campaigns):\n` +
          activeCampaigns.map((campaign, index) => 
            `${index + 1}. **${campaign.title}** (${campaign.status})\n` +
            `   Description: ${campaign.description || 'No description'}\n` +
            `   Budget: ${campaign.budget || 'Not specified'}\n` +
            `   Target Audience: ${campaign.target_audience || 'Not specified'}\n`
          ).join('\n')
        : '\n⚠️ No active campaigns found - focus on campaign setup steps\n';

      return {
        additionalContext: baseContext + campaignsContext,
        specificInstructions: `
💰 AD PUBLISHING FOCUS:
- Use ONLY existing campaigns from the list above
- Select ONE campaign for ad publishing
- Focus on ONE advertising platform (Google Ads, Facebook, LinkedIn)
- Use existing campaign budget and targeting parameters
- Create simple ad variations using approved content

🔍 VALIDATION REQUIREMENTS:
- VERIFY campaign actually exists and is active on the advertising platform
- Check if ads are already running - if system shows "active" but platform shows "paused/stopped", reactivate them
- Validate advertising account access and billing status
- Confirm campaign budget limits and spending are accurate
- If ads appear created but aren't serving, troubleshoot and recreate them
- Verify target audience settings match between system and platform
- Test ad creative displays correctly before launching

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['active_campaigns', 'ad_platforms', 'campaign_budgets']
      };

    case 'ux analysis':
      return {
        additionalContext: baseContext,
        specificInstructions: `
🎨 UX ANALYSIS FOCUS:
- Focus on ONE specific page or user flow
- Use existing customer journey data and segments
- Prioritize high-traffic pages or conversion bottlenecks
- Create actionable UX improvement recommendations
- Focus on quick wins: loading speed, navigation, conversion elements

🔍 VALIDATION REQUIREMENTS:
- VERIFY website pages are accessible and loading correctly
- Check if analytics data reflects current user behavior (not outdated)
- Validate conversion tracking is working and recording accurate data
- Confirm user flow paths exist and function as expected
- If heat maps or user session recordings show different behavior than data suggests, investigate discrepancies
- Test all interactive elements and forms before analyzing their performance
- Verify A/B tests are running correctly if system shows them as active

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['user_behavior', 'conversion_data', 'page_performance']
      };

    case 'build requirements':
      const { data: pendingRequirements } = await supabaseAdmin
        .from('requirements')
        .select('id, title, description, priority, status, type, estimated_cost')
        .eq('site_id', siteId)
        .in('status', ['pending', 'validated', 'in-progress'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(15);

      const requirementsContext = pendingRequirements && pendingRequirements.length > 0
        ? `\n📋 PENDING REQUIREMENTS (${pendingRequirements.length} items):\n` +
          pendingRequirements.map((req, index) => 
            `${index + 1}. **${req.title}** (${req.status}, ${req.priority || 'medium'} priority)\n` +
            `   Description: ${req.description || 'No description'}\n` +
            `   Type: ${req.type || 'general'}\n` +
            `   Estimated Cost: ${req.estimated_cost ? '$' + req.estimated_cost : 'Not specified'}\n`
          ).join('\n')
        : '\n⚠️ No pending requirements found - focus on requirement gathering\n';

      return {
        additionalContext: baseContext + requirementsContext,
        specificInstructions: `
📋 BUILD REQUIREMENTS FOCUS:
- Review and prioritize existing pending requirements from the list above
- Select the HIGHEST priority requirement for detailed breakdown
- Create actionable sub-tasks and implementation steps
- Focus on requirements that align with current campaigns and content
- Estimate realistic timelines and resource needs

🔍 VALIDATION REQUIREMENTS:
- VERIFY requirements are still relevant and haven't been completed elsewhere
- Check if similar functionality already exists in the system
- Validate estimated costs and timelines against current market rates
- Confirm stakeholder needs haven't changed since requirement creation
- If requirements appear to conflict with existing features, investigate and resolve conflicts
- Verify technical feasibility before committing to implementation plans
- Check if requirements dependencies are actually available and working

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['pending_requirements', 'current_resources', 'priority_matrix']
      };

    default:
      return {
        additionalContext: baseContext,
        specificInstructions: `
🤖 PLAN CONTEXTUALIZADO:
- Considerar el contexto específico proporcionado por el usuario
- Crear plan enfocado en las necesidades expresadas
- Mantener simplicidad y eficiencia en la ejecución
- Máximo 3-5 steps principales
- Tiempo de ejecución máximo: 2 horas

🔄 GENERAL ACTIVITY FOCUS:
- Focus on ONE specific action within the activity scope
- Use existing campaigns and content as foundation
- Prioritize quick wins and measurable outcomes
- Align with current customer journey stage

🔍 VALIDATION REQUIREMENTS:
- ALWAYS verify system data matches reality before executing actions
- Check if claimed "completed" or "published" items actually exist and are visible
- Validate authentication and access to platforms before proceeding
- If discrepancies found between system and reality, include steps to fix them
- Test all functionality before marking activities as complete
- Verificar que todas las acciones sean viables con los recursos disponibles
- Confirmar que el plan se alinea con el contexto proporcionado
- Asegurar que cada step sea ejecutable en el tiempo estimado

${userContext ? `\n⚠️ CONTEXTO ADICIONAL: Incorporar el siguiente contexto en todas las decisiones:\n${userContext}\n` : ''}`,
        requiredData: ['general_context', 'user_context', 'activity_type']
      };
  }
}

/**
 * Core function to decide what action to take with existing plans
 */
export async function decidePlanAction(
  currentPlan: any | null,
  userMessage: string,
  userContext?: string
): Promise<PlanDecision> {
  // Si no hay plan actual, crear uno nuevo
  if (!currentPlan) {
    return {
      action: 'new_plan',
      reason: 'No existe plan activo, generando plan nuevo',
      shouldRegeneratePlan: true
    };
  }

  // Si el plan está completado o falló, generar nuevo plan
  if (['completed', 'failed'].includes(currentPlan.status)) {
    return {
      action: 'new_plan',
      reason: `Plan anterior ${currentPlan.status}, ejecutando workflow y generando plan nuevo`,
      shouldRegeneratePlan: true
    };
  }

  // Verificar si el usuario solicita explícitamente un cambio de plan
  const regenerationKeywords = [
    'nuevo plan', 'new plan', 'cambiar plan', 'change plan',
    'diferente plan', 'otro plan', 'plan diferente',
    'empezar de nuevo', 'start over', 'reiniciar'
  ];
  
  const userText = (userMessage + ' ' + (userContext || '')).toLowerCase();
  const requestsNewPlan = regenerationKeywords.some(keyword => userText.includes(keyword));
  
  if (requestsNewPlan) {
    return {
      action: 'new_plan',
      reason: 'Usuario solicita explícitamente un nuevo plan',
      shouldRegeneratePlan: true
    };
  }

  // Verificar si hay steps in_progress - si es así, continuar el plan
  const steps = currentPlan.steps || [];
  const inProgressStep = steps.find((step: any) => step.status === 'in_progress');
  
  if (inProgressStep) {
    return {
      action: 'continue_plan',
      reason: `Hay un step en progreso (${inProgressStep.title}), continuando plan actual`,
      shouldRegeneratePlan: false
    };
  }

  // Verificar si el contexto del usuario sugiere modificación del plan existente
  const modificationKeywords = [
    'modificar', 'modify', 'ajustar', 'adjust', 'cambiar', 'change',
    'agregar', 'add', 'añadir', 'incluir', 'include'
  ];
  
  const requestsModification = modificationKeywords.some(keyword => userText.includes(keyword));
  
  if (requestsModification) {
    return {
      action: 'modify_plan',
      reason: 'Usuario solicita modificación del plan actual',
      shouldRegeneratePlan: true // Regenerar con contexto del plan existente
    };
  }

  // Por defecto, continuar con el plan actual
  return {
    action: 'continue_plan',
    reason: 'Continuando con el plan activo existente',
    shouldRegeneratePlan: false
  };
}

/**
 * Core function to execute robot activity planning with unified context
 */
export async function executeUnifiedRobotActivityPlanning(
  siteId: string,
  agentId: string,
  userId: string,
  activity: string,
  previousSessions: any[],
  userContext?: string,
  previousPlanContext?: string
): Promise<{activityPlanResults: any[] | null, planningCommandUuid: string | null}> {
  try {
    // Get unified activity context with both user and previous plan context
    const activityContext = await getActivitySpecificContext(
      activity,
      siteId,
      userContext,
      previousPlanContext
    );

    // Execute planning using the unified context
    return await executeRobotActivityPlanning(
      siteId,
      agentId,
      userId,
      activity,
      previousSessions,
      activityContext
    );
  } catch (error) {
    console.error('❌ Error executing unified robot activity planning:', error);
    return { activityPlanResults: null, planningCommandUuid: null };
  }
}

/**
 * Core function to format and process plan steps consistently
 */
export function formatPlanSteps(planData: any): any[] {
  let planSteps: any[] = [];
  
  if (planData.phases && Array.isArray(planData.phases)) {
    // Extraer steps de todas las fases y aplanar
    planSteps = planData.phases.flatMap((phase: any, phaseIndex: number) => {
      if (!phase.steps || !Array.isArray(phase.steps)) return [];
      
      return phase.steps.map((step: any, stepIndex: number) => ({
        id: step.id || `phase_${phaseIndex + 1}_step_${stepIndex + 1}`,
        title: step.title || step.name || `Step ${stepIndex + 1}`,
        description: step.description || step.details || '',
        status: 'pending',
        order: (phaseIndex * 100) + stepIndex + 1, // Para mantener orden entre fases
        type: step.type || 'task',
        instructions: step.instructions || step.description || step.details || '',
        expected_output: step.expected_output || step.outcome || '',
        expected_response_type: step.expected_response_type || 'step_completed',
        human_intervention_reason: step.human_intervention_reason || null,
        estimated_duration_minutes: (() => {
          const duration = step.estimated_duration || step.estimated_duration_minutes;
          if (typeof duration === 'number') return Math.min(duration, 4);
          if (typeof duration === 'string') {
            const match = duration.match(/(\d+)/);
            return match ? Math.min(parseInt(match[1]), 4) : 4;
          }
          return 4; // Default máximo 4 minutos
        })(),
        automation_level: step.automation_level || 'automated',
        required_authentication: step.required_authentication || 'none',
        actual_output: null,
        started_at: null,
        completed_at: null,
        duration_seconds: null,
        retry_count: 0,
        error_message: null,
        artifacts: [],
        phase: phase.title || phase.name || `Phase ${phaseIndex + 1}`
      }));
    });
  } else if (planData.steps && Array.isArray(planData.steps)) {
    // Si el plan ya tiene steps directamente
    planSteps = planData.steps.map((step: any, index: number) => ({
      id: step.id || `step_${index + 1}`,
      title: step.title || step.name || `Step ${index + 1}`,
      description: step.description || step.details || '',
      status: 'pending',
      order: index + 1,
      type: step.type || 'task',
      instructions: step.instructions || step.description || step.details || '',
      expected_output: step.expected_output || step.outcome || '',
      expected_response_type: step.expected_response_type || 'step_completed',
      human_intervention_reason: step.human_intervention_reason || null,
      estimated_duration_minutes: (() => {
        const duration = step.estimated_duration || step.estimated_duration_minutes;
        if (typeof duration === 'number') return Math.min(duration, 4);
        if (typeof duration === 'string') {
          const match = duration.match(/(\d+)/);
          return match ? Math.min(parseInt(match[1]), 4) : 4;
        }
        return 4; // Default máximo 4 minutos
      })(),
      automation_level: step.automation_level || 'automated',
      required_authentication: step.required_authentication || 'none',
      actual_output: null,
      started_at: null,
      completed_at: null,
      duration_seconds: null,
      retry_count: 0,
      error_message: null,
      artifacts: []
    }));
  }

  return planSteps;
}

/**
 * Core function to add session save steps after authentication steps
 */
export function addSessionSaveSteps(planSteps: any[]): any[] {
  const stepsWithSessionSave: any[] = [];
  let currentOrder = 1;
  
  for (let i = 0; i < planSteps.length; i++) {
    const step = planSteps[i];
    step.order = currentOrder++;
    stepsWithSessionSave.push(step);
    
    // Verificar si este paso es de autenticación (más preciso)
    const isAuthStep = step.type === 'authentication' || 
                      step.expected_response_type === 'session_acquired' ||
                      (step.title?.toLowerCase().includes('login') && !step.title?.toLowerCase().includes('navigate')) ||
                      (step.title?.toLowerCase().includes('authenticate') && !step.title?.toLowerCase().includes('navigate')) ||
                      step.title?.toLowerCase().includes('sign in') ||
                      (step.description?.toLowerCase().includes('login') && step.description?.toLowerCase().includes('credentials')) ||
                      (step.description?.toLowerCase().includes('authenticate') && step.description?.toLowerCase().includes('credentials'));
    
    if (isAuthStep) {
      // Insertar paso de guardado de sesión inmediatamente después
      const sessionSaveStep = {
        id: `session_save_after_step_${step.order}`,
        title: "Guardar sesión de autenticación",
        description: "Guardar automáticamente la sesión de autenticación actual en la base de datos y Scrapybara para uso futuro",
        status: 'pending',
        order: currentOrder++,
        type: 'session_save',
        instructions: "Llamar al endpoint /api/robots/auth para guardar la sesión actual después del login exitoso",
        expected_output: "Sesión guardada exitosamente con ID de sesión y estado de autenticación",
        expected_response_type: 'step_completed',
        human_intervention_reason: null,
        estimated_duration_minutes: 1,
        automation_level: 'automated',
        required_authentication: 'current_session',
        actual_output: null,
        started_at: null,
        completed_at: null,
        duration_seconds: null,
        retry_count: 0,
        error_message: null,
        artifacts: [],
        phase: step.phase || 'Authentication'
      };
      
      stepsWithSessionSave.push(sessionSaveStep);
      console.log(`🔐 AGREGADO: Paso de guardado de sesión después del paso de autenticación: ${step.title}`);
    }
  }
  
  return stepsWithSessionSave;
}

/**
 * Core function to calculate estimated duration from timeline
 */
export function calculateEstimatedDuration(timelineValue: any): number {
  if (typeof timelineValue === 'number') {
    // Asegurar que no exceda 120 minutos (2 horas)
    return Math.min(timelineValue, 120);
  }
  if (typeof timelineValue === 'string') {
    // Buscar números en el string y convertir
    const match = timelineValue.match(/(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      // Convertir semanas a minutos si encuentra "week" en el string
      if (timelineValue.toLowerCase().includes('week')) {
        return Math.min(num * 7 * 24 * 60, 120); // máximo 2 horas
      }
      // Convertir días a minutos si encuentra "day"
      if (timelineValue.toLowerCase().includes('day')) {
        return Math.min(num * 24 * 60, 120); // máximo 2 horas
      }
      // Si no especifica unidad, asumir que son minutos
      return Math.min(num, 120); // máximo 2 horas
    }
  }
  return 120; // Default a 2 horas máximo para planes simples
}
