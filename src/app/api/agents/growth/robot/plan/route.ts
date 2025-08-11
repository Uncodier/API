import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeRobotActivityPlanning } from '@/lib/helpers/campaign-commands';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';

// ------------------------------------------------------------------------------------
// Activity Type Context and Instructions Builder
// ------------------------------------------------------------------------------------

interface ActivityContext {
  additionalContext: string;
  specificInstructions: string;
  requiredData: string[];
}

async function getActivitySpecificContext(
  activityType: string, 
  siteId: string
): Promise<ActivityContext> {
  const activityTypeNormalized = activityType.toLowerCase().trim();
  
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
        additionalContext: sessionsContext,
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
- ONLY use Google's public search functionality`,
        requiredData: ['search_terms']
      };

    case 'channel market fit':
      return {
        additionalContext: '',
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
- If data is missing or outdated, include steps to gather current information`,
        requiredData: ['segments', 'customer_behavior', 'channel_performance']
      };

    case 'engage in social networks':
      return {
        additionalContext: '',
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
- Verify social platform API access and permissions before executing actions`,
        requiredData: ['approved_content', 'social_sessions', 'segments']
      };

    case 'seo':
      return {
        additionalContext: '',
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
- Test website accessibility and loading speed before claiming SEO completion`,
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
        additionalContext: contentContext,
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
- Verify content appears in correct campaign/section if associated with campaign_id`,
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
        additionalContext: campaignsContext,
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
- Test ad creative displays correctly before launching`,
        requiredData: ['active_campaigns', 'ad_platforms', 'campaign_budgets']
      };

    case 'ux analysis':
      return {
        additionalContext: '',
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
- Verify A/B tests are running correctly if system shows them as active`,
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
        additionalContext: requirementsContext,
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
- Check if requirements dependencies are actually available and working`,
        requiredData: ['pending_requirements', 'current_resources', 'priority_matrix']
      };

    default:
      return {
        additionalContext: '',
        specificInstructions: `
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
- Test all functionality before marking activities as complete`,
        requiredData: ['general_context']
      };
  }
}

// ------------------------------------------------------------------------------------
// POST /api/agents/growth/robot/plan
// Genera un plan de actividades para la "activity" recibida considerando
// sesiones de autenticación previas y creando un comando para la ejecución.
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 min – ejecuta comando completo

const CreatePlanSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  user_id: z.string().uuid('user_id debe ser un UUID válido'),
  instance_id: z.string().uuid('instance_id debe ser un UUID válido'),
  activity: z.string().min(3, 'activity es requerido'),
});

export async function POST(request: NextRequest) {
  try {
    // 1. Validar y parsear body -------------------------------------------------------
    const rawBody = await request.json();
    const { site_id, user_id, instance_id, activity } = CreatePlanSchema.parse(rawBody);

    // 2. Recuperar sesiones de autenticación previas ---------------------------------
    const { data: previousSessions, error: sessionsError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', site_id)
      .eq('is_valid', true);

    if (sessionsError) {
      console.error('Error fetching previous sessions:', sessionsError);
    }

    // 3. Encontrar el agente robot apropiado ------------------------------------------
    const robotAgent = await findGrowthRobotAgent(site_id);
    
    if (!robotAgent) {
      return NextResponse.json(
        { error: 'No se encontró un agente robot apropiado para este sitio' },
        { status: 404 },
      );
    }

    console.log(`🤖 Robot agent encontrado: ${robotAgent.agentId}`);

    // 4. Registrar un registro base en instance_plans --------------------------------
    const { data: newPlan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .insert({
        title: `Plan simple para actividad: ${activity}`,
        description: 'Plan simple y enfocado generado automáticamente para ejecución en 1-2 horas máximo',
        plan_type: 'objective',
        status: 'pending',
        instance_id,
        site_id,
        user_id,
      })
      .select()
      .single();

    if (planError) {
      console.error('Error inserting plan:', planError);
      return NextResponse.json({ error: 'Error al registrar el plan' }, { status: 500 });
    }

    // 5. Obtener contexto específico para el tipo de actividad ------------------------
    console.log(`🎯 OBTENIENDO: Contexto específico para actividad: ${activity}`);
    
    let activityContext;
    try {
      activityContext = await getActivitySpecificContext(activity, site_id);
    } catch (error: any) {
      // Manejar el caso específico de autenticación requerida
      if (error.message?.startsWith('AUTHENTICATION_REQUIRED:')) {
        const errorMessage = error.message.replace('AUTHENTICATION_REQUIRED:', '');
        
        console.log(`🔐 AUTENTICACIÓN REQUERIDA: ${errorMessage}`);
        
        // Actualizar el plan como fallido por falta de autenticación
        await supabaseAdmin
          .from('instance_plans')
          .update({
            status: 'requires_auth',
            error: errorMessage,
          })
          .eq('id', newPlan.id);

        return NextResponse.json(
          { 
            error: 'AUTHENTICATION_REQUIRED',
            message: errorMessage,
            instance_plan_id: newPlan.id,
            action_required: {
              type: 'LOGIN_REQUIRED',
              message: 'Se requiere iniciar sesión en las plataformas necesarias',
              login_url: '/auth/platforms', // URL donde el usuario puede iniciar sesión
              platforms_needed: ['social_media', 'google', 'linkedin'], // Plataformas sugeridas
              instructions: 'Por favor, inicia sesión en al menos una plataforma para usar el modo Free Agent'
            }
          },
          { status: 403 }, // 403 Forbidden - autenticación requerida
        );
      }
      
      // Si es otro tipo de error, relanzarlo
      throw error;
    }
    
    // 6. Manejo especial para Free Agent vs otras actividades ------------------------
    let planData;
    let planningCommandUuid = null;
    
    if (activity.toLowerCase().trim() === 'free agent' || activity.toLowerCase().trim() === 'free-agent') {
      console.log(`🆓 FREE AGENT MODE: Creando plan básico sin ejecutar comando robot`);
      
      // Crear plan básico para Free Agent sin ejecutar comando
      planData = {
        title: "Plan básico Free Agent - Navegación DuckDuckGo",
        description: "Plan simple para navegación básica en DuckDuckGo sin requerir autenticación",
        phases: [
          {
            phase_name: "Navegación Web Básica",
            description: "Fase enfocada en navegación básica web sin autenticación",
            timeline: "30-45 minutos",
            success_criteria: [
              "Navegador abierto exitosamente",
              "DuckDuckGo accesible",
              "Búsqueda realizada sin errores",
              "Resultados obtenidos"
            ],
            steps: [
              {
                title: "Abrir navegador web",
                platform: "Browser",
                description: "Iniciar el navegador y verificar conectividad",
                step_number: 1,
                automation_level: "automated",
                estimated_duration: "5 minutos",
                required_authentication: "none"
              },
              {
                title: "Navegar a DuckDuckGo",
                platform: "DuckDuckGo",
                description: "Ir a duckduckgo.com para realizar búsquedas",
                step_number: 2,
                automation_level: "automated",
                estimated_duration: "5 minutos",
                required_authentication: "none"
              },
              {
                title: "Realizar búsqueda básica",
                platform: "DuckDuckGo",
                description: "Hacer una búsqueda simple relacionada con el negocio",
                step_number: 3,
                automation_level: "automated",
                estimated_duration: "10 minutos",
                required_authentication: "none"
              },
              {
                title: "Revisar resultados",
                platform: "DuckDuckGo",
                description: "Examinar los primeros resultados de búsqueda",
                step_number: 4,
                automation_level: "automated",
                estimated_duration: "15 minutos",
                required_authentication: "none"
              },
              {
                title: "Completar navegación",
                platform: "Browser",
                description: "Finalizar la sesión de navegación",
                step_number: 5,
                automation_level: "automated",
                estimated_duration: "10 minutos",
                required_authentication: "none"
              }
            ]
          }
        ],
        activity_type: "free-agent",
        error_handling: [
          "Si DuckDuckGo no carga, intentar recargar la página",
          "Si la búsqueda no funciona, verificar conectividad a internet",
          "Si los resultados no aparecen, probar con términos de búsqueda alternativos"
        ],
        priority_level: "medium",
        success_metrics: [
          "Navegador abierto exitosamente",
          "DuckDuckGo accesible",
          "Búsqueda realizada sin errores",
          "Resultados obtenidos"
        ],
        estimated_timeline: "45 minutos",
        browser_requirements: [
          "Chrome o Firefox browser",
          "Conexión estable a internet"
        ],
        execution_objectives: [
          "Validar conectividad web básica",
          "Realizar búsqueda simple sin autenticación",
          "Documentar resultados encontrados"
        ],
        required_integrations: [
          "none"
        ]
      };
      
    } else {
      console.log(`🤖 INICIANDO: Ejecutando planificación de actividad con Robot...`);
      
      const { activityPlanResults, planningCommandUuid: commandUuid } = await executeRobotActivityPlanning(
        site_id,
        robotAgent.agentId,
        robotAgent.userId,
        activity,
        previousSessions || [],
        activityContext
      );

      planningCommandUuid = commandUuid;

      if (!activityPlanResults || activityPlanResults.length === 0) {
        console.log(`❌ FALLO: Robot activity planning falló - actualizando plan como fallido`);
        
        // Actualizar el plan como fallido
        await supabaseAdmin
          .from('instance_plans')
          .update({
            status: 'failed',
            command_id: planningCommandUuid,
          })
          .eq('id', newPlan.id);

        return NextResponse.json(
          { 
            error: 'No se pudo generar el plan de actividad con el robot',
            instance_plan_id: newPlan.id,
          },
          { status: 500 },
        );
      }

      console.log(`✅ COMPLETADO: Planificación de actividad completada con ${activityPlanResults.length} plan(s)`);
      console.log(`🔑 Planning Command UUID: ${planningCommandUuid}`);
      
      planData = activityPlanResults[0]; // Tomar el primer plan generado
    }

    // 7. Actualizar el plan con los resultados ----------------------------------------
    
    // Calcular el total de steps del plan
    const stepsTotal = planData.phases ? 
      planData.phases.reduce((total: number, phase: any) => 
        total + (phase.steps?.length || 0), 0
      ) : 0;

    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'completed',
        command_id: planningCommandUuid,
        title: planData.title || `Plan simple para actividad: ${activity}`,
        description: planData.description || 'Plan simple y enfocado generado automáticamente para ejecución en 1-2 horas máximo',
        results: planData, // Guardar todo el plan generado
        success_criteria: planData.success_metrics || planData.success_criteria || [],
        steps_total: stepsTotal,
        steps_completed: 0,
        progress_percentage: 0,
        estimated_duration_minutes: (() => {
          // Intentar extraer números del timeline o duration
          const timelineValue = planData.estimated_timeline || planData.estimated_duration_minutes;
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
        })(),
        priority: typeof planData.priority_level === 'string' ? 5 : (planData.priority_level || planData.priority || 5),
      })
      .eq('id', newPlan.id);

    if (updateError) {
      console.error('Error updating plan:', updateError);
      return NextResponse.json({ error: 'Error al actualizar el plan con los resultados' }, { status: 500 });
    }

    console.log(`🎉 PROCESO COMPLETO: Plan guardado exitosamente`);

    return NextResponse.json(
      {
        instance_plan_id: newPlan.id,
        command_id: planningCommandUuid,
        message: 'Plan creado y ejecutado correctamente',
        plan_data: planData,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robot/plan:', err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}