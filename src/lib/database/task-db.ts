import { supabaseAdmin } from './supabase-server';
import { createClient } from '@supabase/supabase-js';

/**
 * Función utilitaria para remover valores null y arreglos vacíos de un objeto
 */
const removeNullValues = (obj: any): any => {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const filtered = obj.map(removeNullValues).filter(item => item !== undefined);
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = removeNullValues(value);
      if (cleanedValue !== null && cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  return obj;
};

/**
 * Interface para las tareas en la base de datos
 */
export interface DbTask {
  id: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  stage: string;
  priority: number;
  user_id: string;
  site_id: string;
  lead_id: string | null;
  scheduled_date: string | null;
  completed_date: string | null;
  amount: number | null;
  assignee: string | null;
  notes: string | null;
  command_id: string | null;
  serial_id: string | null;
  address: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Interface para las tareas en respuestas de API (sin campos internos)
 */
export interface ApiTask {
  id: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  stage: string;
  priority: number;
  scheduled_date: string | null;
  completed_date: string | null;
  amount: number | null;
  assignee: string | null;
  notes: string | null;
  serial_id: string | null;
  address: Record<string, any> | null;
  created_at: string;
  updated_at: string;
  task_comments?: {
    id: string;
    content: string;
    created_at: string;
    updated_at: string;
    is_private: boolean;
    attachments: Record<string, any> | null;
    files: Record<string, any> | null;
  }[];
}

/**
 * Interface para crear una nueva tarea
 */
export interface CreateTaskParams {
  title: string;
  description?: string;
  type: string;
  status?: string;
  stage?: string;
  priority?: number;
  user_id: string;
  site_id: string;
  lead_id?: string;
  scheduled_date?: string;
  amount?: number;
  assignee?: string;
  notes?: string;
  command_id?: string;
  address?: Record<string, any>;
}

/**
 * Interface para actualizar una tarea
 */
export interface UpdateTaskParams {
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  stage?: string;
  priority?: number;
  scheduled_date?: string;
  amount?: number;
  assignee?: string;
  notes?: string;
  address?: Record<string, any>;
  completed_date?: string;
}

/**
 * Interface para filtros de búsqueda de tareas
 */
export interface TaskFilters {
  user_id?: string;
  site_id?: string;
  lead_id?: string;
  visitor_id?: string;
  assignee?: string;
  command_id?: string;
  type?: string;
  status?: string;
  stage?: string;
  priority?: number;
  scheduled_date_from?: string;
  scheduled_date_to?: string;
  completed_date_from?: string;
  completed_date_to?: string;
  created_date_from?: string;
  created_date_to?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

/**
 * Crea una nueva tarea en la base de datos
 * 
 * @param taskData Datos de la tarea a crear
 * @returns La tarea creada
 */
export async function createTask(taskData: CreateTaskParams): Promise<DbTask> {
  try {
    const dataToInsert = {
      ...taskData,
      status: taskData.status || 'active',
      stage: taskData.stage || 'pending',
      priority: taskData.priority || 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from('tasks')
      .insert([dataToInsert])
      .select()
      .single();

    if (error) {
      console.error('Error creating task:', error);
      throw new Error(`Error creating task: ${error.message}`);
    }

    return removeNullValues(data) || data;
  } catch (error: any) {
    console.error('Error in createTask:', error);
    throw new Error(`Error creating task: ${error.message}`);
  }
}

/**
 * Obtiene una tarea por su ID
 * 
 * @param taskId ID de la tarea
 * @returns La tarea o null si no se encuentra
 */
export async function getTaskById(taskId: string): Promise<DbTask | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No se encontró la tarea
        return null;
      }
      console.error('Error getting task:', error);
      throw new Error(`Error getting task: ${error.message}`);
    }

    return data ? (removeNullValues(data) || data) : null;
  } catch (error: any) {
    console.error('Error in getTaskById:', error);
    throw new Error(`Error getting task: ${error.message}`);
  }
}

/**
 * Obtiene tareas con filtros y paginación
 * 
 * @param filters Filtros para aplicar
 * @returns Array de tareas y metadatos de paginación
 */
export async function getTasks(filters: TaskFilters = {}): Promise<{
  tasks: ApiTask[];
  total: number;
  hasMore: boolean;
}> {
  try {
    console.log('[getTasks] Iniciando consulta con filtros:', filters);
    
    // Crear cliente admin directamente con service role key
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    console.log('[getTasks] Cliente admin creado');
    
    // Primera consulta: obtener tareas sin comentarios
    let query = adminClient
      .from('tasks')
      .select(`
        id,
        title,
        description,
        type,
        status,
        stage,
        priority,
        scheduled_date,
        completed_date,
        amount,
        assignee,
        notes,
        serial_id,
        address,
        created_at,
        updated_at
      `, { count: 'exact' });

    console.log('[getTasks] Query inicial creada');

    // Aplicar filtros
    if (filters.user_id) {
      console.log('[getTasks] Aplicando filtro user_id:', filters.user_id);
      query = query.eq('user_id', filters.user_id);
    }
    if (filters.site_id) {
      console.log('[getTasks] Aplicando filtro site_id:', filters.site_id);
      query = query.eq('site_id', filters.site_id);
    }
    if (filters.lead_id) {
      console.log('[getTasks] Aplicando filtro lead_id:', filters.lead_id);
      query = query.eq('lead_id', filters.lead_id);
    }
    
    // Filtro por visitor_id - necesita join con la tabla leads
    if (filters.visitor_id) {
      console.log('[getTasks] Aplicando filtro visitor_id:', filters.visitor_id);
      // Primero obtenemos los IDs de leads que pertenecen al visitor
      const { data: leadIds, error: leadError } = await adminClient
        .from('leads')
        .select('id')
        .eq('visitor_id', filters.visitor_id);
      
      if (leadError) {
        console.error('Error getting leads for visitor:', leadError);
        throw new Error(`Error getting leads for visitor: ${leadError.message}`);
      }
      
      if (leadIds && leadIds.length > 0) {
        const leadIdArray = leadIds.map(lead => lead.id);
        query = query.in('lead_id', leadIdArray);
        console.log('[getTasks] Lead IDs encontrados para visitor:', leadIdArray);
      } else {
        console.log('[getTasks] No se encontraron leads para visitor:', filters.visitor_id);
        // Si no hay leads para este visitor, no hay tareas que coincidan
        return {
          tasks: [],
          total: 0,
          hasMore: false
        };
      }
    }
    
    if (filters.assignee) {
      console.log('[getTasks] Aplicando filtro assignee:', filters.assignee);
      query = query.eq('assignee', filters.assignee);
    }
    if (filters.command_id) {
      console.log('[getTasks] Aplicando filtro command_id:', filters.command_id);
      query = query.eq('command_id', filters.command_id);
    }
    if (filters.type) {
      console.log('[getTasks] Aplicando filtro type:', filters.type);
      query = query.eq('type', filters.type);
    }
    if (filters.status) {
      console.log('[getTasks] Aplicando filtro status:', filters.status);
      query = query.eq('status', filters.status);
    }
    if (filters.stage) {
      console.log('[getTasks] Aplicando filtro stage:', filters.stage);
      query = query.eq('stage', filters.stage);
    }
    if (filters.priority !== undefined) {
      console.log('[getTasks] Aplicando filtro priority:', filters.priority);
      query = query.eq('priority', filters.priority);
    }

    // Filtros de fecha
    if (filters.scheduled_date_from) {
      query = query.gte('scheduled_date', filters.scheduled_date_from);
    }
    if (filters.scheduled_date_to) {
      query = query.lte('scheduled_date', filters.scheduled_date_to);
    }
    if (filters.completed_date_from) {
      query = query.gte('completed_date', filters.completed_date_from);
    }
    if (filters.completed_date_to) {
      query = query.lte('completed_date', filters.completed_date_to);
    }
    if (filters.created_date_from) {
      query = query.gte('created_at', filters.created_date_from);
    }
    if (filters.created_date_to) {
      query = query.lte('created_at', filters.created_date_to);
    }

    // Búsqueda de texto
    if (filters.search) {
      query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    // Ordenamiento
    const sortBy = filters.sort_by || 'created_at';
    const sortOrder = filters.sort_order || 'desc';
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });

    // Paginación
    const limit = Math.min(filters.limit || 50, 500); // Máximo 500
    const offset = filters.offset || 0;
    
    query = query.range(offset, offset + limit - 1);

    console.log('[getTasks] Ejecutando consulta...');
    const { data, error, count } = await query;

    if (error) {
      console.error('Error getting tasks:', error);
      throw new Error(`Error getting tasks: ${error.message}`);
    }

    console.log('[getTasks] Consulta exitosa, count:', count, 'data length:', data?.length);

    // Segunda consulta: obtener comentarios públicos para las tareas encontradas
    let tasksWithComments = data || [];
    
    if (data && data.length > 0) {
      const taskIds = data.map(task => task.id);
      
      const { data: comments, error: commentsError } = await adminClient
        .from('task_comments')
        .select(`
          id,
          content,
          created_at,
          updated_at,
          attachments,
          files,
          task_id
        `)
        .in('task_id', taskIds)
        .eq('is_private', false);

      if (commentsError) {
        console.error('Error getting comments:', commentsError);
        // No lanzar error, simplemente continuar sin comentarios
      } else {
        // Combinar tareas con sus comentarios
        tasksWithComments = data.map(task => ({
          ...task,
          task_comments: (comments || []).filter(comment => comment.task_id === task.id)
            .map(({ task_id, ...comment }) => comment) // Remover task_id de los comentarios
        }));
      }
    }

    const total = count || 0;
    const hasMore = (offset + limit) < total;

    // Limpiar valores null de las tareas
    const cleanedTasks = tasksWithComments
      .map(task => removeNullValues(task))
      .filter(task => task !== undefined);

    console.log('[getTasks] Retornando', cleanedTasks.length, 'tareas');

    return {
      tasks: cleanedTasks || [],
      total,
      hasMore
    };
  } catch (error: any) {
    console.error('Error in getTasks:', error);
    throw new Error(`Error getting tasks: ${error.message}`);
  }
}

/**
 * Actualiza una tarea
 * 
 * @param taskId ID de la tarea
 * @param updateData Datos a actualizar
 * @returns La tarea actualizada
 */
export async function updateTask(taskId: string, updateData: UpdateTaskParams): Promise<DbTask> {
  try {
    const dataToUpdate = {
      ...updateData,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from('tasks')
      .update(dataToUpdate)
      .eq('id', taskId)
      .select()
      .single();

    if (error) {
      console.error('Error updating task:', error);
      throw new Error(`Error updating task: ${error.message}`);
    }

    return removeNullValues(data) || data;
  } catch (error: any) {
    console.error('Error in updateTask:', error);
    throw new Error(`Error updating task: ${error.message}`);
  }
}

/**
 * Elimina una tarea
 * 
 * @param taskId ID de la tarea
 * @returns true si se eliminó correctamente
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('tasks')
      .delete()
      .eq('id', taskId);

    if (error) {
      console.error('Error deleting task:', error);
      throw new Error(`Error deleting task: ${error.message}`);
    }

    return true;
  } catch (error: any) {
    console.error('Error in deleteTask:', error);
    throw new Error(`Error deleting task: ${error.message}`);
  }
}

/**
 * Obtiene tareas por lead ID
 * 
 * @param leadId ID del lead
 * @param filters Filtros adicionales opcionales
 * @returns Array de tareas
 */
export async function getTasksByLeadId(leadId: string, filters: Omit<TaskFilters, 'lead_id'> = {}): Promise<ApiTask[]> {
  try {
    const result = await getTasks({ ...filters, lead_id: leadId });
    return result.tasks;
  } catch (error: any) {
    console.error('Error in getTasksByLeadId:', error);
    throw new Error(`Error getting tasks by lead ID: ${error.message}`);
  }
}

/**
 * Obtiene tareas por sitio ID
 * 
 * @param siteId ID del sitio
 * @param filters Filtros adicionales opcionales
 * @returns Array de tareas
 */
export async function getTasksBySiteId(siteId: string, filters: Omit<TaskFilters, 'site_id'> = {}): Promise<ApiTask[]> {
  try {
    const result = await getTasks({ ...filters, site_id: siteId });
    return result.tasks;
  } catch (error: any) {
    console.error('Error in getTasksBySiteId:', error);
    throw new Error(`Error getting tasks by site ID: ${error.message}`);
  }
}

/**
 * Marca una tarea como completada
 * 
 * @param taskId ID de la tarea
 * @returns La tarea actualizada
 */
export async function completeTask(taskId: string): Promise<DbTask> {
  try {
    const result = await updateTask(taskId, {
      stage: 'completed',
      completed_date: new Date().toISOString()
    });
    return result;
  } catch (error: any) {
    console.error('Error in completeTask:', error);
    throw new Error(`Error completing task: ${error.message}`);
  }
}

/**
 * Obtiene estadísticas de tareas para un usuario o sitio
 * 
 * @param filters Filtros para las estadísticas
 * @returns Objeto con estadísticas
 */
export async function getTaskStats(filters: Partial<TaskFilters> = {}): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byStage: Record<string, number>;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
}> {
  try {
    console.log('[getTaskStats] Iniciando consulta con filtros:', filters);
    
    // Crear cliente admin directamente con service role key
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    let query = adminClient.from('tasks').select('status, stage, priority, type, scheduled_date');

    // Aplicar los mismos filtros que en getTasks
    if (filters.user_id) {
      console.log('[getTaskStats] Aplicando filtro user_id:', filters.user_id);
      query = query.eq('user_id', filters.user_id);
    }
    if (filters.site_id) {
      console.log('[getTaskStats] Aplicando filtro site_id:', filters.site_id);
      query = query.eq('site_id', filters.site_id);
    }
    if (filters.lead_id) {
      console.log('[getTaskStats] Aplicando filtro lead_id:', filters.lead_id);
      query = query.eq('lead_id', filters.lead_id);
    }
    if (filters.assignee) {
      query = query.eq('assignee', filters.assignee);
    }
    if (filters.command_id) {
      query = query.eq('command_id', filters.command_id);
    }
    if (filters.type) {
      query = query.eq('type', filters.type);
    }
    if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.stage) {
      query = query.eq('stage', filters.stage);
    }
    if (filters.priority !== undefined) {
      query = query.eq('priority', filters.priority);
    }

    console.log('[getTaskStats] Ejecutando consulta...');
    const { data, error } = await query;

    if (error) {
      console.error('Error getting task stats:', error);
      throw new Error(`Error getting task stats: ${error.message}`);
    }

    console.log('[getTaskStats] Consulta exitosa, data length:', data?.length);

    const stats = {
      total: data?.length || 0,
      byStatus: {} as Record<string, number>,
      byStage: {} as Record<string, number>,
      byPriority: {} as Record<string, number>,
      byType: {} as Record<string, number>,
      overdue: 0,
      dueToday: 0,
      dueThisWeek: 0
    };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekFromNow = new Date(today);
    weekFromNow.setDate(weekFromNow.getDate() + 7);

    data?.forEach(task => {
      // Contar por status
      stats.byStatus[task.status] = (stats.byStatus[task.status] || 0) + 1;
      
      // Contar por stage
      stats.byStage[task.stage] = (stats.byStage[task.stage] || 0) + 1;
      
      // Contar por priority (ahora es número)
      const priorityKey = task.priority?.toString() || 'undefined';
      stats.byPriority[priorityKey] = (stats.byPriority[priorityKey] || 0) + 1;
      
      // Contar por type
      stats.byType[task.type] = (stats.byType[task.type] || 0) + 1;

      // Contar vencimientos usando scheduled_date en lugar de due_date
      if (task.scheduled_date) {
        const scheduledDate = new Date(task.scheduled_date);
        
        if (scheduledDate < now && task.stage !== 'completed') {
          stats.overdue++;
        } else if (scheduledDate >= today && scheduledDate < new Date(today.getTime() + 24 * 60 * 60 * 1000)) {
          stats.dueToday++;
        } else if (scheduledDate >= today && scheduledDate < weekFromNow) {
          stats.dueThisWeek++;
        }
      }
    });

    console.log('[getTaskStats] Stats calculados:', stats);
    
    // Limpiar valores null de las estadísticas
    const cleanedStats = {
      total: stats.total,
      byStatus: stats.byStatus,
      byStage: stats.byStage,
      byPriority: stats.byPriority,
      byType: stats.byType,
      overdue: stats.overdue,
      dueToday: stats.dueToday,
      dueThisWeek: stats.dueThisWeek
    };
    
    return cleanedStats;
  } catch (error: any) {
    console.error('Error in getTaskStats:', error);
    throw new Error(`Error getting task stats: ${error.message}`);
  }
}

/**
 * Función de debug para verificar datos en la tabla tasks
 */
export async function debugTasks(leadId?: string): Promise<any> {
  try {
    console.log('[debugTasks] Iniciando debug de tabla tasks');
    
    // Primera consulta: contar todas las tareas
    const { count: totalCount, error: countError } = await supabaseAdmin
      .from('tasks')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('[debugTasks] Error contando todas las tareas:', countError);
    } else {
      console.log('[debugTasks] Total de tareas en la tabla:', totalCount);
    }
    
    // Segunda consulta: obtener las primeras 5 tareas sin filtros
    const { data: allTasks, error: allError } = await supabaseAdmin
      .from('tasks')
      .select('id, title, lead_id, status, stage')
      .limit(5);
    
    if (allError) {
      console.error('[debugTasks] Error obteniendo tareas:', allError);
    } else {
      console.log('[debugTasks] Primeras 5 tareas:', allTasks);
    }
    
    // Tercera consulta: buscar tareas específicamente por lead_id si se proporciona
    if (leadId) {
      const { data: leadTasks, error: leadError, count: leadCount } = await supabaseAdmin
        .from('tasks')
        .select('id, title, lead_id, status, stage', { count: 'exact' })
        .eq('lead_id', leadId);
      
      if (leadError) {
        console.error('[debugTasks] Error obteniendo tareas del lead:', leadError);
      } else {
        console.log('[debugTasks] Tareas del lead', leadId, ':', leadTasks);
        console.log('[debugTasks] Count tareas del lead:', leadCount);
      }
    }
    
    // Cuarta consulta: verificar estructura de la tabla
    const { data: tableInfo, error: infoError } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .limit(1);
    
    if (infoError) {
      console.error('[debugTasks] Error obteniendo info de estructura:', infoError);
    } else if (tableInfo && tableInfo.length > 0) {
      console.log('[debugTasks] Estructura de columnas:', Object.keys(tableInfo[0]));
    }
    
    return {
      totalCount,
      sampleTasks: allTasks,
      leadId,
      success: true
    };
  } catch (error: any) {
    console.error('[debugTasks] Error en debug:', error);
    return {
      error: error.message,
      success: false
    };
  }
} 