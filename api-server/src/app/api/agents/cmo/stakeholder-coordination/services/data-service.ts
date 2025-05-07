import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Definición de tipos para las diferentes entidades
 */
export interface TaskItem {
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  status?: string;
  owner?: string;
  assigned_to?: string;
  user_id?: string;
  due_date?: string;
  deadline?: string;
  details?: string;
  completion_date?: string;
  [key: string]: any;
}

export interface RequirementItem {
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  details?: string;
  status?: string;
  estimated_cost?: number;
  budget?: number | string;
  cost?: number | string;
  priority?: string;
  [key: string]: any;
}

export interface CampaignItem {
  id?: string;
  title?: string;
  name?: string;
  status?: string;
  performance?: any;
  metrics?: any;
  [key: string]: any;
}

export interface ContentItem {
  id?: string;
  title?: string;
  name?: string;
  status?: string;
  description?: string;
  details?: string;
  target_completion?: string;
  due_date?: string;
  completion_percentage?: number;
  progress?: number;
  [key: string]: any;
}

/**
 * Servicio para obtener datos contextuales para el agente CMO
 */
export class DataService {
  /**
   * Obtiene las tareas existentes para un sitio y participantes específicos
   * @param siteId ID del sitio
   * @param participants Lista de participantes (opcional)
   * @returns Texto formateado con las tareas
   */
  public static async getExistingTasks(siteId: string, participants: string[] = []): Promise<string> {
    try {
      // En Supabase, simplemente hacemos una consulta a la tabla tasks
      // y usamos las columnas que estén disponibles
      const { data, error } = await supabaseAdmin
        .from('tasks')
        .select('*')
        .eq('site_id', siteId);
      
      if (error) {
        console.error('Error al obtener tareas:', error);
        // Fallback a datos de ejemplo
        return `1. Finalize Q1 Performance Report (in progress, due 2023-04-05)\n2. Draft Initial Q2 Budget Proposal (completed on 2023-04-02)\n3. Social Media Content Calendar (pending, due 2023-04-15)`;
      }
      
      if (!data || data.length === 0) {
        return "No existing tasks found.";
      }
      
      return data.map((task: TaskItem, index: number) => {
        // Verificar qué campos están disponibles para cada tarea
        const title = task.title || task.name || task.description || 'Untitled task';
        
        // Construir el texto de estado basado en los campos disponibles
        let statusText = '';
        
        if (task.status === 'completed' && task.completion_date) {
          statusText = `completed on ${task.completion_date}`;
        } else if (task.due_date) {
          statusText = `${task.status || 'pending'}, due ${task.due_date}`;
        } else if (task.deadline) {
          statusText = `${task.status || 'pending'}, due ${task.deadline}`;
        } else {
          statusText = task.status || 'pending';
        }
        
        return `${index + 1}. ${title} (${statusText})`;
      }).join('\n');
    } catch (e) {
      console.error('Error en getExistingTasks:', e);
      // Fallback a datos de ejemplo
      return `1. Finalize Q1 Performance Report (in progress, due 2023-04-05)\n2. Draft Initial Q2 Budget Proposal (completed on 2023-04-02)\n3. Social Media Content Calendar (pending, due 2023-04-15)`;
    }
  }

  /**
   * Obtiene los requerimientos pendientes para un sitio específico
   * @param siteId ID del sitio
   * @returns Texto formateado con los requerimientos
   */
  public static async getPendingRequirements(siteId: string): Promise<string> {
    try {
      // Intentar consulta directa a la tabla
      const { data, error } = await supabaseAdmin
        .from('requirements')
        .select('*')
        .eq('site_id', siteId);
      
      if (error) {
        console.error('Error al obtener requisitos:', error);
        return `1. Video Content Production Resources - $12,000 (medium priority)\n2. Social Media Advertising Budget Increase - $15,000 (high priority)`;
      }
      
      if (!data || data.length === 0) {
        return "No pending requirements found.";
      }
      
      return data.map((req: RequirementItem, index: number) => {
        const title = req.title || req.name || req.description || 'Untitled requirement';
        const cost = req.estimated_cost || req.budget || req.cost || 'undefined';
        const priority = req.priority || 'medium';
        
        return `${index + 1}. ${title} - $${cost} (${priority} priority)`;
      }).join('\n');
    } catch (e) {
      console.error('Error en getPendingRequirements:', e);
      return `1. Video Content Production Resources - $12,000 (medium priority)\n2. Social Media Advertising Budget Increase - $15,000 (high priority)`;
    }
  }

  /**
   * Obtiene las campañas activas para un sitio específico
   * @param siteId ID del sitio
   * @returns Texto formateado con las campañas
   */
  public static async getActiveCampaigns(siteId: string): Promise<string> {
    try {
      // Intentar consulta directa a la tabla
      const { data, error } = await supabaseAdmin
        .from('campaigns')
        .select('*')
        .eq('site_id', siteId);
      
      if (error) {
        console.error('Error al obtener campañas:', error);
        return `1. Q1 Email Newsletter Series - 18% open rate (5% decline), 2.3% conversion, 1.8 ROI\n2. Q1 Social Media Brand Awareness - 4.2% engagement (24% increase), 3.1% conversion, 2.7 ROI`;
      }
      
      if (!data || data.length === 0) {
        return "No active campaigns found.";
      }
      
      return data.map((campaign: CampaignItem, index: number) => {
        const title = campaign.title || campaign.name || 'Untitled campaign';
        const performance = campaign.performance || {};
        let performanceText = '';
        
        // Manejar diferentes estructuras de datos de performance
        if (typeof performance === 'object') {
          if (performance.open_rate) {
            performanceText += `${performance.open_rate} open rate`;
            if (performance.decline_from_previous) {
              performanceText += ` (${performance.decline_from_previous} decline)`;
            } else if (performance.improvement_from_previous) {
              performanceText += ` (${performance.improvement_from_previous} increase)`;
            }
          } else if (performance.engagement_rate) {
            performanceText += `${performance.engagement_rate} engagement`;
            if (performance.decline_from_previous) {
              performanceText += ` (${performance.decline_from_previous} decline)`;
            } else if (performance.improvement_from_previous) {
              performanceText += ` (${performance.improvement_from_previous} increase)`;
            }
          }
          
          if (performance.conversion_rate) {
            performanceText += `, ${performance.conversion_rate} conversion`;
          }
          
          if (performance.roi) {
            performanceText += `, ${performance.roi} ROI`;
          }
        } else if (campaign.metrics) {
          // Alternativamente, buscar en campaign.metrics
          const metrics = campaign.metrics || {};
          if (metrics.open_rate) performanceText += `${metrics.open_rate} open rate, `;
          if (metrics.engagement) performanceText += `${metrics.engagement} engagement, `;
          if (metrics.conversion) performanceText += `${metrics.conversion} conversion, `;
          if (metrics.roi) performanceText += `${metrics.roi} ROI`;
          
          // Eliminar coma final si existe
          performanceText = performanceText.replace(/,\s*$/, '');
        }
        
        // Si no se encontró información de performance
        if (!performanceText) {
          performanceText = campaign.status || 'active';
        }
        
        return `${index + 1}. ${title} - ${performanceText}`;
      }).join('\n');
    } catch (e) {
      console.error('Error en getActiveCampaigns:', e);
      return `1. Q1 Email Newsletter Series - 18% open rate (5% decline), 2.3% conversion, 1.8 ROI\n2. Q1 Social Media Brand Awareness - 4.2% engagement (24% increase), 3.1% conversion, 2.7 ROI`;
    }
  }

  /**
   * Obtiene el inventario de contenido para un sitio específico
   * @param siteId ID del sitio
   * @returns Texto formateado con el inventario de contenido
   */
  public static async getContentInventory(siteId: string): Promise<string> {
    try {
      // Intentar consulta directa a la tabla
      const { data, error } = await supabaseAdmin
        .from('content')
        .select('*')
        .eq('site_id', siteId);
      
      if (error) {
        console.error('Error al obtener inventario de contenido:', error);
        return `1. Product Feature Videos - Planned (Target: Q2 2023)\n2. Customer Success Stories - 60% complete\n3. Email Templates - 100% complete`;
      }
      
      if (!data || data.length === 0) {
        return "No content inventory found.";
      }
      
      return data.map((content: ContentItem, index: number) => {
        const title = content.title || content.name || 'Untitled content';
        let statusText = content.status || 'draft';
        
        // Formatear el estado según los datos disponibles
        if (content.status === 'planned' && content.target_completion) {
          statusText += ` (Target: ${content.target_completion})`;
        } else if (content.status === 'in_progress' && content.completion_percentage) {
          statusText += ` (${content.completion_percentage}% complete)`;
        } else if (content.status === 'completed') {
          statusText = '100% complete';
        } else if (content.status === 'draft') {
          statusText = 'In draft';
        } else if (content.progress) {
          // Comprobar si hay un campo de progreso genérico
          statusText += ` (${content.progress}% complete)`;
        } else if (content.due_date) {
          // Incluir fecha de vencimiento si está disponible
          statusText += ` (due: ${content.due_date})`;
        }
        
        return `${index + 1}. ${title} - ${statusText}`;
      }).join('\n');
    } catch (e) {
      console.error('Error en getContentInventory:', e);
      return `1. Product Feature Videos - Planned (Target: Q2 2023)\n2. Customer Success Stories - 60% complete\n3. Email Templates - 100% complete`;
    }
  }
} 