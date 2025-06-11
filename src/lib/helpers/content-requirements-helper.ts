import { supabaseAdmin } from '@/lib/database/supabase-client';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Interface for content requirements
interface ContentRequirement {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  completion_status: string;
  type: string;
  campaign_id: string;
  campaign_name?: string;
  campaign_description?: string;
  campaign_objective?: string;
  campaign_target_audience?: string;
  campaign_channels?: string[];
  metadata?: any;
  created_at: string;
  due_date?: string;
}

// Step-by-step function to get content requirements for a site
export async function getContentRequirementsForSite(siteId: string, campaignId?: string): Promise<ContentRequirement[]> {
  console.log(`🚀 [getContentRequirementsForSite] INICIANDO función para site: ${siteId}, campaign: ${campaignId || 'ALL'}`);
  
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.log(`❌ Invalid site_id for content requirements search: ${siteId}`);
      return [];
    }

    // Validate campaignId if provided
    if (campaignId && !isValidUUID(campaignId)) {
      console.log(`❌ Invalid campaign_id for content requirements search: ${campaignId}`);
      return [];
    }

    // Check service role configuration
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    console.log(`🔑 [getContentRequirementsForSite] Service Role Key configured: ${serviceRoleKey ? 'YES' : 'NO'}`);

    console.log(`🔍 [getContentRequirementsForSite] STEP 1: Buscando campaigns para el sitio: ${siteId}${campaignId ? `, filtrando por campaign: ${campaignId}` : ''}`);

    // Test service role access with a simple query
    console.log(`🧪 Testing service role access...`);
    const { data: testData, error: testError } = await supabaseAdmin
      .from('sites')
      .select('id, name')
      .eq('id', siteId)
      .single();
    
    if (testError) {
      console.error(`❌ Service Role test failed:`, testError);
      console.error(`❌ Error details:`, {
        message: testError.message,
        details: testError.details,
        hint: testError.hint,
        code: testError.code
      });
    } else {
      console.log(`✅ Service Role test successful: Found site "${testData?.name}"`);
    }

    // STEP 1: Get campaigns for this site (exclude completed)
    // Filter by specific campaign if campaignId is provided
    let campaignsQuery = supabaseAdmin
      .from('campaigns')
      .select('id, title, status, description, type, due_date, priority')
      .eq('site_id', siteId)
      .neq('status', 'completed');
    
    if (campaignId) {
      campaignsQuery = campaignsQuery.eq('id', campaignId);
    }
    
    const { data: campaigns, error: campaignsError } = await campaignsQuery;

    if (campaignsError) {
      console.error('❌ Error al buscar campaigns:', campaignsError);
      console.error('❌ Campaign error details:', {
        message: campaignsError.message,
        details: campaignsError.details,
        hint: campaignsError.hint,
        code: campaignsError.code
      });
      return [];
    }

    console.log(`📋 STEP 1 RESULT: Encontradas ${campaigns?.length || 0} campaigns`);
    if (campaigns && campaigns.length > 0) {
      campaigns.forEach(c => console.log(`  - ${c.title} (${c.id}) [${c.status}]`));
    }

    if (!campaigns || campaigns.length === 0) {
      console.log(`⚠️ No hay campaigns, intentando búsqueda directa por site_id...`);
      
      // First, let's test if we can access requirements table at all
      console.log(`🧪 Testing basic access to requirements table...`);
      const { data: testReqs, error: testReqError } = await supabaseAdmin
        .from('requirements')
        .select('id, title, type')
        .limit(3);
      
      if (testReqError) {
        console.error(`❌ Cannot access requirements table:`, testReqError);
      } else {
        console.log(`✅ Can access requirements table. Found ${testReqs?.length || 0} requirements (sample)`);
        if (testReqs && testReqs.length > 0) {
          testReqs.forEach(req => console.log(`  - "${req.title}" (${req.type})`));
        }
      }
      
      // Fallback: direct search by site_id in requirements table (exact same as debug query)
      console.log(`🔍 [getContentRequirementsForSite] Ejecutando búsqueda directa exactamente igual al debug...`);
      const { data: directRequirements, error: directError } = await supabaseAdmin
        .from('requirements')
        .select(`
          id,
          title,
          description,
          priority,
          status,
          completion_status,
          type,
          site_id
        `)
        .eq('type', 'content')
        .eq('site_id', siteId)
        .neq('completion_status', 'completed');

      console.log(`📊 [getContentRequirementsForSite] Direct search results:`);
      console.log(`  - Error: ${directError ? directError.message : 'None'}`);
      console.log(`  - Data length: ${directRequirements?.length || 0}`);
      console.log(`  - Data:`, directRequirements);

      if (directError) {
        console.error('❌ Error en búsqueda directa:', directError);
        console.error('❌ Direct search error details:', {
          message: directError.message,
          details: directError.details,
          hint: directError.hint,
          code: directError.code
        });
        return [];
      }

      console.log(`📋 DIRECT SEARCH: Encontrados ${directRequirements?.length || 0} requirements directos`);
      
      if (!directRequirements || directRequirements.length === 0) {
        return [];
      }

      // Transform direct requirements
      const directlyFoundRequirements: ContentRequirement[] = directRequirements.map(req => ({
        id: req.id,
        title: req.title,
        description: req.description || '',
        priority: req.priority,
        status: req.status,
        completion_status: req.completion_status,
        type: req.type,
        campaign_id: 'direct',
        campaign_name: 'Direct Site Requirement',
        metadata: {},
        created_at: '',
        due_date: ''
      }));

      console.log(`🎯 [getContentRequirementsForSite] RETURNING ${directlyFoundRequirements.length} direct requirements`);
      console.log(`🎯 [getContentRequirementsForSite] Direct requirements titles:`, directlyFoundRequirements.map(r => r.title));
      return directlyFoundRequirements;
    }

    // STEP 2: Get campaign_requirements for these campaigns
    const campaignIds = campaigns.map(c => c.id);
    console.log(`🔍 STEP 2: Buscando campaign_requirements para ${campaignIds.length} campaigns`);
    
    const { data: campaignRequirements, error: crError } = await supabaseAdmin
      .from('campaign_requirements')
      .select('campaign_id, requirement_id')
      .in('campaign_id', campaignIds);

    if (crError) {
      console.error('❌ Error al buscar campaign_requirements:', crError);
      return [];
    }

    console.log(`📋 STEP 2 RESULT: Encontradas ${campaignRequirements?.length || 0} relaciones campaign_requirements`);
    
    if (!campaignRequirements || campaignRequirements.length === 0) {
      console.log(`⚠️ No hay campaign_requirements, no hay requirements vinculados a campaigns`);
      return [];
    }

    // STEP 3: Get requirements and filter by type 'content'
    const requirementIds = campaignRequirements.map(cr => cr.requirement_id);
    console.log(`🔍 STEP 3: Buscando ${requirementIds.length} requirements y filtrando por type='content'`);

    const { data: requirements, error: reqError } = await supabaseAdmin
      .from('requirements')
      .select(`
        id,
        title,
        description,
        priority,
        status,
        completion_status,
        type
      `)
      .in('id', requirementIds)
      .eq('type', 'content')
      .neq('completion_status', 'completed');

    if (reqError) {
      console.error('❌ Error al buscar requirements:', reqError);
      return [];
    }

    console.log(`📋 STEP 3 RESULT: Encontrados ${requirements?.length || 0} requirements de contenido`);

    if (!requirements || requirements.length === 0) {
      console.log(`⚠️ No hay requirements de tipo 'content' en las relaciones encontradas`);
      return [];
    }

    // STEP 4: Combine with campaign information
    const contentRequirements: ContentRequirement[] = requirements.map(req => {
      // Find the campaign relationship
      const relationship = campaignRequirements.find(cr => cr.requirement_id === req.id);
      const campaign = relationship ? campaigns.find(c => c.id === relationship.campaign_id) : null;

      return {
        id: req.id,
        title: req.title,
        description: req.description || '',
        priority: req.priority,
        status: req.status,
        completion_status: req.completion_status,
        type: req.type,
        campaign_id: relationship?.campaign_id || 'unknown',
        campaign_name: campaign?.title || 'Unknown Campaign',
        campaign_description: campaign?.description || '',
        campaign_objective: campaign?.type || '',
        campaign_target_audience: '',
        campaign_channels: [],
        metadata: {},
        created_at: '',
        due_date: ''
      };
    });

    // Sort by priority and due date
    contentRequirements.sort((a, b) => {
      const priorityOrder = { 'high': 1, 'medium': 2, 'low': 3 };
      const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] || 4;
      const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] || 4;
      
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      if (a.due_date && b.due_date) {
        return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      }
      
      return 0;
    });

    console.log(`🎯 [getContentRequirementsForSite] FINAL RESULT: Returning ${contentRequirements.length} content requirements`);
    contentRequirements.forEach(req => {
      console.log(`  - "${req.title}" (status: ${req.status}, completion: ${req.completion_status}) in "${req.campaign_name}"`);
    });

    return contentRequirements;

  } catch (error: any) {
    console.error('❌ [getContentRequirementsForSite] Error:', error);
    console.error('❌ [getContentRequirementsForSite] Error message:', error?.message);
    console.error('❌ [getContentRequirementsForSite] Error code:', error?.code);
    console.error('❌ [getContentRequirementsForSite] Stack trace:', error?.stack);
    console.log(`🔄 [getContentRequirementsForSite] RETURNING empty array due to error`);
    return [];
  }
}

// Function to format content requirements as context
export function formatContentRequirementsAsContext(requirements: ContentRequirement[]): string {
  if (!requirements || requirements.length === 0) {
    return '';
  }

  const contextParts = [];
  contextParts.push(`ACTIVE CONTENT REQUIREMENTS FOR ONGOING CAMPAIGNS:`);
  contextParts.push(`The following content requirements should be addressed in your content calendar:`);
  contextParts.push('');

  // Group requirements by campaign
  const requirementsByCampaign = requirements.reduce((acc, req) => {
    const campaignName = req.campaign_name || 'Unknown Campaign';
    if (!acc[campaignName]) {
      acc[campaignName] = [];
    }
    acc[campaignName].push(req);
    return acc;
  }, {} as Record<string, ContentRequirement[]>);

  // Format each campaign's requirements
  Object.entries(requirementsByCampaign).forEach(([campaignName, campaignRequirements]) => {
    const firstReq = campaignRequirements[0];
    
    contextParts.push(`CAMPAIGN: ${campaignName} (ID: ${firstReq.campaign_id})`);
    if (firstReq.campaign_description && firstReq.campaign_description.trim()) {
      contextParts.push(`Description: ${firstReq.campaign_description}`);
    }
    contextParts.push('');
    
    contextParts.push(`Content Requirements (${campaignRequirements.length}):`);
    campaignRequirements.forEach((req, index) => {
      const priorityEmoji = req.priority === 'high' ? '🔥' : req.priority === 'medium' ? '⚡' : '📝';
      contextParts.push(`${index + 1}. ${priorityEmoji} ${req.title}`);
      if (req.description && req.description.trim()) {
        contextParts.push(`   ${req.description}`);
      }
      contextParts.push('');
    });
  });

  contextParts.push(`INSTRUCTIONS: Create content that addresses these requirements and reference them in your content planning.`);
  return contextParts.join('\n');
}

// Function to debug and check if requirements exist for a site
export async function debugContentRequirements(siteId: string): Promise<void> {
  console.log(`🐛 DEBUG: Verificando requirements para site ${siteId}`);
  
  try {
    // Check if site exists
    const { data: site } = await supabaseAdmin
      .from('sites')
      .select('id, name')
      .eq('id', siteId)
      .single();
    
    console.log(`🏢 Site encontrado:`, site);
    
    // Check campaigns
    const { data: allCampaigns } = await supabaseAdmin
      .from('campaigns')
      .select('id, title, status')
      .eq('site_id', siteId);
    
    console.log(`📋 Todas las campañas (${allCampaigns?.length || 0}):`, allCampaigns);
    
    // Check campaign_requirements relationships
    const { data: campaignReqs } = await supabaseAdmin
      .from('campaign_requirements')
      .select(`
        campaign_id,
        requirement_id,
        campaigns(title, site_id),
        requirements(title, type, status)
      `)
      .eq('campaigns.site_id', siteId);
    
    console.log(`🔗 Campaign requirements relationships (${campaignReqs?.length || 0}):`, campaignReqs);
    
    // Check content requirements specifically
    const { data: contentRequirements } = await supabaseAdmin
      .from('campaign_requirements')
      .select(`
        campaign_id,
        requirement_id,
        campaigns(title, site_id),
        requirements(id, title, type, status)
      `)
      .eq('campaigns.site_id', siteId)
      .eq('requirements.type', 'content');
    
    console.log(`📝 Requirements de contenido (${contentRequirements?.length || 0}):`, contentRequirements);
    
  } catch (error) {
    console.error('🐛 Error en debug:', error);
  }
}

// Function to get and format content requirements context
export async function getContentRequirementsContext(siteId: string, campaignId?: string): Promise<string> {
  try {
    console.log(`📋 [getContentRequirementsContext] INICIANDO para site: ${siteId}, campaign: ${campaignId || 'ALL'}`);
    
    const requirements = await getContentRequirementsForSite(siteId, campaignId);
    console.log(`📋 [getContentRequirementsContext] Resultado de getContentRequirementsForSite: ${requirements.length} requirements`);
    
    if (requirements.length === 0) {
      console.log(`📋 [getContentRequirementsContext] No hay requirements de contenido ${campaignId ? `para la campaña: ${campaignId}` : `para el sitio: ${siteId}`}`);
      return '';
    }
    
    console.log(`📋 [getContentRequirementsContext] Formateando ${requirements.length} requirements de contenido como contexto`);
    console.log(`📋 [getContentRequirementsContext] Requirements encontrados:`, requirements.map(r => ({ id: r.id, title: r.title, campaign: r.campaign_name })));
    
    const context = formatContentRequirementsAsContext(requirements);
    console.log(`📋 [getContentRequirementsContext] Contexto generado (${context.length} caracteres)`);
    console.log(`📋 [getContentRequirementsContext] Primeros 200 caracteres del contexto: ${context.substring(0, 200)}`);
    
    return context;
    
  } catch (error) {
    console.error('❌ [getContentRequirementsContext] Error al generar contexto de requirements de contenido:', error);
    console.error('❌ [getContentRequirementsContext] Stack trace:', error);
    return '';
  }
} 