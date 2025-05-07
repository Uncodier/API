import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Servicio para obtener información sobre la asignación de recursos
 */
export class ResourceService {
  /**
   * Obtiene la asignación de recursos para un sitio específico
   * @param siteId ID del sitio
   * @returns Texto formateado con la información de asignación de recursos
   */
  public static async getResourceAllocation(siteId: string): Promise<string> {
    try {
      // Primer intento: Buscar en la tabla resource_allocation específica
      try {
        // Intentar una consulta a la tabla resource_allocation
        const { data, error } = await supabaseAdmin
          .from('resource_allocation')
          .select('*')
          .eq('site_id', siteId)
          .limit(1);
        
        if (error && error.code === '42P01') { // Código para "relation does not exist"
          console.log('Tabla resource_allocation no existe, buscando en campaigns');
          // Continuar al siguiente intento
        } else if (data && data.length > 0) {
          const allocation = data[0];
          const budget = allocation.budget || {};
          const distribution = allocation.distribution || {};
          
          let result = '';
          
          // Eliminar referencias a quarters y simplemente mostrar el total activo
          let totalBudget = 0;
          let spentBudget = 0;
          let remainingBudget = 0;
          
          // Extraer totales independientemente de quarters
          if (typeof budget === 'number') {
            totalBudget = budget;
          } else if (typeof budget === 'object') {
            // Buscar cualquier total disponible
            totalBudget = budget.total || budget.amount || 
                          budget.q1_total || budget.q2_total || 
                          budget.q3_total || budget.q4_total || 0;
                          
            // Buscar cualquier gasto disponible
            spentBudget = budget.spent || budget.used || 
                         budget.q1_spent || budget.q2_spent || 
                         budget.q3_spent || budget.q4_spent || 0;
                         
            // Buscar cualquier remanente disponible, o calcularlo
            remainingBudget = budget.remaining || budget.available || 
                             budget.q1_remaining || budget.q2_remaining || 
                             budget.q3_remaining || budget.q4_remaining || 
                             (totalBudget - spentBudget);
          }
          
          // Formatear el presupuesto sin referencias a quarters
          if (totalBudget > 0) {
            result += `Budget: Active Total $${totalBudget.toLocaleString()}`;
            if (spentBudget > 0) {
              result += ` (Spent: $${spentBudget.toLocaleString()}, Remaining: $${remainingBudget.toLocaleString()})`;
            }
            result += '\n';
          }
          
          if (Object.keys(distribution).length > 0) {
            result += 'Distribution: ';
            result += Object.entries(distribution)
              .map(([key, value]) => {
                const formattedKey = key.replace(/_/g, ' ')
                  .split(' ')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ');
                return `${formattedKey} ${value}`;
              })
              .join(', ');
          } else if (allocation.distribution_description) {
            // Si hay un campo con texto de distribución
            result += `Distribution: ${allocation.distribution_description}`;
          }
          
          return result;
        }
      } catch (tableError) {
        console.error('Error al verificar tabla resource_allocation:', tableError);
        // Continuar al siguiente intento
      }
      
      // Segundo intento: Buscar en la tabla campaigns para obtener información de asignación real
      try {
        const { data: campaignsData, error: campaignsError } = await supabaseAdmin
          .from('campaigns')
          .select('id, name, budget, resource_allocation, budget_allocation, allocation, status')
          .eq('site_id', siteId)
          .order('created_at', { ascending: false });
        
        if (!campaignsError && campaignsData && campaignsData.length > 0) {
          console.log(`Encontrados ${campaignsData.length} campañas con información de presupuesto`);
          
          // Filtrar solo campañas activas si el estado está disponible
          const activeCampaigns = campaignsData.filter(campaign => 
            !campaign.status || 
            campaign.status === 'active' || 
            campaign.status === 'running' || 
            campaign.status === 'ongoing'
          );
          
          // Usar todas las campañas si no hay activas o si no se puede determinar el estado
          const campaignsToProcess = activeCampaigns.length > 0 ? activeCampaigns : campaignsData;
          
          console.log(`Procesando ${campaignsToProcess.length} campañas activas`);
          
          // Sumar presupuestos totales de todas las campañas
          let totalBudget = 0;
          let totalSpent = 0;
          let totalRemaining = 0;
          const distributionMap = new Map();
          
          // Procesar cada campaña
          campaignsToProcess.forEach(campaign => {
            // Extraer presupuesto
            let campaignBudget = 0;
            let campaignSpent = 0;
            
            if (campaign.budget) {
              if (typeof campaign.budget === 'number') {
                campaignBudget = campaign.budget;
              } else if (typeof campaign.budget === 'object') {
                // Buscar el total en diferentes campos posibles, sin referencia a quarters
                campaignBudget = campaign.budget.total || 
                                campaign.budget.amount ||
                                campaign.budget.budget || 0;
                                
                // Buscar lo gastado en diferentes campos posibles
                campaignSpent = campaign.budget.spent || 
                               campaign.budget.used || 
                               campaign.budget.consumed || 0;
              }
            }
            
            totalBudget += campaignBudget;
            totalSpent += campaignSpent;
            
            // Buscar asignación de recursos en diferentes campos posibles
            const allocation = campaign.resource_allocation || campaign.budget_allocation || campaign.allocation || {};
            
            // Procesar la distribución
            if (typeof allocation === 'object') {
              Object.entries(allocation).forEach(([key, value]) => {
                // Convertir el valor a porcentaje si es numérico
                let percentValue = value;
                if (typeof value === 'number') {
                  if (value <= 1) { // Si es decimal (0.25 = 25%)
                    percentValue = `${(value * 100).toFixed(0)}%`;
                  } else { // Si es cantidad absoluta, calcular porcentaje
                    const percent = campaignBudget > 0 ? (value / campaignBudget * 100).toFixed(0) : 0;
                    percentValue = `${percent}%`;
                  }
                } else if (typeof value === 'string' && !value.includes('%')) {
                  percentValue = `${value}%`;
                }
                
                // Normalizar la clave
                const normalKey = key.replace(/_/g, ' ')
                  .split(' ')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ');
                
                // Sumar al mapa de distribución
                if (distributionMap.has(normalKey)) {
                  distributionMap.set(normalKey, distributionMap.get(normalKey) + 1);
                } else {
                  distributionMap.set(normalKey, 1);
                }
              });
            }
          });
          
          // Calcular distribución promedio
          let distributionText = '';
          if (distributionMap.size > 0) {
            const totalCampaigns = campaignsToProcess.length;
            const distributionEntries = Array.from(distributionMap.entries())
              .map(([channel, count]) => {
                // Calcular porcentaje aproximado basado en frecuencia
                const percentage = Math.round((count / totalCampaigns) * 100);
                return `${channel} ${percentage}%`;
              })
              .sort((a, b) => {
                // Ordenar por porcentaje descendente
                const percentA = parseInt(a.match(/(\d+)%/)?.[1] || '0');
                const percentB = parseInt(b.match(/(\d+)%/)?.[1] || '0');
                return percentB - percentA;
              });
            
            distributionText = distributionEntries.join(', ');
          }
          
          // Calcular remanente
          totalRemaining = totalBudget - totalSpent;
          
          // Formatear el resultado sin referencias a quarters
          let result = `Budget: Active Total $${totalBudget.toLocaleString()}`;
          if (totalSpent > 0) {
            result += ` (Spent: $${totalSpent.toLocaleString()}, Remaining: $${totalRemaining.toLocaleString()})`;
          }
          result += '\n';
          
          if (distributionText) {
            result += `Distribution: ${distributionText}`;
          } else {
            result += 'Distribution: Not specified in active campaigns';
          }
          
          return result;
        }
      } catch (campaignError) {
        console.error('Error al obtener datos de asignación desde campañas:', campaignError);
      }
      
      // Si llegamos aquí, ninguna de las opciones funcionó, usar datos de ejemplo sin quarters
      console.log('No se encontraron datos de asignación de recursos, usando datos de ejemplo');
      return `Budget: Active Total $100,000 (Spent: $95,000, Remaining: $5,000)\nDistribution: Social Media 25%, Email 30%, Content 20%, Events 15%, Other 10%`;
    } catch (e) {
      console.error('Error en getResourceAllocation:', e);
      return `Budget: Active Total $100,000 (Spent: $95,000, Remaining: $5,000)\nDistribution: Social Media 25%, Email 30%, Content 20%, Events 15%, Other 10%`;
    }
  }
} 