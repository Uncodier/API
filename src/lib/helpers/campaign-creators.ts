import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from './command-utils';

// Función para crear campañas desde los resultados del Growth Marketer
export async function createCampaignsFromResults(
  campaignsData: any[], 
  siteId: string, 
  userId: string, 
  planningCommandUuid: string | null
): Promise<any[]> {
  console.log(`🔄 Procesando resultados de Growth Marketer para crear campañas...`);
  
  try {
    if (!campaignsData || !Array.isArray(campaignsData) || campaignsData.length === 0) {
      console.log('Los resultados del Growth Marketer no tienen campañas válidas');
      return [];
    }
    
    // El command_id para inserción en base de datos
    console.log(`🔑 Planning Command UUID: ${planningCommandUuid}`);
    
    // Verificar que el command_id existe en la tabla commands si es UUID válido
    const validPlanningId = planningCommandUuid && isValidUUID(planningCommandUuid);
    
    if (validPlanningId) {
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('id', planningCommandUuid)
        .single();
      
      if (commandCheckError || !commandExists) {
        console.log(`⚠️ El planning command_id ${planningCommandUuid} no existe en la tabla 'commands'`);
      }
    }
    
    console.log(`📝 Creando ${campaignsData.length} campañas a partir de los resultados del Growth Marketer`);
    
    // Crear las campañas en la base de datos
    const createdCampaigns: any[] = [];
    
    for (const campaign of campaignsData) {
      // Preparar los datos básicos de la campaña
      const campaignToInsert = {
        title: campaign.title || 'Campaña sin título',
        description: campaign.description || '',
        status: 'pending',
        type: campaign.type || 'general',
        priority: campaign.priority || 'medium',
        budget: campaign.budget || { 
          currency: "USD", 
          allocated: 4000, 
          remaining: 3600 
        },
        revenue: campaign.revenue || { 
          actual: 0, 
          currency: "USD", 
          estimated: 12000, 
          projected: 15000 
        },
        due_date: campaign.due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        site_id: siteId,
        user_id: userId,
        // Usar planning command para las campañas
        ...(validPlanningId ? { command_id: planningCommandUuid } : {})
      };
      
      // Insertar la campaña
      const { data: insertedCampaign, error: insertError } = await supabaseAdmin
        .from('campaigns')
        .insert([campaignToInsert])
        .select('*')
        .single();
      
      if (insertError) {
        console.error('Error al crear campaña:', insertError);
        continue;
      }
      
      console.log(`✅ Campaña creada con ID: ${insertedCampaign.id}`);
      createdCampaigns.push(insertedCampaign);
    }
    
    return createdCampaigns;
  } catch (error) {
    console.error('Error al crear campañas a partir de resultados del Growth Marketer:', error);
    return [];
  }
}

// Función para crear requisitos desde los resultados del Task Manager
export async function createRequirementsFromResults(
  campaignsWithRequirements: any[], 
  siteId: string, 
  userId: string, 
  requirementsCommandUuid: string | null
): Promise<{createdRequirements: any[], updatedCampaigns: any[]}> {
  console.log(`🔄 Procesando resultados de Task Manager para crear requisitos...`);
  
  try {
    if (!campaignsWithRequirements || !Array.isArray(campaignsWithRequirements) || campaignsWithRequirements.length === 0) {
      console.log('Los resultados del Task Manager no tienen campañas con requisitos válidas');
      return { createdRequirements: [], updatedCampaigns: [] };
    }
    
    // El command_id para inserción en base de datos
    console.log(`🔑 Requirements Command UUID: ${requirementsCommandUuid}`);
    
    // Verificar que el command_id existe en la tabla commands si es UUID válido
    const validRequirementsId = requirementsCommandUuid && isValidUUID(requirementsCommandUuid);
    
    if (validRequirementsId) {
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('id', requirementsCommandUuid)
        .single();
      
      if (commandCheckError || !commandExists) {
        console.log(`⚠️ El requirements command_id ${requirementsCommandUuid} no existe en la tabla 'commands'`);
      }
    }
    
    console.log(`📝 Creando requisitos para ${campaignsWithRequirements.length} campañas`);
    
    const createdRequirements: any[] = [];
    const updatedCampaigns: any[] = [];
    
    for (const campaignWithReqs of campaignsWithRequirements) {
      const campaignId = campaignWithReqs.campaign_id;
      
      if (!campaignId || !isValidUUID(campaignId)) {
        console.log(`⚠️ Campaign ID inválido: ${campaignId}`);
        continue;
      }
      
      // Verificar que la campaña existe
      const { data: existingCampaign, error: campaignError } = await supabaseAdmin
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .single();
      
      if (campaignError || !existingCampaign) {
        console.log(`⚠️ Campaña no encontrada: ${campaignId}`);
        continue;
      }
      
      console.log(`📋 Procesando requisitos para campaña: ${existingCampaign.title}`);
      
      // Si la campaña tiene requisitos, guardarlos
      if (campaignWithReqs.requirements && Array.isArray(campaignWithReqs.requirements) && campaignWithReqs.requirements.length > 0) {
        console.log(`📝 Guardando ${campaignWithReqs.requirements.length} requisitos para la campaña ${campaignId}`);
        
        const requirementIds: string[] = [];
        
        for (const reqData of campaignWithReqs.requirements) {
          // Función para extraer valor numérico del budget
          const extractNumericBudget = (budgetValue: any): number => {
            if (typeof budgetValue === 'number') return budgetValue;
            if (!budgetValue) return 0;
            
            // Si es string, extraer números del string (ej: "USD 40" -> 40)
            const budgetStr = budgetValue.toString();
            const match = budgetStr.match(/[\d.]+/);
            return match ? parseFloat(match[0]) : 0;
          };

          // Crear cada requisito
          const requirementToInsert = {
            title: reqData.title || 'Requisito sin título',
            description: reqData.description || '',
            instructions: reqData.instructions || '',
            budget: extractNumericBudget(reqData.budget),
            priority: reqData.priority || 'medium',
            site_id: siteId,
            status: 'backlog',
            completion_status: 'pending',
            user_id: userId,
            // Usar requirements command para los requisitos
            ...(validRequirementsId ? { command_id: requirementsCommandUuid } : {})
          };
          
          // Insertar el requisito
          const { data: insertedRequirement, error: reqInsertError } = await supabaseAdmin
            .from('requirements')
            .insert([requirementToInsert])
            .select('*')
            .single();
          
          if (reqInsertError) {
            console.error('Error al crear requisito:', reqInsertError);
            continue;
          }
          
          console.log(`✅ Requisito creado con ID: ${insertedRequirement.id}`);
          createdRequirements.push(insertedRequirement);
          
          // Guardar el ID para la relación
          requirementIds.push(insertedRequirement.id);
          
          // Crear la relación entre campaña y requisito
          await supabaseAdmin
            .from('campaign_requirements')
            .insert({
              campaign_id: campaignId,
              requirement_id: insertedRequirement.id
            });
        }
        
        // Actualizar el estado de la campaña a 'pending' ya que tiene requisitos
        const { data: updatedCampaign, error: updateError } = await supabaseAdmin
          .from('campaigns')
          .update({ status: 'pending' })
          .eq('id', campaignId)
          .select('*')
          .single();
          
        if (!updateError && updatedCampaign) {
          console.log(`✅ Campaña ${campaignId} actualizada a estado 'pending'`);
          updatedCampaigns.push({
            ...updatedCampaign,
            requirement_ids: requirementIds
          });
        } else {
          console.error('Error al actualizar estado de campaña:', updateError);
          updatedCampaigns.push({
            ...existingCampaign,
            requirement_ids: requirementIds
          });
        }
      } else {
        console.log(`⚠️ No se encontraron requisitos para la campaña ${campaignId}`);
        updatedCampaigns.push({
          ...existingCampaign,
          requirement_ids: []
        });
      }
    }
    
    return { createdRequirements, updatedCampaigns };
  } catch (error) {
    console.error('Error al crear requisitos a partir de resultados del Task Manager:', error);
    return { createdRequirements: [], updatedCampaigns: [] };
  }
} 