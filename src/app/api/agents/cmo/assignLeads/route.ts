import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';
import { fetchEligibleMemberIds, isProfileEligibleForLeadAssignment } from '@/lib/services/lead-assignment/eligibility';
import { formatLeadOrigin } from '@/lib/emails/lead-assignment';

// Schema de validación para la request
const AssignLeadsSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  user_id: z.string().uuid('user_id debe ser un UUID válido').optional(),
  max_leads_per_segment: z.number().min(1).max(5).default(3), // Reducido por defecto
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  include_attribution_context: z.boolean().default(true),
  min_quality_score: z.number().min(0).max(100).default(70), // Nuevo: score mínimo para asignación
  max_total_assignments: z.number().min(1).max(20).default(10) // Nuevo: límite total de asignaciones
});

// Interfaz para el resultado de asignación
interface LeadAssignment {
  lead_id: string;
  assignee_id: string;
  brief: string;
  intro_message: string;
  segment_info?: {
    segment_id: string;
    segment_name: string;
    attribution_data: any;
  };
  lead_info: {
    name: string;
    email: string;
    company?: any;
    phone?: string;
    origin?: string;
    created_at: string;
  };
}

// Interfaz para lead scoring
interface LeadScore {
  lead_id: string;
  total_score: number;
  company_score: number;
  segment_score: number;
  urgency_score: number;
  engagement_score: number;
  business_value_score: number;
  priority_tier: 'critical' | 'high' | 'medium' | 'low';
}

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener leads sin interacciones ni tareas
async function getLeadsWithoutInteractions(siteId: string, maxLeadsPerSegment: number = 5): Promise<any[]> {
  try {
    console.log(`🔍 Buscando leads sin interacciones para sitio: ${siteId}`);
    
    // Buscar leads que no tengan:
    // 1. assignee_id (no están asignados)
    // 2. No tengan conversations
    // 3. No tengan tasks
    const { data: leads, error } = await supabaseAdmin
      .from('leads')
      .select(`
        *,
        segments!inner(id, name, description, analysis),
        conversations!left(id),
        tasks!left(id)
      `)
      .eq('site_id', siteId)
      .is('assignee_id', null) // No asignados
      .is('conversations.id', null) // Sin conversaciones
      .is('tasks.id', null) // Sin tareas
      .neq('status', 'converted') // Excluir leads ya convertidos
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener leads sin interacciones:', error);
      return [];
    }
    
    if (!leads || leads.length === 0) {
      console.log('⚠️ No se encontraron leads sin interacciones');
      return [];
    }
    
    // Agrupar leads por segmento y limitar a maxLeadsPerSegment por segmento
    const leadsBySegment = new Map<string, any[]>();
    
    for (const lead of leads) {
      const segmentId = lead.segment_id;
      if (!segmentId) continue; // Saltar leads sin segmento
      
      if (!leadsBySegment.has(segmentId)) {
        leadsBySegment.set(segmentId, []);
      }
      
      const segmentLeads = leadsBySegment.get(segmentId)!;
      if (segmentLeads.length < maxLeadsPerSegment) {
        segmentLeads.push(lead);
      }
    }
    
    // Convertir el Map a un array plano
    const filteredLeads = Array.from(leadsBySegment.values()).flat();
    
    console.log(`✅ Encontrados ${filteredLeads.length} leads sin interacciones distribuidos en ${leadsBySegment.size} segmentos`);
    
    return filteredLeads;
    
  } catch (error) {
    console.error('Error al obtener leads sin interacciones:', error);
    return [];
  }
}

// Función para obtener team members con más atribuciones por segmento
async function getTeamMemberAttributionsBySegment(siteId: string): Promise<Map<string, string>> {
  try {
    console.log(`📊 Calculando atribuciones de team members por segmento para sitio: ${siteId}`);
    
    // Buscar leads convertidos agrupados por segmento y assignee_id
    const { data: convertedLeads, error } = await supabaseAdmin
      .from('leads')
      .select('segment_id, assignee_id, segments!inner(name)')
      .eq('site_id', siteId)
      .eq('status', 'converted')
      .not('assignee_id', 'is', null)
      .not('segment_id', 'is', null);
    
    if (error) {
      console.error('Error al obtener leads convertidos:', error);
      return new Map();
    }
    
    if (!convertedLeads || convertedLeads.length === 0) {
      console.log('⚠️ No se encontraron leads convertidos para calcular atribuciones');
      return new Map();
    }
    
    // Agrupar conversiones por segmento y assignee_id
    const segmentAttributions = new Map<string, Map<string, number>>();
    
    for (const lead of convertedLeads) {
      const segmentId = lead.segment_id;
      const assigneeId = lead.assignee_id;
      
      if (!segmentAttributions.has(segmentId)) {
        segmentAttributions.set(segmentId, new Map());
      }
      
      const segmentMap = segmentAttributions.get(segmentId)!;
      const currentCount = segmentMap.get(assigneeId) || 0;
      segmentMap.set(assigneeId, currentCount + 1);
    }
    
    // Encontrar el team member con más atribuciones para cada segmento
    const bestAssigneeBySegment = new Map<string, string>();
    
    segmentAttributions.forEach((assigneeMap, segmentId) => {
      let bestAssignee = '';
      let maxAttributions = 0;
      
      assigneeMap.forEach((attributions, assigneeId) => {
        if (attributions > maxAttributions) {
          maxAttributions = attributions;
          bestAssignee = assigneeId;
        }
      });
      
      if (bestAssignee) {
        bestAssigneeBySegment.set(segmentId, bestAssignee);
        console.log(`🏆 Segmento ${segmentId}: Team member ${bestAssignee} con ${maxAttributions} atribuciones`);
      }
    });
    
    return bestAssigneeBySegment;
    
  } catch (error) {
    console.error('Error al calcular atribuciones por segmento:', error);
    return new Map();
  }
}

// Función para obtener team members disponibles como fallback
async function getAvailableTeamMembers(siteId: string): Promise<string[]> {
  try {
    console.log(`👥 Buscando team members elegibles (excluyendo externos) para sitio: ${siteId}`);
    const eligibleIds = await fetchEligibleMemberIds(siteId);
    if (!eligibleIds || eligibleIds.length === 0) {
      console.log('⚠️ No se encontraron team members elegibles para asignación');
      return [];
    }
    console.log(`✅ Encontrados ${eligibleIds.length} team members elegibles`);
    return eligibleIds;
  } catch (error) {
    console.error('Error al obtener team members disponibles:', error);
    return [];
  }
}

// Función para generar brief para un lead
function generateLeadBrief(lead: any, segment: any, assignee: any, attributionData?: any): string {
  const companyName = lead.company?.name || 'Company not specified';
  const leadName = lead.name || 'Lead name not available';
  const segmentName = segment?.name || 'Segment not specified';
  const origin = formatLeadOrigin(lead.origin) || 'Unknown';
  
  let brief = `**Lead Assignment: ${leadName}**\n\n`;
  brief += `**Company:** ${companyName}\n`;
  brief += `**Email:** ${lead.email}\n`;
  brief += `**Phone:** ${lead.phone || 'Not provided'}\n`;
  brief += `**Origin:** ${origin}\n`;
  brief += `**Segment:** ${segmentName}\n\n`;
  
  brief += `**Context:**\n`;
  brief += `This lead belongs to the ${segmentName} segment and has been identified as a potential customer without previous interactions. `;
  
  if (attributionData) {
    brief += `You have been selected as the assignee because you have the best performance record with this segment type (${attributionData.conversions || 0} successful conversions). `;
  } else {
    brief += `You have been assigned to this lead based on availability and segment matching. `;
  }
  
  brief += `The lead was generated through ${origin} and is awaiting first contact.\n\n`;
  
  brief += `**Recommended Actions:**\n`;
  brief += `1. Review the lead's company information and industry background\n`;
  brief += `2. Prepare a personalized introduction email within 24 hours\n`;
  brief += `3. Research the company's potential needs based on the ${segmentName} segment characteristics\n`;
  brief += `4. Schedule a discovery call to understand their requirements\n`;
  brief += `5. Document all interactions and progress in the CRM system\n\n`;
  
  brief += `**Success Tips:**\n`;
  brief += `- Focus on the specific value proposition for the ${segmentName} segment\n`;
  brief += `- Highlight relevant case studies or testimonials from similar companies\n`;
  brief += `- Be responsive and professional in all communications\n`;
  brief += `- Track engagement metrics and adjust approach as needed`;
  
  return brief;
}

// Función para generar intro message
function generateIntroMessage(lead: any, segment: any, assignee: any): string {
  const leadName = lead.name || 'there';
  const companyName = lead.company?.name || 'your company';
  const segmentName = segment?.name || 'your industry';
  
  let intro = `Hi ${leadName},\n\n`;
  intro += `I hope this message finds you well. I'm reaching out from our team because I noticed ${companyName} might be interested in solutions that could benefit businesses in the ${segmentName} space.\n\n`;
  
  intro += `I'd love to learn more about your current challenges and see if there's a way we can help ${companyName} achieve its goals. `;
  intro += `I have experience working with similar companies and would be happy to share some insights that might be valuable.\n\n`;
  
  intro += `Would you be open to a brief 15-minute conversation this week? I can work around your schedule.\n\n`;
  
  intro += `Best regards,\n`;
  intro += `[Your Name]`;
  
  return intro;
}

// Función para obtener información del team member
async function getTeamMemberInfo(userId: string): Promise<any> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    
    if (error || !data.user) {
      console.error('Error al obtener información del team member:', error);
      return null;
    }
    
    const metadata = data.user.user_metadata || {};
    return {
      id: data.user.id,
      email: data.user.email,
      name: metadata.name || metadata.full_name || 'Team Member',
      role: metadata.role || 'team_member',
      metadata
    };
  } catch (error) {
    console.error('Error al obtener información del team member:', error);
    return null;
  }
}

// Función para calcular el score de importancia de un lead
function calculateLeadImportanceScore(lead: any, segment: any): LeadScore {
  let companyScore = 0;
  let segmentScore = 0;
  let urgencyScore = 0;
  let engagementScore = 0;
  let businessValueScore = 0;

  // 1. Company Score (0-25 puntos)
  if (lead.company) {
    const company = lead.company;
    
    // Tamaño de empresa (basado en empleados si disponible)
    if (company.employees) {
      if (company.employees > 500) companyScore += 10;
      else if (company.employees > 100) companyScore += 8;
      else if (company.employees > 50) companyScore += 6;
      else if (company.employees > 10) companyScore += 4;
      else companyScore += 2;
    } else {
      companyScore += 3; // Score base si no hay info de empleados
    }
    
    // Industria de alto valor
    const highValueIndustries = ['technology', 'finance', 'healthcare', 'saas', 'enterprise'];
    if (company.industry && highValueIndustries.includes(company.industry.toLowerCase())) {
      companyScore += 8;
    } else {
      companyScore += 4;
    }
    
    // Revenue estimado o tamaño de empresa
    if (company.revenue) {
      if (company.revenue > 10000000) companyScore += 7; // >10M
      else if (company.revenue > 1000000) companyScore += 5; // >1M
      else if (company.revenue > 100000) companyScore += 3; // >100K
      else companyScore += 1;
    } else {
      companyScore += 2; // Score base
    }
  } else {
    companyScore = 5; // Score mínimo si no hay company data
  }

  // 2. Segment Score (0-20 puntos)
  if (segment) {
    const segmentAnalysis = segment.analysis || {};
    
    // Conversion rate del segmento
    const conversionRate = segmentAnalysis.conversion_rate || 0;
    if (conversionRate > 0.15) segmentScore += 8;
    else if (conversionRate > 0.10) segmentScore += 6;
    else if (conversionRate > 0.05) segmentScore += 4;
    else segmentScore += 2;
    
    // Valor promedio del segmento
    const avgValue = segmentAnalysis.avg_deal_value || 0;
    if (avgValue > 50000) segmentScore += 7;
    else if (avgValue > 20000) segmentScore += 5;
    else if (avgValue > 10000) segmentScore += 3;
    else segmentScore += 1;
    
    // Volumen del segmento (menor volumen = mayor exclusividad)
    const segmentSize = segmentAnalysis.lead_count || 0;
    if (segmentSize < 50) segmentScore += 5; // Segmento exclusivo
    else if (segmentSize < 200) segmentScore += 3;
    else segmentScore += 1;
  } else {
    segmentScore = 5; // Score base si no hay segment data
  }

  // 3. Urgency Score (0-20 puntos)
  const createdAt = new Date(lead.created_at);
  const now = new Date();
  const hoursOld = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
  
  if (hoursOld < 2) urgencyScore += 15; // Muy reciente - actuar rápido
  else if (hoursOld < 24) urgencyScore += 12; // Reciente
  else if (hoursOld < 72) urgencyScore += 8; // Moderado
  else if (hoursOld < 168) urgencyScore += 4; // Una semana
  else urgencyScore += 1; // Muy antiguo
  
  // Boost por origen de alta calidad
  const highQualityOrigins = ['direct_inquiry', 'referral', 'demo_request', 'pricing_request'];
  if (lead.origin && highQualityOrigins.includes(lead.origin)) {
    urgencyScore += 5;
  }

  // 4. Engagement Score (0-15 puntos)
  if (lead.phone) engagementScore += 4; // Teléfono disponible
  if (lead.company && lead.company.website) engagementScore += 3; // Website company
  if (lead.name && lead.name.length > 3) engagementScore += 2; // Nombre completo
  if (lead.email && lead.email.includes('@') && !lead.email.includes('gmail')) engagementScore += 4; // Email corporativo
  else if (lead.email && lead.email.includes('@')) engagementScore += 2; // Email válido
  
  // Boost por datos completos
  if (lead.company && lead.phone && lead.name) {
    engagementScore += 2; // Bonus por perfil completo
  }

  // 5. Business Value Score (0-20 puntos)
  businessValueScore = 10; // Base score
  
  // Boost por indicadores de alto valor
  if (lead.company && lead.company.name) {
    const companyName = lead.company.name.toLowerCase();
    if (companyName.includes('enterprise') || companyName.includes('corp') || companyName.includes('inc')) {
      businessValueScore += 5;
    }
  }
  
  // Boost por origen premium
  if (lead.origin === 'enterprise_inquiry' || lead.origin === 'partner_referral') {
    businessValueScore += 5;
  }

  // Calcular score total
  const totalScore = companyScore + segmentScore + urgencyScore + engagementScore + businessValueScore;
  
  // Determinar tier de prioridad
  let priorityTier: 'critical' | 'high' | 'medium' | 'low';
  if (totalScore >= 85) priorityTier = 'critical';
  else if (totalScore >= 70) priorityTier = 'high';
  else if (totalScore >= 50) priorityTier = 'medium';
  else priorityTier = 'low';

  return {
    lead_id: lead.id,
    total_score: totalScore,
    company_score: companyScore,
    segment_score: segmentScore,
    urgency_score: urgencyScore,
    engagement_score: engagementScore,
    business_value_score: businessValueScore,
    priority_tier: priorityTier
  };
}

// Función modificada para obtener leads sin interacciones CON SCORING
async function getHighValueLeadsWithoutInteractions(siteId: string, maxLeadsPerSegment: number = 3, minQualityScore: number = 70): Promise<{leads: any[], scores: LeadScore[]}> {
  try {
    console.log(`🔍 Buscando leads de alto valor sin interacciones para sitio: ${siteId}`);
    
    // Buscar leads que no tengan:
    // 1. assignee_id (no están asignados)
    // 2. No tengan conversations
    // 3. No tengan tasks
    const { data: leads, error } = await supabaseAdmin
      .from('leads')
      .select(`
        *,
        segments!inner(id, name, description, analysis),
        conversations!left(id),
        tasks!left(id)
      `)
      .eq('site_id', siteId)
      .is('assignee_id', null) // No asignados
      .is('conversations.id', null) // Sin conversaciones
      .is('tasks.id', null) // Sin tareas
      .neq('status', 'converted') // Excluir leads ya convertidos
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener leads sin interacciones:', error);
      return { leads: [], scores: [] };
    }
    
    if (!leads || leads.length === 0) {
      console.log('⚠️ No se encontraron leads sin interacciones');
      return { leads: [], scores: [] };
    }
    
    // Calcular scores para todos los leads
    const leadsWithScores = leads.map(lead => ({
      lead,
      score: calculateLeadImportanceScore(lead, lead.segments)
    }));
    
    // Filtrar solo leads con score alto
    const highValueLeads = leadsWithScores.filter(item => 
      item.score.total_score >= minQualityScore
    );
    
    console.log(`📊 Leads evaluados: ${leads.length}, Leads de alto valor: ${highValueLeads.length} (score >= ${minQualityScore})`);
    
    // Ordenar por score descendente
    highValueLeads.sort((a, b) => b.score.total_score - a.score.total_score);
    
    // Agrupar por segmento y limitar por segmento
    const leadsBySegment = new Map<string, {lead: any, score: LeadScore}[]>();
    
    for (const item of highValueLeads) {
      const segmentId = item.lead.segment_id;
      if (!segmentId) continue;
      
      if (!leadsBySegment.has(segmentId)) {
        leadsBySegment.set(segmentId, []);
      }
      
      const segmentLeads = leadsBySegment.get(segmentId)!;
      if (segmentLeads.length < maxLeadsPerSegment) {
        segmentLeads.push(item);
      }
    }
    
    // Convertir a arrays planos manteniendo solo los mejores
    const finalLeads: any[] = [];
    const finalScores: LeadScore[] = [];
    
    leadsBySegment.forEach((items, segmentId) => {
      console.log(`🏆 Segmento ${segmentId}: ${items.length} leads de alto valor seleccionados`);
      items.forEach(item => {
        finalLeads.push(item.lead);
        finalScores.push(item.score);
        console.log(`  - Lead ${item.lead.name || item.lead.id}: ${item.score.total_score} pts (${item.score.priority_tier})`);
      });
    });
    
    console.log(`✅ Seleccionados ${finalLeads.length} leads de alto valor distribuidos en ${leadsBySegment.size} segmentos`);
    
    return { leads: finalLeads, scores: finalScores };
    
  } catch (error) {
    console.error('Error al obtener leads de alto valor:', error);
    return { leads: [], scores: [] };
  }
}

// Función mejorada para generar brief con scoring
function generateEnhancedLeadBrief(lead: any, segment: any, assignee: any, leadScore: LeadScore, attributionData?: any): string {
  const companyName = lead.company?.name || 'Company not specified';
  const leadName = lead.name || 'Lead name not available';
  const segmentName = segment?.name || 'Segment not specified';
  const origin = formatLeadOrigin(lead.origin) || 'Unknown';
  
  let brief = `**🚀 HIGH-PRIORITY LEAD ASSIGNMENT: ${leadName}**\n\n`;
  
  // Score Summary
  brief += `**📊 LEAD QUALITY SCORE: ${leadScore.total_score}/100 (${leadScore.priority_tier.toUpperCase()})**\n`;
  brief += `- Company Value: ${leadScore.company_score}/25\n`;
  brief += `- Segment Potential: ${leadScore.segment_score}/20\n`;
  brief += `- Urgency Level: ${leadScore.urgency_score}/20\n`;
  brief += `- Engagement Quality: ${leadScore.engagement_score}/15\n`;
  brief += `- Business Value: ${leadScore.business_value_score}/20\n\n`;
  
  // Lead Details
  brief += `**👤 LEAD DETAILS:**\n`;
  brief += `**Company:** ${companyName}\n`;
  brief += `**Email:** ${lead.email}\n`;
  brief += `**Phone:** ${lead.phone || 'Not provided'}\n`;
  brief += `**Origin:** ${origin}\n`;
  brief += `**Segment:** ${segmentName}\n\n`;
  
  // Priority Context
  brief += `**🎯 WHY THIS LEAD IS IMPORTANT:**\n`;
  brief += `This lead has been selected from a pool of candidates because it represents HIGH BUSINESS VALUE for the company. `;
  
  if (leadScore.priority_tier === 'critical') {
    brief += `⚠️  CRITICAL PRIORITY: This lead requires immediate attention due to exceptional scoring across multiple factors. `;
  } else if (leadScore.priority_tier === 'high') {
    brief += `🔥 HIGH PRIORITY: This lead shows strong potential and should be contacted within 2 hours. `;
  }
  
  if (attributionData) {
    brief += `You have been selected as the assignee because you have the best performance record with this segment type (${attributionData.conversions || 0} successful conversions). `;
  }
  
  brief += `The lead was generated through ${origin} and shows strong indicators of purchase intent.\n\n`;
  
  // Strategic Actions
  brief += `**🎯 STRATEGIC ACTIONS (Priority Order):**\n`;
  brief += `1. **IMMEDIATE (0-2 hours):** Send personalized introduction email\n`;
  brief += `2. **WITHIN 24 hours:** Follow up with phone call if number available\n`;
  brief += `3. **Research Phase:** Deep dive into company background and pain points\n`;
  brief += `4. **Qualification:** Schedule discovery call within 48 hours\n`;
  brief += `5. **Documentation:** Log all interactions and update lead status\n\n`;
  
  // Success Framework
  brief += `**💰 SUCCESS FRAMEWORK:**\n`;
  brief += `- **Target Response Time:** < 2 hours for first contact\n`;
  brief += `- **Conversion Goal:** Move to qualified opportunity within 1 week\n`;
  brief += `- **Value Proposition:** Focus on ${segmentName} segment-specific benefits\n`;
  brief += `- **Next Steps:** Qualify budget, timeline, and decision-making process\n\n`;
  
  brief += `**🏆 COMPETITIVE ADVANTAGE:**\n`;
  brief += `This lead represents significant revenue potential. Fast, professional response will differentiate us from competitors. `;
  brief += `Focus on understanding their specific challenges and positioning our solution as the ideal fit for their ${segmentName} needs.`;
  
  return brief;
}

export async function POST(request: NextRequest) {
  try {
    console.log('🎯 [CMO AssignLeads] Iniciando proceso de asignación de leads de ALTO VALOR');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = AssignLeadsSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [CMO AssignLeads] Error de validación:', validationResult.error.errors);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        },
        { status: 400 }
      );
    }
    
    const {
      site_id,
      user_id,
      max_leads_per_segment,
      priority,
      include_attribution_context,
      min_quality_score,
      max_total_assignments
    } = validationResult.data;
    
    console.log(`🔧 [CMO AssignLeads] Configuración: sitio=${site_id}, max_por_segmento=${max_leads_per_segment}, score_mínimo=${min_quality_score}, max_total=${max_total_assignments}`);
    
    // 1. Obtener SOLO leads de alto valor sin interacciones
    const { leads: highValueLeads, scores: leadScores } = await getHighValueLeadsWithoutInteractions(
      site_id, 
      max_leads_per_segment, 
      min_quality_score
    );
    
    if (highValueLeads.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            assignments: [],
            total_leads_processed: 0,
            total_assignments_made: 0,
            segments_processed: 0,
            message: `No high-value leads found (min score: ${min_quality_score}/100)`
          }
        },
        { status: 200 }
      );
    }
    
    // Limitar el número total de asignaciones
    const leadsToProcess = highValueLeads.slice(0, max_total_assignments);
    const scoresToProcess = leadScores.slice(0, max_total_assignments);
    
    console.log(`🎯 Procesando ${leadsToProcess.length} leads de alto valor (limitado a ${max_total_assignments} asignaciones totales)`);
    
    // 2. Obtener team members con más atribuciones por segmento
    const teamMemberAttributions = await getTeamMemberAttributionsBySegment(site_id);
    
    // 3. Obtener team members disponibles como fallback (elegibles)
    const availableTeamMembers = await getAvailableTeamMembers(site_id);
    
    if (availableTeamMembers.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NO_TEAM_MEMBERS_AVAILABLE',
            message: 'No team members available for lead assignment'
          }
        },
        { status: 400 }
      );
    }
    
    // 4. Crear asignaciones para leads de alto valor
    const assignments: (LeadAssignment & { quality_score: LeadScore })[] = [];
    const segmentsProcessed = new Set<string>();
    
    for (let i = 0; i < leadsToProcess.length; i++) {
      const lead = leadsToProcess[i];
      const leadScore = scoresToProcess[i];
      
      try {
        const segmentId = lead.segment_id;
        const segment = lead.segments;
        
        if (!segmentId || !segment) {
          console.warn(`⚠️ Lead ${lead.id} no tiene segmento válido, saltando...`);
          continue;
        }
        
        segmentsProcessed.add(segmentId);
        
        // Encontrar el mejor assignee para este segmento
        let assigneeId = teamMemberAttributions.get(segmentId);
        
        // Si no hay atribuciones específicas, usar el primer team member elegible disponible
        if (!assigneeId && availableTeamMembers.length > 0) {
          assigneeId = availableTeamMembers[0];
        }
        
        if (!assigneeId) {
          console.warn(`⚠️ No se pudo encontrar assignee para lead ${lead.id}`);
          continue;
        }
        
        // Obtener información del team member
        let teamMemberInfo = await getTeamMemberInfo(assigneeId);
        
        if (!teamMemberInfo) {
          console.warn(`⚠️ No se pudo obtener información del team member ${assigneeId}`);
          continue;
        }
        
        // Validar elegibilidad por políticas (excluir externos / roles no ventas)
        if (!isProfileEligibleForLeadAssignment(teamMemberInfo)) {
          console.warn(`⚠️ Assignee no elegible por políticas (externo/no ventas): ${assigneeId}. Usando fallback elegible si existe...`);
          const fallbackId = availableTeamMembers.find(id => id !== assigneeId);
          if (!fallbackId) {
            console.warn(`⚠️ No hay fallback elegible para lead ${lead.id}`);
            continue;
          }
          assigneeId = fallbackId;
          teamMemberInfo = await getTeamMemberInfo(assigneeId);
          if (!teamMemberInfo || !isProfileEligibleForLeadAssignment(teamMemberInfo)) {
            console.warn(`⚠️ Fallback ${assigneeId} tampoco es elegible, saltando lead ${lead.id}`);
            continue;
          }
        }
        
        // Generar brief e intro message mejorados
        const attributionData = include_attribution_context ? {
          conversions: 0 // TODO: Implementar conteo real de conversiones
        } : undefined;
        
        const brief = generateEnhancedLeadBrief(lead, segment, teamMemberInfo, leadScore, attributionData);
        const introMessage = generateIntroMessage(lead, segment, teamMemberInfo);
        
        // Crear asignación con scoring
        const assignment = {
          lead_id: lead.id,
          assignee_id: assigneeId,
          brief,
          intro_message: introMessage,
          segment_info: {
            segment_id: segmentId,
            segment_name: segment.name,
            attribution_data: attributionData
          },
          lead_info: {
            name: lead.name,
            email: lead.email,
            company: lead.company,
            phone: lead.phone,
            origin: formatLeadOrigin(lead.origin),
            created_at: lead.created_at
          },
          quality_score: leadScore
        };
        
        assignments.push(assignment);
        
        console.log(`✅ ASIGNACIÓN DE ALTO VALOR: Lead ${lead.name} (${leadScore.total_score} pts, ${leadScore.priority_tier}) → ${teamMemberInfo.name}`);
        
      } catch (error) {
        console.error(`❌ Error procesando lead ${lead.id}:`, error);
        continue;
      }
    }
    
    // 5. Retornar resultado con métricas de calidad
    const result = {
      success: true,
      data: {
        assignments,
        total_leads_processed: leadsToProcess.length,
        total_assignments_made: assignments.length,
        segments_processed: segmentsProcessed.size,
        quality_metrics: {
          min_score_threshold: min_quality_score,
          avg_score: assignments.length > 0 ? 
            assignments.reduce((sum, a) => sum + a.quality_score.total_score, 0) / assignments.length : 0,
          score_distribution: {
            critical: assignments.filter(a => a.quality_score.priority_tier === 'critical').length,
            high: assignments.filter(a => a.quality_score.priority_tier === 'high').length,
            medium: assignments.filter(a => a.quality_score.priority_tier === 'medium').length,
            low: assignments.filter(a => a.quality_score.priority_tier === 'low').length
          }
        },
        summary: {
          leads_by_segment: (() => {
            const segmentSummaries: any[] = [];
            const segmentIds: string[] = [];
            segmentsProcessed.forEach(id => segmentIds.push(id));
            
            for (let i = 0; i < segmentIds.length; i++) {
              const segmentId = segmentIds[i];
              const segmentAssignments = assignments.filter(a => a.segment_info?.segment_id === segmentId);
              const assigneeIds = segmentAssignments.map(a => a.assignee_id);
              const uniqueAssignees = assigneeIds.filter((id, index) => assigneeIds.indexOf(id) === index);
              const avgScore = segmentAssignments.reduce((sum, a) => sum + a.quality_score.total_score, 0) / segmentAssignments.length;
              
              segmentSummaries.push({
                segment_id: segmentId,
                segment_name: segmentAssignments[0]?.segment_info?.segment_name || 'Unknown',
                leads_assigned: segmentAssignments.length,
                avg_quality_score: Math.round(avgScore),
                assignees: uniqueAssignees
              });
            }
            return segmentSummaries;
          })(),
          attribution_strategy: teamMemberAttributions.size > 0 ? 'performance_based' : 'availability_based',
          priority_level: priority,
          selection_strategy: 'high_value_scoring'
        }
      }
    };
    
    console.log(`🎉 [CMO AssignLeads] PROCESO COMPLETADO: ${assignments.length} asignaciones de ALTO VALOR creadas`);
    console.log(`📊 Score promedio: ${result.data.quality_metrics.avg_score.toFixed(1)}/100`);
    
    return NextResponse.json(result, { status: 200 });
    
  } catch (error) {
    console.error('❌ [CMO AssignLeads] Error interno:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An error occurred while processing high-value lead assignments'
        }
      },
      { status: 500 }
    );
  }
} 